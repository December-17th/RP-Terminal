import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrateAgentPacksToVersioned } from '../src/main/services/db'

// WP4.6 version-coexistence migration test. The native better-sqlite3 binary is built for Electron's
// ABI and cannot instantiate under plain Node (the repo's stub returns empty rows) — so the store's
// SQL wrappers are runtime-validated only elsewhere. But the MIGRATION is the one piece where "old
// data survives" MUST be proven against a real SQL engine, not a stub. Node 22's built-in `node:sqlite`
// (DatabaseSync) is a real SQLite with a better-sqlite3-shaped `prepare().all()/get()/run()` + `exec()`
// surface; we adapt it with the one method the migration needs (`transaction(fn)`) and drive the exact
// getDb() sequence against a SEEDED legacy DB. No new dependency (node:sqlite ships with Node).

/** A thin better-sqlite3-shaped adapter over node:sqlite's DatabaseSync — just enough for the
 *  migration + backfill under test (prepare/exec + a transaction wrapper). */
const adapt = (db: DatabaseSync): any => ({
  prepare: (sql: string) => db.prepare(sql),
  exec: (sql: string) => db.exec(sql),
  transaction:
    (fn: (...a: unknown[]) => unknown) =>
    (...a: unknown[]) => {
      db.exec('BEGIN')
      try {
        const r = fn(...a)
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
})

/** Seed a DB in the LEGACY (pre-WP4.6) shape: agent_packs PK = id only (one version per id), and
 *  agent_pack_activation with NO pin_version column. */
const seedLegacy = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY);
    INSERT INTO profiles (id) VALUES ('prof');
    CREATE TABLE agent_packs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      upstream_id TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      manifest TEXT NOT NULL,
      fragment TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE agent_pack_activation (
      pack_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      chat_id TEXT,
      gate_open INTEGER NOT NULL DEFAULT 0,
      denial TEXT,
      PRIMARY KEY (pack_id, world_id, chat_id)
    );
  `)
  const insPack = db.prepare(
    'INSERT INTO agent_packs (id, profile_id, version, upstream_id, builtin, manifest, fragment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  insPack.run('mem', 'prof', 3, null, 1, '{"name":"Memory"}', '{"kind":"fragment"}', 't0')
  insPack.run('plot', 'prof', 1, 'mem', 0, '{"name":"Plot"}', '{"kind":"fragment"}', 't1')
  const insAct = db.prepare(
    'INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial) VALUES (?, ?, ?, ?, ?)'
  )
  insAct.run('mem', 'w1', null, 1, null)
  insAct.run('mem', 'w1', 'c1', 0, null)
  insAct.run('plot', 'w2', null, 1, null)
}

/** Replicate getDb()'s post-migration steps that touch these tables: add pin_version + backfill it
 *  from the just-migrated agent_packs (a legacy DB has one version per id — the unambiguous pin). */
const addPinAndBackfill = (db: DatabaseSync): void => {
  const cols = db.prepare(`PRAGMA table_info(agent_pack_activation)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'pin_version'))
    db.exec('ALTER TABLE agent_pack_activation ADD COLUMN pin_version INTEGER')
  db.exec(`
    UPDATE agent_pack_activation
       SET pin_version = (SELECT version FROM agent_packs WHERE agent_packs.id = agent_pack_activation.pack_id)
     WHERE pin_version IS NULL
       AND EXISTS (SELECT 1 FROM agent_packs WHERE agent_packs.id = agent_pack_activation.pack_id)
  `)
}

const pkColumns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)

describe('WP4.6 migration: legacy agent_packs → (profile_id, id, version)', () => {
  it('rebuilds the PK to (profile_id, id, version) and PRESERVES every row', () => {
    const db = new DatabaseSync(':memory:')
    seedLegacy(db)
    expect(pkColumns(db, 'agent_packs')).toEqual(['id']) // legacy: single-column PK

    migrateAgentPacksToVersioned(adapt(db))

    // New PK shape.
    expect(pkColumns(db, 'agent_packs')).toEqual(['profile_id', 'id', 'version'])
    // upstream_version column added.
    const cols = (db.prepare(`PRAGMA table_info(agent_packs)`).all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('upstream_version')

    // Every row survived with its data intact (version becomes the stored version; lineage preserved).
    const rows = db.prepare('SELECT id, profile_id, version, upstream_id, builtin, manifest FROM agent_packs ORDER BY id').all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      { id: 'mem', profile_id: 'prof', version: 3, upstream_id: null, builtin: 1, manifest: '{"name":"Memory"}' },
      { id: 'plot', profile_id: 'prof', version: 1, upstream_id: 'mem', builtin: 0, manifest: '{"name":"Plot"}' }
    ])
  })

  it('backfills activation pin_version to the installed version (a legacy DB held one version per id)', () => {
    const db = new DatabaseSync(':memory:')
    seedLegacy(db)
    migrateAgentPacksToVersioned(adapt(db))
    addPinAndBackfill(db)

    const act = db.prepare('SELECT pack_id, world_id, chat_id, gate_open, pin_version FROM agent_pack_activation ORDER BY pack_id, world_id, chat_id').all() as Array<Record<string, unknown>>
    // mem is installed at v3 → both its rows pin 3; plot at v1 → pins 1. Gate/exception preserved.
    expect(act).toEqual([
      { pack_id: 'mem', world_id: 'w1', chat_id: null, gate_open: 1, pin_version: 3 },
      { pack_id: 'mem', world_id: 'w1', chat_id: 'c1', gate_open: 0, pin_version: 3 },
      { pack_id: 'plot', world_id: 'w2', chat_id: null, gate_open: 1, pin_version: 1 }
    ])
  })

  it('is idempotent: re-running on an already-migrated DB is a no-op (rows + PK unchanged)', () => {
    const db = new DatabaseSync(':memory:')
    seedLegacy(db)
    migrateAgentPacksToVersioned(adapt(db))
    const before = db.prepare('SELECT id, version FROM agent_packs ORDER BY id').all()

    migrateAgentPacksToVersioned(adapt(db)) // second run
    expect(pkColumns(db, 'agent_packs')).toEqual(['profile_id', 'id', 'version'])
    expect(db.prepare('SELECT id, version FROM agent_packs ORDER BY id').all()).toEqual(before)
  })

  it('coexisting versions can now be inserted after migration (the whole point)', () => {
    const db = new DatabaseSync(':memory:')
    seedLegacy(db)
    migrateAgentPacksToVersioned(adapt(db))
    // Install mem v4 ALONGSIDE the migrated v3 — the old PK would have rejected this; the new one allows it.
    db.prepare(
      'INSERT INTO agent_packs (id, profile_id, version, upstream_id, upstream_version, builtin, manifest, fragment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('mem', 'prof', 4, null, null, 0, '{"name":"Memory v4"}', '{"kind":"fragment"}', 't2')
    const versions = (db.prepare("SELECT version FROM agent_packs WHERE id='mem' ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version)
    expect(versions).toEqual([3, 4])
  })
})
