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
  embedding: string | null
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
  embedding: number[] | null
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
  embedding: null,
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
  embedding: safeJson<number[] | null>(r.embedding, null),
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
        salience, pinned, turn_start, turn_end, superseded_by, embed_model, embedding,
        updated_at, created_at)
     VALUES
       (@id, @chat_id, @collection, @entity_key, @summary, @payload, @keywords, @entities,
        @salience, @pinned, @turn_start, @turn_end, @superseded_by, @embed_model, @embedding,
        @updated_at, @created_at)`
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

// --- Data-management surface (the Memory view: browse / edit / pin / delete) -------------------

/** Every live entry for a chat across ALL collections (newest-first within each), for the UI. */
export const getAllEntries = (_profileId: string, chatId: string): MemoryEntry[] => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE chat_id = ? AND superseded_by IS NULL
       ORDER BY collection ASC, rowid DESC`
    )
    .all(chatId) as MemoryRow[]
  return rows.map(rowToEntry)
}

/** Fields a manual edit can change. */
export interface EntryPatch {
  summary?: string
  keywords?: string[]
  pinned?: boolean
}

/**
 * Map an edit patch to the columns to set. Pure; the keys are a fixed allowlist (summary /
 * keywords / pinned) so they're never interpolated from user input.
 */
export const entryPatchToColumns = (patch: EntryPatch): Record<string, unknown> => {
  const cols: Record<string, unknown> = {}
  if (patch.summary !== undefined) cols.summary = patch.summary
  if (patch.keywords !== undefined)
    cols.keywords = patch.keywords.length ? JSON.stringify(patch.keywords) : null
  if (patch.pinned !== undefined) cols.pinned = patch.pinned ? 1 : 0
  return cols
}

/** Apply a manual edit (summary / keywords / pinned) to one entry; touches updated_at. */
export const updateEntry = (
  _profileId: string,
  chatId: string,
  id: string,
  patch: EntryPatch
): void => {
  const cols = entryPatchToColumns(patch)
  const keys = Object.keys(cols)
  if (!keys.length) return
  const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?']
  // A summary edit invalidates the embedding so the writer re-embeds the corrected text.
  if (patch.summary !== undefined) sets.push('embedding = NULL')
  const vals = [...keys.map((k) => cols[k]), new Date().toISOString(), id, chatId]
  getDb()
    .prepare(`UPDATE memory_entries SET ${sets.join(', ')} WHERE id = ? AND chat_id = ?`)
    .run(...vals)
}

/** Delete one entry by id (the UI's per-row delete). Returns the number removed. */
export const deleteEntry = (_profileId: string, chatId: string, id: string): number => {
  const info = getDb()
    .prepare('DELETE FROM memory_entries WHERE id = ? AND chat_id = ?')
    .run(id, chatId) as { changes?: number } | undefined
  return info?.changes ?? 0
}

/**
 * Add a player-authored "remember this" memory: a pinned `events` row with no provenance, so it's
 * always recalled and isn't tied to a floor range (a rewind won't drop it). docs §11.G.
 */
export const addManualEntry = (
  profileId: string,
  chatId: string,
  summary: string,
  keywords: string[] = []
): void => {
  appendEntries(profileId, chatId, 'events', [{ summary, keywords, pinned: true, salience: 1 }])
}

// --- Entity collections (upsert-keyed sheets: characters / locations) — docs §5.1, §14 ----------

/** A character/location sheet, stored in an entity row's `payload` (T2: deltas + consolidation). */
export interface EntitySheet {
  aliases: string[]
  /** Current consolidated facts (role, goals, status, description, …). */
  fields: Record<string, string>
  /** Append-only dated change notes. */
  log: { turn: string; note: string }[]
}

/** One extracted update for an entity (from the writer's structured call). */
export interface EntityUpdate {
  aliases?: string[]
  fields?: Record<string, string>
  note?: string
  turn?: string
}

const emptySheet = (): EntitySheet => ({ aliases: [], fields: {}, log: [] })

const uniqCI = (xs: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    const v = x.trim()
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase())
      out.push(v)
    }
  }
  return out
}

