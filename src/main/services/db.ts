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
  cached_world_info TEXT,
  -- Forward-facing (Phase J): queued lore mutations flushed at the next mode transition.
  pending_lore TEXT
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

-- Forward-facing (Phase H/I/K); unused for now.
CREATE TABLE IF NOT EXISTS rpg_entities (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  name TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
-- One active combat encounter per chat (combatService). The data column holds the
-- serialized EncounterRecord (CombatState + ability catalog + card hook scripts);
-- ephemeral, deleted when the fight ends. See docs/combat-system-design.md §7.
CREATE TABLE IF NOT EXISTS combat_encounters (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT
);
-- Long-term memory engine (docs/episodic-memory-design.md §6). One generic store
-- partitioned by the collection column; entity rows upsert on (chat_id, collection,
-- entity_key) while stream rows (entity_key NULL — distinct under SQLite UNIQUE) coexist.
-- The core writes/reads only the 'events' collection; entity/vector columns are reserved
-- (no second migration). The optional sqlite-vec memory_vec table is NOT created here.
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  entity_key TEXT,
  summary TEXT NOT NULL,
  payload TEXT,
  keywords TEXT,
  entities TEXT,
  salience REAL DEFAULT 1,
  pinned INTEGER DEFAULT 0,
  turn_start INTEGER,
  turn_end INTEGER,
  superseded_by TEXT,
  embed_model TEXT,
  updated_at TEXT,
  created_at TEXT,
  UNIQUE(chat_id, collection, entity_key)
);
CREATE INDEX IF NOT EXISTS idx_mem_chat_coll ON memory_entries(chat_id, collection);
`

// Presets/lorebooks were briefly stored in SQL during early Phase F; they are now
// file-based, so drop the tables if an older DB still has them. The source JSON
// on disk is the surviving copy.
const DROP_LEGACY = `
DROP TABLE IF EXISTS lorebook_entries;
DROP TABLE IF EXISTS lorebooks;
DROP TABLE IF EXISTS presets;
DROP TABLE IF EXISTS presets_legacy;
DROP TABLE IF EXISTS profile_state;
-- Superseded by memory_entries (was reserved, never written). See db §memory.
DROP TABLE IF EXISTS episodic_memory;
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
  db.exec(SCHEMA)
  db.exec(DROP_LEGACY)
  // Lightweight forward migrations for DBs created before a column existed.
  addColumnIfMissing(db, 'chats', 'lorebook_ids', 'lorebook_ids TEXT')
  addColumnIfMissing(db, 'chats', 'mode', 'mode TEXT')
  addColumnIfMissing(db, 'chats', 'cached_world_info', 'cached_world_info TEXT')
  addColumnIfMissing(db, 'chats', 'pending_lore', 'pending_lore TEXT')
  // Memory checkpoint bookkeeping per chat: {last_compacted_floor}. See compactionService.
  addColumnIfMissing(db, 'chats', 'memory_state', 'memory_state TEXT')
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
