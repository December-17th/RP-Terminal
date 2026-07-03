import { getDb } from './db'

/**
 * Chat-level per-table maintenance-progress store (SQL-table-memory issue 07).
 *
 * The Tables view display AND both write mechanisms — the per-turn `table.gate` cadence and the
 * manual backfill (`tableBackfillService`) — must share ONE last-processed pointer per (chat, table).
 * A per-(workflow, node) node-state pointer (the issue-05 gate design) can't serve a chat-level
 * display and would double-maintain across workflow switches, so this REPLACES it (the feature is
 * unreleased — no compat shim; the gate's `at` rewind discriminator is retired too).
 *
 * The pointer is the 0-based floor index up to which a table was last processed (a table absent from
 * the store has never been processed → treated as -1). It is:
 *  - ADVANCED (max-semantics) by the gate on fire and by every applied backfill batch,
 *  - CLAMPED explicitly on floor truncation (`clampProgress`, hooked in `chatService.truncateFloors`
 *    next to the ops clamp — no `at`-discriminator inference),
 *  - RESET (rows deleted) on template (re)assignment / unassignment (hooked in `setChatTableTemplateId`).
 *
 * The pure `computeTableProgress` derives the three display numbers; the SQL wrappers follow the
 * established untestable stance (better-sqlite3 is alias-mocked — see docs/sdk/table-templates.md).
 */

/** The three display numbers for one table, from its last-processed floor + its update frequency. */
export interface TableProgress {
  /** How many floors have been folded into this table: `last + 1` (0 when never processed). */
  processed: number
  /** The 0-based floor index at which the gate will next fire: `last + updateFrequency`. */
  nextExpected: number
  /** Floors not yet processed: `max(0, currentFloor - last)` (currentFloor = last floor index). */
  unprocessed: number
}

/**
 * PURE (unit-tested): derive the three display numbers.
 *  - `last = lastFloor ?? -1` (a never-processed table is -1).
 *  - `processed = last + 1` — never-processed → 0.
 *  - `nextExpected = last + updateFrequency` — never-processed, freq 1 → 0 (floor 0 fires it);
 *    freq 3 → 2 (three floors 0,1,2 must elapse). 0-based floor indices throughout.
 *  - `unprocessed = max(0, currentFloor - last)` — currentFloor is the last floor's 0-based index
 *    (getAllFloors().length - 1). An empty chat passes currentFloor -1 → unprocessed 0.
 */
export const computeTableProgress = (
  lastFloor: number | undefined,
  updateFrequency: number,
  currentFloor: number
): TableProgress => {
  const last = lastFloor ?? -1
  return {
    processed: last + 1,
    nextExpected: last + updateFrequency,
    unprocessed: Math.max(0, currentFloor - last)
  }
}

// ---- store CRUD (app DB) — untestable stance (alias-mocked better-sqlite3) --------------------

/** Every table's last-processed floor for a chat: `Record<sqlName, lastFloor>`. Absent = never. */
export const getProgress = (_profileId: string, chatId: string): Record<string, number> => {
  const rows = getDb()
    .prepare('SELECT sql_name, last_floor FROM table_progress WHERE chat_id = ?')
    .all(chatId) as Array<{ sql_name: string; last_floor: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.sql_name] = r.last_floor
  return out
}

/**
 * Advance the pointer for each named table to `floor` with MAX semantics (never regresses): upsert
 * `last_floor = MAX(existing, floor)`. Called by the gate on fire (currentFloor) and by every applied
 * backfill batch (the batch's LAST floor). A blank name list is a no-op.
 */
export const advanceProgress = (
  _profileId: string,
  chatId: string,
  sqlNames: string[],
  floor: number
): void => {
  if (!sqlNames.length) return
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO table_progress (chat_id, sql_name, last_floor) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, sql_name) DO UPDATE SET last_floor = MAX(last_floor, excluded.last_floor)`
  )
  const run = db.transaction(() => {
    for (const name of sqlNames) stmt.run(chatId, name, floor)
  })
  run()
}

/**
 * The EXPLICIT rewind clamp: after floors are truncated to below `fromFloor`, every pointer at or
 * beyond `fromFloor` is pulled back to `fromFloor - 1` ("processed through the floor before the cut")
 * so cadences resume immediately instead of stalling. Hooked in `chatService.truncateFloors`.
 */
export const clampProgress = (_profileId: string, chatId: string, fromFloor: number): void => {
  getDb()
    .prepare('UPDATE table_progress SET last_floor = ? WHERE chat_id = ? AND last_floor >= ?')
    .run(fromFloor - 1, chatId, fromFloor)
}

/** Drop every progress row for a chat (template (re)assignment/unassignment — stale pointers must
 *  never survive a schema change). Hooked in `chatService.setChatTableTemplateId`. */
export const resetProgress = (_profileId: string, chatId: string): void => {
  getDb().prepare('DELETE FROM table_progress WHERE chat_id = ?').run(chatId)
}
