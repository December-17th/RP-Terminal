import Database from 'better-sqlite3'
import path from 'path'
import { getAppDir, ensureDir } from './storageService'

let db: Database.Database | null = null

/**
 * Relational schema for session/state data only. Portable, user-shareable
 * artifacts — presets, lorebooks, regex — are intentionally NOT stored here;
 * they live as JSON files in their native format (see preset/lorebook services).
 * JSON blobs are used for cards/settings where a Zod schema owns the shape.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_path TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL,
  last_active TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  card TEXT NOT NULL,
  avatar_path TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_characters_profile ON characters(profile_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- JSON array of active lorebook ids; NULL means "default to the character's own lorebook".
  lorebook_ids TEXT,
  -- Active FSM mode (Explore/Dialogue/Combat); NULL is treated as 'explore'.
  mode TEXT,
  -- Cached L2 world-info matched for the current mode: {mode, entries}. Reused across
  -- turns within a mode and re-matched only on a mode transition (Phase H inc 2 / Phase G).
  cached_world_info TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_profile ON chats(profile_id);

CREATE TABLE IF NOT EXISTS floors (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  floor INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  user_content TEXT NOT NULL,
  user_timestamp TEXT,
  response_content TEXT NOT NULL,
  response_model TEXT,
  response_provider TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (chat_id, floor)
);

-- One active combat encounter per chat (combatService). The data column holds the
-- serialized EncounterRecord (CombatState + ability catalog + card hook scripts);
-- ephemeral, deleted when the fight ends. See docs/combat-system-design.md §7.
CREATE TABLE IF NOT EXISTS combat_encounters (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT
);
-- Durable per-node scratchpad for workflow nodes, keyed by (chat_id, workflow_id, node_id) —
-- what makes "changed since last fire" (control.when) expressible. Workflow id is part of the
-- key because clones of the default graph keep node ids by design, so (chat_id, node_id) alone
-- collides across workflows. See the node-workflow spec §11.
CREATE TABLE IF NOT EXISTS node_state (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  data TEXT,
  updated_at TEXT,
  PRIMARY KEY (chat_id, workflow_id, node_id)
);
`

// Presets/lorebooks were briefly stored in SQL during early Phase F; they are now
// file-based, so drop the tables if an older DB still has them. The source JSON
// on disk is the surviving copy. `rpg_entities` was a forward-facing table that never
// had any reader/writer (WS-6) — always empty, so dropping it from old DBs is safe.
// (`pending_lore`, an unused `chats` column, is left in place: a NULL column is harmless
// and ALTER ... DROP COLUMN isn't worth the migration risk.)
const DROP_LEGACY = `
DROP TABLE IF EXISTS lorebook_entries;
DROP TABLE IF EXISTS lorebooks;
DROP TABLE IF EXISTS presets;
DROP TABLE IF EXISTS presets_legacy;
DROP TABLE IF EXISTS profile_state;
DROP TABLE IF EXISTS rpg_entities;
-- Legacy long-term-memory tables. episodic_memory was reserved, never written; memory_entries
-- backed the episodic-memory engine removed in the SQL-table-memory overhaul (2026-07-02) — it
-- never ran live (memory.enabled defaulted off), so its data is dropped rather than migrated. The
-- stale, unread chats.memory_state column is deliberately left in place (SQLite DROP COLUMN isn't
-- worth the migration risk; a NULL column is harmless — same call as pending_lore above).
DROP TABLE IF EXISTS episodic_memory;
DROP TABLE IF EXISTS memory_entries;
`

/** Add a column to a table if a pre-existing DB doesn't already have it (idempotent). */
const addColumnIfMissing = (
  database: Database.Database,
  table: string,
  column: string,
  ddl: string
): void => {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

export const getDb = (): Database.Database => {
  if (db) return db
  ensureDir(getAppDir())
  db = new Database(path.join(getAppDir(), 'rpterminal.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // node_state pre-migration: the 2-column-PK shape shipped 2026-07-01 and never ran live
  // (no selection surface existed), so a legacy table is dropped rather than migrated —
  // CREATE IF NOT EXISTS below rebuilds it keyed (chat_id, workflow_id, node_id).
  const nodeStateCols = db.prepare(`PRAGMA table_info(node_state)`).all() as Array<{ name: string }>
  if (nodeStateCols.length > 0 && !nodeStateCols.some((c) => c.name === 'workflow_id')) {
    db.exec('DROP TABLE node_state')
  }
  db.exec(SCHEMA)
  db.exec(DROP_LEGACY)
  // Lightweight forward migrations for DBs created before a column existed.
  addColumnIfMissing(db, 'chats', 'lorebook_ids', 'lorebook_ids TEXT')
  addColumnIfMissing(db, 'chats', 'mode', 'mode TEXT')
  addColumnIfMissing(db, 'chats', 'cached_world_info', 'cached_world_info TEXT')
  addColumnIfMissing(db, 'chats', 'pending_lore', 'pending_lore TEXT')
  // Session-tier workflow override (node-workflow spec §12); null = inherit world/global/builtin.
  addColumnIfMissing(db, 'chats', 'workflow_id', 'workflow_id TEXT')
  // TH-2 swipes: alternate responses per floor + the active index.
  addColumnIfMissing(db, 'floors', 'swipes', 'swipes TEXT')
  addColumnIfMissing(db, 'floors', 'swipe_id', 'swipe_id INTEGER')
  // The full prompt (message array) sent for this floor — lossless inspection/replay.
  addColumnIfMissing(db, 'floors', 'request', 'request TEXT')
  // Per-turn cache/token metrics (turn + cumulative snapshot) — see token-cache-meter-design.md.
  addColumnIfMissing(db, 'floors', 'metrics', 'metrics TEXT')
  return db
}

/** Run `fn` inside a single SQLite transaction (all-or-nothing; rolls back if it throws). */
export const transact = <T>(fn: () => T): T => getDb().transaction(fn)()
