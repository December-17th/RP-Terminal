import { randomUUID } from 'crypto'
import { getDb } from './db'

/**
 * CRUD over the `memory_entries` store (docs/episodic-memory-design.md §6). The core
 * uses only stream collections (append-only, `entity_key` NULL); entity-collection
 * upsert is deferred. The data-shaping helpers (`toRow`, `rowToEntry`) are pure and
 * unit-tested; the SQL wrappers are validated at runtime (the repo mocks better-sqlite3
 * to a no-op under Node, so DB execution isn't unit-tested — same as floorService).
 */

/** A row exactly as stored (snake_case mirrors the columns). */
export interface MemoryRow {
  id: string
  chat_id: string
  collection: string
  entity_key: string | null
  summary: string
  payload: string | null
  keywords: string | null
  entities: string | null
  salience: number | null
  pinned: number | null
  turn_start: number | null
  turn_end: number | null
  superseded_by: string | null
  embed_model: string | null
  updated_at: string | null
  created_at: string | null
}

/** A memory as returned to callers (typed; JSON columns parsed). */
export interface MemoryEntry {
  id: string
  chatId: string
  collection: string
  entityKey: string | null
  summary: string
  payload: unknown
  keywords: string[]
  entities: string[]
  salience: number
  pinned: boolean
  turnStart: number | null
  turnEnd: number | null
  supersededBy: string | null
  embedModel: string | null
  updatedAt: string | null
  createdAt: string | null
}

/** Fields a caller supplies when writing a memory; the store fills id + timestamps. */
export interface NewMemory {
  summary: string
  keywords?: string[]
  entities?: string[]
  salience?: number
  pinned?: boolean
  /** Entity collections only; NULL/omitted for stream rows. */
  entityKey?: string | null
  payload?: unknown
  turnStart?: number | null
  turnEnd?: number | null
  embedModel?: string | null
}

const safeJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** Map a NewMemory to a fully-populated row (pure; the SQL binds these by name). */
export const toRow = (
  chatId: string,
  collection: string,
  m: NewMemory,
  now: string,
  id: string = randomUUID()
): MemoryRow => ({
  id,
  chat_id: chatId,
  collection,
  entity_key: m.entityKey ?? null,
  summary: m.summary,
  payload: m.payload === undefined ? null : JSON.stringify(m.payload),
  keywords: m.keywords && m.keywords.length ? JSON.stringify(m.keywords) : null,
  entities: m.entities && m.entities.length ? JSON.stringify(m.entities) : null,
  salience: m.salience ?? 1,
  pinned: m.pinned ? 1 : 0,
  turn_start: m.turnStart ?? null,
  turn_end: m.turnEnd ?? null,
  superseded_by: null,
  embed_model: m.embedModel ?? null,
  updated_at: now,
  created_at: now
})

/** Map a stored row back to a typed entry (pure; parses the JSON columns). */
export const rowToEntry = (r: MemoryRow): MemoryEntry => ({
  id: r.id,
  chatId: r.chat_id,
  collection: r.collection,
  entityKey: r.entity_key,
  summary: r.summary,
  payload: r.payload ? safeJson<unknown>(r.payload, null) : null,
  keywords: safeJson<string[]>(r.keywords, []),
  entities: safeJson<string[]>(r.entities, []),
  salience: r.salience ?? 1,
  pinned: !!r.pinned,
  turnStart: r.turn_start,
  turnEnd: r.turn_end,
  supersededBy: r.superseded_by,
  embedModel: r.embed_model,
  updatedAt: r.updated_at,
  createdAt: r.created_at
})

/**
 * Append memories to a (stream) collection. Append-only: stream rows have a NULL
 * `entity_key`, which SQLite treats as distinct under the UNIQUE constraint, so they
 * never collide. Entity-collection upsert is a separate, deferred path.
 */
export const appendEntries = (
  _profileId: string,
  chatId: string,
  collection: string,
  rows: NewMemory[]
): void => {
  if (!rows.length) return
  const now = new Date().toISOString()
  const stmt = getDb().prepare(
    `INSERT INTO memory_entries
       (id, chat_id, collection, entity_key, summary, payload, keywords, entities,
        salience, pinned, turn_start, turn_end, superseded_by, embed_model, updated_at, created_at)
     VALUES
       (@id, @chat_id, @collection, @entity_key, @summary, @payload, @keywords, @entities,
        @salience, @pinned, @turn_start, @turn_end, @superseded_by, @embed_model, @updated_at, @created_at)`
  )
  for (const m of rows) stmt.run(toRow(chatId, collection, m, now))
}

/** All live (non-superseded) entries for a collection, newest first. */
export const getEntries = (
  _profileId: string,
  chatId: string,
  collection: string
): MemoryEntry[] => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE chat_id = ? AND collection = ? AND superseded_by IS NULL
       ORDER BY rowid DESC`
    )
    .all(chatId, collection) as MemoryRow[]
  return rows.map(rowToEntry)
}

/**
 * Delete every memory whose provenance starts at or after `fromFloor` — the
 * rewind-safety hook (docs §11.M): when floors are truncated (regenerate/swipe/edit),
 * memories summarized from those floors must go too. Returns the number deleted.
 */
export const deleteFromTurn = (_profileId: string, chatId: string, fromFloor: number): number => {
  const info = getDb()
    .prepare('DELETE FROM memory_entries WHERE chat_id = ? AND turn_start >= ?')
    .run(chatId, fromFloor) as { changes?: number } | undefined
  return info?.changes ?? 0
}

/** Count entries in a collection for a chat. */
export const countEntries = (_profileId: string, chatId: string, collection: string): number => {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE chat_id = ? AND collection = ?')
    .get(chatId, collection) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * The compaction pointer after truncating floors from `fromFloor` (rewind-safety, docs §11.M):
 * rewind to one before the cut so regenerated floors are re-compacted, or null if the cut is
 * entirely within the still-verbatim range (pointer unchanged). Pure. Lives here (not
 * compactionService) to avoid a chatService↔compactionService import cycle.
 */
export const rewindCompactionPointer = (
  lastCompacted: number,
  fromFloor: number
): number | null => (lastCompacted >= fromFloor ? fromFloor - 1 : null)
