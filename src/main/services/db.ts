import Database from 'better-sqlite3'
import path from 'path'
import { getAppDir, ensureDir } from './storageService'

let db: Database.Database | null = null

/**
 * Relational schema. Current-feature tables (profiles..floors) plus a couple of
 * forward-facing tables (rpg_entities, episodic_memory) so future migrations are
 * additive. JSON blobs are used where the shape is owned by a Zod schema on the
 * application side (cards, settings, presets).
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

CREATE TABLE IF NOT EXISTS presets (
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

CREATE TABLE IF NOT EXISTS lorebooks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  character_id TEXT,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lorebooks_character ON lorebooks(character_id);

CREATE TABLE IF NOT EXISTS lorebook_entries (
  id TEXT PRIMARY KEY,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  keys TEXT NOT NULL,
  secondary_keys TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  insertion_order INTEGER NOT NULL DEFAULT 100,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  constant INTEGER NOT NULL DEFAULT 0,
  selective INTEGER NOT NULL DEFAULT 0,
  protected INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_entries_lorebook ON lorebook_entries(lorebook_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

export const getDb = (): Database.Database => {
  if (db) return db
  ensureDir(getAppDir())
  db = new Database(path.join(getAppDir(), 'rpterminal.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
