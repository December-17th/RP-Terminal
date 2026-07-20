// Execution-plan M5a / D6 — the builtin decoy migration (plan §6 risk 4).
//
// A FRESH profile no longer seeds `Classic Narrator` / `Yuzu Scene Director`, so a fresh profile can
// never reproduce the orphan case. This suite builds a fixture DB that ALREADY holds the two seeded
// builtin rows WITH both roles bound (the pre-M5a state), then proves the migration deletes both rows
// and both bindings — and that it does so WITHOUT rebuilding any table (sqlite_master unchanged), so the
// kept `agent_role_bindings` table, its `role` CHECK constraint, and every other schema object survive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))
vi.mock('../../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import { closeDb, getDb, migrateRemoveDecoyBuiltinAgents } from '../../src/main/services/db'

const now = '2026-07-19T00:00:00.000Z'

const insertProfile = (id: string): void => {
  getDb()
    .prepare('INSERT INTO profiles (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run(id, id, now, now)
}

/** Insert one agent_catalog row with every NOT NULL column filled (a minimal but valid builtin row). */
const insertAgent = (
  profileId: string,
  id: string,
  name: string,
  sourceKind: string,
  sourceKey: string
): void => {
  const def = JSON.stringify({ name })
  getDb()
    .prepare(
      `INSERT INTO agent_catalog
       (id, profile_id, name, name_key, source_kind, source_key, source_version, source_present,
        available_source_version, available_definition, baseline_definition, customization_ops,
        effective_definition, effective_hash, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '1', 1, NULL, NULL, ?, '[]', ?, ?, 1, ?, ?)`
    )
    .run(id, profileId, name, name.toLowerCase(), sourceKind, sourceKey, def, def, `${id}-hash`, now, now)
}

const bindRole = (profileId: string, role: string, agentId: string): void => {
  getDb()
    .prepare(
      'INSERT INTO agent_role_bindings (profile_id, role, agent_id, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run(profileId, role, agentId, now)
}

const schemaSnapshot = (): unknown[] =>
  getDb()
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-decoy-migration-'))
})

afterEach(() => {
  closeDb()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('migrateRemoveDecoyBuiltinAgents', () => {
  it('deletes both seeded decoy rows and their bound roles, keeping every other row', () => {
    insertProfile('p')
    // The pre-M5a fixture: the two decoys seeded as builtins, plus a surviving Memory Maintenance
    // builtin and a user-created Agent that must NOT be touched.
    insertAgent('p', 'a-classic', 'Classic Narrator', 'builtin', 'classic-narrator')
    insertAgent('p', 'a-yuzu', 'Yuzu Scene Director', 'builtin', 'yuzu-scene-director')
    insertAgent('p', 'a-memory', 'Memory Maintenance', 'builtin', 'memory-maintenance')
    insertAgent('p', 'a-user', 'My Agent', 'user-created', 'user-key')
    bindRole('p', 'classic.narrator', 'a-classic')
    bindRole('p', 'yuzu.sceneDirector', 'a-yuzu')

    migrateRemoveDecoyBuiltinAgents(getDb())

    const remaining = getDb()
      .prepare('SELECT source_key FROM agent_catalog WHERE profile_id = ? ORDER BY source_key')
      .all('p')
    expect(remaining).toEqual([{ source_key: 'memory-maintenance' }, { source_key: 'user-key' }])

    const bindings = getDb()
      .prepare('SELECT COUNT(*) AS n FROM agent_role_bindings WHERE profile_id = ?')
      .get('p')
    expect(bindings).toEqual({ n: 0 })
  })

  it('does not rebuild any table — sqlite_master is byte-identical before and after', () => {
    insertProfile('p')
    insertAgent('p', 'a-classic', 'Classic Narrator', 'builtin', 'classic-narrator')
    insertAgent('p', 'a-yuzu', 'Yuzu Scene Director', 'builtin', 'yuzu-scene-director')
    bindRole('p', 'classic.narrator', 'a-classic')
    bindRole('p', 'yuzu.sceneDirector', 'a-yuzu')

    const before = schemaSnapshot()
    migrateRemoveDecoyBuiltinAgents(getDb())
    const after = schemaSnapshot()

    expect(after).toEqual(before)
    // And the kept table + its CHECK constraint are still present verbatim.
    const bindingsDdl = (after as Array<{ name: string; sql: string | null }>).find(
      (row) => row.name === 'agent_role_bindings'
    )
    expect(bindingsDdl?.sql).toContain("CHECK(role IN ('classic.narrator','yuzu.sceneDirector'))")
  })

  it('is idempotent — a second run over an already-clean DB is a no-op', () => {
    insertProfile('p')
    insertAgent('p', 'a-memory', 'Memory Maintenance', 'builtin', 'memory-maintenance')

    migrateRemoveDecoyBuiltinAgents(getDb())
    migrateRemoveDecoyBuiltinAgents(getDb())

    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS n FROM agent_catalog WHERE profile_id = ?')
      .get('p')
    expect(remaining).toEqual({ n: 1 })
  })
})
