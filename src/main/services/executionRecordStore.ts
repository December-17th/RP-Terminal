import { getSessionDbByChat } from './sessionDbService'
import { getFloorRequest } from './floorService'
import { ExecutionRecord, RecordMessage, RecordRole } from '../../shared/executionRecord'

/**
 * Per-chat persistence for the forensic Execution Record (st-preset-compat issue 09 / PLAN decision
 * 13). One record per generation, keyed to the FLOOR it explains, stored in that chat's SESSION db
 * (`execution_records`, DDL in sessionDbService.SESSION_SCHEMA) — never the central index.
 *
 * DEDUP (issue 07 measurement): the record's `wire` is ~41 KiB of a ~42.5 KiB record and is
 * byte-identical to the wire floor persistence ALREADY stores in the floor's `request` column. We do
 * NOT double-store it: `wire` is STRIPPED before serialization here and REHYDRATED from
 * `getFloorRequest` on read, so the whole prompt lives once per floor.
 *
 * RETENTION: a rolling window of the most-recent N generations per chat (default 50, configurable —
 * settings.records.retention). `saveExecutionRecord` prunes past the cap after every write.
 *
 * This is the persistence + retrieval surface only. There is no browsing UI yet (a future inspector),
 * and no determinism capture (RNG / state snapshots are deferred, PLAN decision 13).
 */

/** The record as persisted: everything EXCEPT `wire` (rehydrated on read from the floor's request). */
export type StoredExecutionRecord = Omit<ExecutionRecord, 'wire'>

const stripWire = (record: ExecutionRecord): StoredExecutionRecord => {
  // Never persist the wire — it duplicates the floor's stored `request` (dedup). Everything else
  // (version / createdAt / the ordered entries journal / stats) is the forensic delta we keep.
  const { wire: _wire, ...delta } = record
  return delta
}

/**
 * Persist one generation's execution record (wire stripped) keyed to its floor, then prune to the
 * rolling retention window. Upserts so a regenerate of the same floor replaces its record. No-op when
 * the chat has no session store (deleted mid-write / the vitest no-op sqlite mock).
 */
export const saveExecutionRecord = (
  chatId: string,
  floor: number,
  record: ExecutionRecord,
  retention: number
): void => {
  const db = getSessionDbByChat(chatId)
  if (!db) return
  db.prepare(
    `INSERT INTO execution_records (chat_id, floor, created_at, record)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, floor) DO UPDATE SET
       created_at = excluded.created_at,
       record = excluded.record`
  ).run(chatId, floor, record.createdAt, JSON.stringify(stripWire(record)))
  pruneExecutionRecords(chatId, retention)
}

/**
 * Keep only the `retention` most-recent records (by floor) for a chat; delete the rest. `retention`
 * <= 0 prunes ALL of them (the "off" setting). Robust to floor gaps: it ranks by the floors that
 * actually have records, not by an assumed contiguous range.
 */
export const pruneExecutionRecords = (chatId: string, retention: number): void => {
  const db = getSessionDbByChat(chatId)
  if (!db) return
  const keep = Math.max(0, Math.floor(retention))
  if (keep <= 0) {
    db.prepare('DELETE FROM execution_records WHERE chat_id = ?').run(chatId)
    return
  }
  db.prepare(
    `DELETE FROM execution_records
       WHERE chat_id = ?
         AND floor NOT IN (
           SELECT floor FROM execution_records WHERE chat_id = ? ORDER BY floor DESC LIMIT ?
         )`
  ).run(chatId, chatId, keep)
}

const asRecordRole = (r: string): RecordRole =>
  r === 'user' || r === 'assistant' ? r : 'system'

/**
 * Read one generation's execution record, rehydrating `wire` from the floor's stored `request` (the
 * dedup counterpart to save). Returns null when no record is stored for that floor. When the record
 * outlived its floor (e.g. an aborted generation, or the floor was truncated), `wire` rehydrates to
 * `[]` — the forensic entries/stats are still returned.
 */
export const getExecutionRecord = (
  profileId: string,
  chatId: string,
  floor: number
): ExecutionRecord | null => {
  const db = getSessionDbByChat(chatId)
  if (!db) return null
  const row = db
    .prepare('SELECT record FROM execution_records WHERE chat_id = ? AND floor = ?')
    .get(chatId, floor) as { record: string } | undefined
  if (!row) return null
  let stored: StoredExecutionRecord
  try {
    stored = JSON.parse(row.record) as StoredExecutionRecord
  } catch {
    return null
  }
  const request = getFloorRequest(profileId, chatId, floor) ?? []
  const wire: RecordMessage[] = request.map((m) => ({
    role: asRecordRole(m.role),
    content: m.content
  }))
  return { ...stored, wire }
}

/**
 * The floors (ascending) that currently have a persisted execution record for this chat — for a
 * future record inspector to enumerate the retained window. Cheap PK-only scan.
 */
export const listExecutionRecordFloors = (chatId: string): number[] => {
  const db = getSessionDbByChat(chatId)
  if (!db) return []
  const rows = db
    .prepare('SELECT floor FROM execution_records WHERE chat_id = ? ORDER BY floor')
    .all(chatId) as Array<{ floor: number }>
  return rows.map((r) => r.floor)
}
