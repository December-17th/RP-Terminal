import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { getAppDir, ensureDir } from './storageService'
import { getDb } from './db'
import { log } from './logService'

/**
 * Per-CHAT session SQLite — the "decentralized save" store (decentralize-save-system plan §B2).
 *
 * A chat's chat-scoped relational state lives in its OWN database file:
 * `profiles/<id>/chats/<chatId>/session.sqlite` — NEVER the central app DB (`rpterminal.db`), which
 * demotes to an index + shared library. A save becomes a FOLDER (this file + `table.sqlite` +
 * `notes.md` + `session-vars.json` + `manifest.json`), so export = zip the folder.
 *
 * This is S0: the scaffold. It owns the schema + the handle provider; NOTHING reads it yet (the seam
 * services flip over in S1, behind the one-time migration in S2). Pure helpers (path building,
 * cache-key, LRU eviction) have focused unit coverage; session SQL and files are also exercised through
 * the local Node SQLite adapter in lifecycle integration tests. Suites using the default Vitest alias
 * still receive the lightweight no-op database.
 *
 * FOREIGN KEYS ARE DELIBERATELY OFF HERE (plan review C5). The DDL below is lifted from `db.ts` with
 * every `REFERENCES chats(id) ON DELETE CASCADE` STRIPPED — a session DB has no `chats` table, so
 * enabling FKs would make every insert fail. Referential integrity between the index and the session
 * store is service-enforced instead (deletion = close handle + rm folder; startup orphan sweep).
 * The `chat_id` column is RETAINED on every table (plan §B2) so the S1 refactor is a mechanical
 * `getDb()` → `getSessionDb(profileId, chatId)` swap with the SQL (and existing tests) unchanged.
 *
 * Column sets are the CURRENT `db.ts` shapes with the `addColumnIfMissing` columns folded inline (a
 * fresh session DB needs no forward migrations): floors carries swipes/swipe_id/request/metrics/
 * plot_block; table_ops carries target_table/source/from_floor.
 */
export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS floors (
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  user_content TEXT NOT NULL,
  user_timestamp TEXT,
  response_content TEXT NOT NULL,
  response_model TEXT,
  response_provider TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '{}',
  swipes TEXT,
  swipe_id INTEGER,
  request TEXT,
  metrics TEXT,
  plot_block TEXT,
  PRIMARY KEY (chat_id, floor)
);

CREATE TABLE IF NOT EXISTS combat_encounters (
  chat_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS node_state (
  chat_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  data TEXT,
  updated_at TEXT,
  PRIMARY KEY (chat_id, workflow_id, node_id)
);

CREATE TABLE IF NOT EXISTS table_ops (
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  sql TEXT NOT NULL,
  created_at TEXT,
  target_table TEXT,
  source TEXT,
  from_floor INTEGER,
  PRIMARY KEY (chat_id, floor, seq)
);
CREATE INDEX IF NOT EXISTS idx_table_ops_chat_floor ON table_ops(chat_id, floor);
CREATE INDEX IF NOT EXISTS idx_table_ops_chat_table_floor ON table_ops(chat_id, target_table, floor);

CREATE TABLE IF NOT EXISTS vars_ops (
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('patch','replace')),
  payload TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (chat_id, floor, seq)
);
CREATE INDEX IF NOT EXISTS idx_vars_ops_chat_floor ON vars_ops(chat_id, floor);

CREATE TABLE IF NOT EXISTS table_progress (
  chat_id TEXT NOT NULL,
  sql_name TEXT NOT NULL,
  last_floor INTEGER NOT NULL,
  PRIMARY KEY (chat_id, sql_name)
);