/** Merge an update into a sheet: union aliases, overlay changed fields, append a dated note. Pure. */
export const mergeEntitySheet = (
  existing: EntitySheet | null,
  update: EntityUpdate
): EntitySheet => {
  const base = existing ?? emptySheet()
  return {
    aliases: uniqCI([...base.aliases, ...(update.aliases ?? [])]),
    fields: { ...base.fields, ...(update.fields ?? {}) },
    log:
      update.note && update.note.trim()
        ? [...base.log, { turn: update.turn ?? '', note: update.note.trim() }]
        : base.log
  }
}

/**
 * Resolve the upsert key for an entity update (T1): reuse an existing record's key when the
 * canonical name or any alias matches that record's key or aliases (case-insensitive); otherwise
 * the canonical name is a new key. Pure.
 */
export const resolveEntityKey = (
  canonical: string,
  aliases: string[],
  existing: { entityKey: string; aliases: string[] }[]
): string => {
  const want = new Set([canonical, ...aliases].map((s) => s.trim().toLowerCase()).filter(Boolean))
  for (const rec of existing) {
    const known = [rec.entityKey, ...rec.aliases].map((s) => s.trim().toLowerCase())
    if (known.some((k) => want.has(k))) return rec.entityKey
  }
  return canonical
}

/** Read one entity record by key (or null). */
export const getEntity = (
  _profileId: string,
  chatId: string,
  collection: string,
  entityKey: string
): MemoryEntry | null => {
  const row = getDb()
    .prepare('SELECT * FROM memory_entries WHERE chat_id = ? AND collection = ? AND entity_key = ?')
    .get(chatId, collection, entityKey) as MemoryRow | undefined
  return row ? rowToEntry(row) : null
}

/** Insert-or-update an entity record (upsert on UNIQUE(chat, collection, entity_key)). */
export const upsertEntity = (
  _profileId: string,
  chatId: string,
  collection: string,
  entityKey: string,
  summary: string,
  sheet: EntitySheet
): void => {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO memory_entries
         (id, chat_id, collection, entity_key, summary, payload, keywords, entities,
          salience, pinned, turn_start, turn_end, superseded_by, embed_model, updated_at, created_at)
       VALUES
         (@id, @chat_id, @collection, @entity_key, @summary, @payload, NULL, @entities,
          1, 0, NULL, NULL, NULL, NULL, @updated_at, @created_at)
       ON CONFLICT(chat_id, collection, entity_key) DO UPDATE SET
         summary = excluded.summary,
         payload = excluded.payload,
         entities = excluded.entities,
         embedding = NULL,
         updated_at = excluded.updated_at`
    )
    .run({
      id: randomUUID(),
      chat_id: chatId,
      collection,
      entity_key: entityKey,
      summary,
      payload: JSON.stringify(sheet),
      entities: sheet.aliases.length ? JSON.stringify(sheet.aliases) : null,
      updated_at: now,
      created_at: now
    })
}

/** Store a memory's embedding (+ the model that produced it). */
export const setEmbedding = (
  _profileId: string,
  chatId: string,
  id: string,
  embedding: number[],
  model: string
): void => {
  getDb()
    .prepare(
      'UPDATE memory_entries SET embedding = ?, embed_model = ? WHERE id = ? AND chat_id = ?'
    )
    .run(JSON.stringify(embedding), model, id, chatId)
}

/**
 * Memories in a collection that need (re)embedding — no embedding yet, or one from a different
 * model. For the writer's background embedding pass.
 */
export const getEmbeddable = (
  _profileId: string,
  chatId: string,
  collection: string,
  model: string
): { id: string; summary: string }[] =>
  getDb()
    .prepare(
      `SELECT id, summary FROM memory_entries
       WHERE chat_id = ? AND collection = ? AND superseded_by IS NULL
         AND (embedding IS NULL OR embed_model IS NOT ?)`
    )
    .all(chatId, collection, model) as { id: string; summary: string }[]

/**
 * The compaction pointer after truncating floors from `fromFloor` (rewind-safety, docs §11.M):
 * rewind to one before the cut so regenerated floors are re-compacted, or null if the cut is
 * entirely within the still-verbatim range (pointer unchanged). Pure. Lives here (not
 * compactionService) to avoid a chatService↔compactionService import cycle.
 */
export const rewindCompactionPointer = (lastCompacted: number, fromFloor: number): number | null =>
  lastCompacted >= fromFloor ? fromFloor - 1 : null
