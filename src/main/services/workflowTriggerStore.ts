// Per-trigger evaluation baselines for the DOC-DRIVEN headless path (one-canvas rebuild WP6.1; ADR
// 0011). The sibling of agentPackTriggerStore — SAME columns + semantics, DIFFERENT key.
//
// WHY A SIBLING TABLE (not new rows in agent_pack_trigger_state). The pack store keys by
// (chat_id, pack_id, trigger_index) — a POSITIONAL integer index into a fragment's attachments array.
// The doc path keys by (chat_id, doc_id, trigger_node_id) — a STABLE STRING node id, which is strictly
// better (re-ordering nodes never re-associates baselines, unlike the pack path's positional caveat).
// A string node id cannot go in the pack store's INTEGER trigger_index column, and the pack path's
// rows must stay UNTOUCHED while both paths coexist (WP6.1 hard constraint). So the doc path gets its
// own table; pack-era baselines are entirely independent and unaffected.
//
// Same two stateful kinds carry baselines across commit boundaries (attachments.ts grammar):
//  · `changedBy` retains `lastValue` (the numeric source reading at the previous evaluation);
//  · `cadence`   retains `lastFireFloor` (the 0-based floor index it last fired at).
//
// SQLite stance mirrors agentPackTriggerStore: thin getDb() wrappers, runtime-validated only (the
// native binary can't load under Node; the store returns empty rows under the alias stub, and the
// SERVICE logic that consumes it is unit-tested by mocking this module).

import { getSessionDbByChat } from './sessionDbService'
import { TriggerState } from './agentPackTriggerStore'

export type { TriggerState }

/** Read one doc-trigger's retained state, or null when there is no row (first ever evaluation). */
export const getDocTriggerState = (
  chatId: string,
  docId: string,
  nodeId: string
): TriggerState | null => {
  const db = getSessionDbByChat(chatId)
  if (!db) return null
  const row = db
    .prepare(
      'SELECT last_value, last_fire_floor FROM workflow_trigger_state WHERE chat_id = ? AND doc_id = ? AND node_id = ?'
    )
    .get(chatId, docId, nodeId) as
    | { last_value: number | null; last_fire_floor: number | null }
    | undefined
  if (!row) return null
  return {
    lastValue: row.last_value ?? null,
    lastFireFloor: row.last_fire_floor ?? null
  }
}

/** Upsert the changedBy baseline (`lastValue`), preserving any cadence column. */
export const setDocTriggerLastValue = (
  chatId: string,
  docId: string,
  nodeId: string,
  lastValue: number
): void => {
  getSessionDbByChat(chatId)
    ?.prepare(
      `INSERT INTO workflow_trigger_state (chat_id, doc_id, node_id, last_value, last_fire_floor)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(chat_id, doc_id, node_id) DO UPDATE SET last_value = excluded.last_value`
    )
    .run(chatId, docId, nodeId, lastValue)
}

/** Upsert the cadence baseline (`lastFireFloor`), preserving any changedBy column. */
export const setDocTriggerLastFireFloor = (
  chatId: string,
  docId: string,
  nodeId: string,
  lastFireFloor: number
): void => {
  getSessionDbByChat(chatId)
    ?.prepare(
      `INSERT INTO workflow_trigger_state (chat_id, doc_id, node_id, last_value, last_fire_floor)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(chat_id, doc_id, node_id) DO UPDATE SET last_fire_floor = excluded.last_fire_floor`
    )
    .run(chatId, docId, nodeId, lastFireFloor)
}