CREATE TABLE IF NOT EXISTS table_refill_progress (
  chat_id TEXT PRIMARY KEY,
  selected_json TEXT NOT NULL,
  from_floor INTEGER NOT NULL,
  completed_until INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_trigger_state (
  chat_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  last_value REAL,
  last_fire_floor INTEGER,
  PRIMARY KEY (chat_id, doc_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_trigger_state_chat ON workflow_trigger_state(chat_id);

-- Forensic Execution Record per generation (st-preset-compat issue 09). Keyed to the FLOOR it
-- explains; the record column is the record JSON with its wire STRIPPED (the exact wire duplicates the
-- floor request column — executionRecordStore rehydrates it on read). Rolling retention prunes old rows.
CREATE TABLE IF NOT EXISTS execution_records (
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (chat_id, floor)
);

-- Immutable, floor-owned Agent invocation evidence. The JSON record is a complete snapshot; the
-- projected columns make lifecycle reads/deletion cheap without coupling callers to its internals.
CREATE TABLE IF NOT EXISTS agent_runs (
  invocation_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_chat_floor ON agent_runs(chat_id, floor);
CREATE INDEX IF NOT EXISTS idx_agent_runs_chat_started ON agent_runs(chat_id, started_at);
`

// ---- pure helpers (unit-tested) --------------------------------------------------------------

/** The per-session STORE directory for a chat — one folder per save (§B1). */
export const sessionDir = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chats', chatId)

/** The `session.sqlite` file path inside a chat's session store. */
export const sessionDbPath = (profileId: string, chatId: string): string =>
  path.join(sessionDir(profileId, chatId), 'session.sqlite')

/** Cache key for a (profile, chat) handle. NUL separates the two opaque ids (neither can contain it). */
export const sessionKey = (profileId: string, chatId: string): string =>
  `${profileId}\u0000${chatId}`

/**
 * Which cache keys to evict to bring an insertion-ordered key list down to `cap` (LRU: oldest first).
 * Pure so the eviction policy is testable without opening real DB handles. A Map iterates in insertion
 * order; `getSessionDb` re-inserts on access to mark recency, so the front of the list is least-recent.
 */
export const keysToEvict = (orderedKeys: string[], cap: number): string[] =>
  orderedKeys.length <= cap ? [] : orderedKeys.slice(0, orderedKeys.length - cap)

// ---- handle cache + SQL wrappers -------------------------------------------------------------

/** Max simultaneously-open session handles. Session DBs are cheap but each holds a WAL fd; an LRU cap
 *  bounds fd/memory use while keeping the working set (the active chat + a few recents) hot. */
const HANDLE_CAP = 16

// Insertion order = recency (least-recent first); `getSessionDb` deletes+re-sets on hit to bump.
const handles = new Map<string, Database.Database>()

const closeQuietly = (db: Database.Database | undefined): void => {
  try {
    db?.close()
  } catch (error) {
    log('info', 'Failed to close a session DB handle:', error)
  }
}

/**
 * Open (or return the cached) session DB for a chat, creating the store dir + schema on first touch.
 * LRU: a cache hit is bumped to most-recent; opening past HANDLE_CAP closes the least-recent handle.
 *
 * CAVEAT (plan review C5): this `CREATE IF NOT EXISTS` will RESURRECT a deleted chat's folder if a late
 * writer (e.g. a finishing headless run) calls it after `deleteChat`. The guard lives in the chat-keyed
 * entry point `getSessionDbByChat` (below): it returns null when the chat has no central index row, so a
 * post-delete write is a no-op. Direct `getSessionDb(profileId, chatId)` callers (createChat, the
 * migration) are trusted to hold a live chat and bypass that check by design.
 */
export const getSessionDb = (profileId: string, chatId: string): Database.Database => {
  const key = sessionKey(profileId, chatId)
  const cached = handles.get(key)
  if (cached) {
    handles.delete(key)
    handles.set(key, cached) // re-insert → most-recent
    return cached
  }
  ensureDir(sessionDir(profileId, chatId))
  const db = new Database(sessionDbPath(profileId, chatId))
  db.pragma('journal_mode = WAL')
  // foreign_keys intentionally left OFF (see file header / plan review C5).
  db.exec(SESSION_SCHEMA)
  handles.set(key, db)
  for (const evictKey of keysToEvict([...handles.keys()], HANDLE_CAP)) {
    const victim = handles.get(evictKey)
    handles.delete(evictKey)
    closeQuietly(victim)
  }
  return db
}

/** Run `fn` inside a single transaction on the chat's session DB (all-or-nothing). This is the
 *  session-DB analogue of `db.transact` — the two cross-service op-log transactions
 *  (tableStructureService.rewriteOpLog, tableRefillService.commitChunk) MUST migrate onto this in S1,
 *  or they become empty transactions on the wrong connection (plan review C2). */
export const withSessionTx = <T>(profileId: string, chatId: string, fn: () => T): T =>
  getSessionDb(profileId, chatId).transaction(fn)()

/**
 * Close a chat's cached handle (if any) then delete its whole session-store folder + WAL sidecars.
 * The handle is closed FIRST because Windows locks open SQLite files (this project has hit
 * process-locked dirs) — deleting before close would fail. Idempotent / best-effort.
 */
export const removeSession = (profileId: string, chatId: string): void => {
  forgetChat(chatId)
  const key = sessionKey(profileId, chatId)
  const cached = handles.get(key)
  if (cached) {
    handles.delete(key)
    closeQuietly(cached)
  }
  try {
    const dir = sessionDir(profileId, chatId)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    log('info', `Failed to remove session store for chat ${chatId}:`, error)
  }
}

/** Close every open session handle (app quit / profile switch). Must run before a profile-dir wipe so
 *  Windows file locks don't defeat the recursive delete (plan review C3). Idempotent. */
export const closeAll = (): void => {
  for (const db of handles.values()) closeQuietly(db)
  handles.clear()
  profileIdByChat.clear()
}

// ---- chat-keyed access (resolves profileId from the central index) ---------------------------
//
// Most chat-scoped writers hold only a `chatId` (varsOps/nodeState/combat/tableOps/…). Rather than
// thread `profileId` through every one and their callers (plan review C9), a session handle is
// resolved by `chatId` here: look up the owning profile from the central `chats` index (cached), then
// open that chat's store. Returns null when the chat has NO index row — which is exactly the C5
// resurrection guard (a write landing after deleteChat becomes a no-op instead of recreating the
// folder) AND the vitest behavior (the sqlite mock returns no row → null → wrappers no-op, matching
// the old `getDb()` no-op stance). This is why sessionDbService imports getDb — one-way (db.ts does
// not import this module; the one-time migration lives in its own module to avoid a cycle).

const profileIdByChat = new Map<string, string>()

/** The owning profileId for a chat, from the central `chats` index (cached). Null when no such chat. */
export const resolveProfileId = (chatId: string): string | null => {
  const cached = profileIdByChat.get(chatId)
  if (cached) return cached
  const row = getDb().prepare('SELECT profile_id FROM chats WHERE id = ?').get(chatId) as
    | { profile_id: string }
    | undefined
  if (!row?.profile_id) return null
  profileIdByChat.set(chatId, row.profile_id)
  return row.profile_id
}

/** Drop a chat's cached profile mapping — called by removeSession so a re-created id can't resolve to a
 *  stale profile, and so the C5 guard re-checks the index for a deleted chat. */
export const forgetChat = (chatId: string): void => {
  profileIdByChat.delete(chatId)
}

/** Open (or return the cached) session DB for a chat by its id alone. Null when the chat has no index
 *  row (deleted / not yet created / under the sqlite mock) — callers treat null as "no data / skip". */
export const getSessionDbByChat = (chatId: string): Database.Database | null => {
  const profileId = resolveProfileId(chatId)
  return profileId ? getSessionDb(profileId, chatId) : null
}
