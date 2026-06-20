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
  mode TEXT
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
CREATE TABLE IF NOT EXISTS episodic_memory (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  chunk TEXT NOT NULL,
  summary TEXT,
  embedding BLOB,
  created_at TEXT
);
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
  return db
}
