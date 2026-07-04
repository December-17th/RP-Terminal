// Per-trigger evaluation baselines for the headless runner (agent-packs plan WP2.2; ADR 0004).
//
// Two trigger kinds carry state ACROSS commit boundaries (attachments.ts grammar block):
//  · `changedBy` — the delta op fires on (currentValue − valueAtLastEvaluation) >= delta, so the
//    runner retains `lastValue` (the numeric source reading at the previous evaluation) here.
//  · `cadence`   — fires every N floors, so the runner retains `lastFireFloor` (the 0-based floor
//    index it last fired at) here; the next fire needs currentFloorIndex − lastFireFloor >= N.
//
// Keyed per (chat, pack, trigger index): a pack is evaluated independently in each chat it is gated
// open for, so baselines are PER CHAT (ADR 0004 chains + the flagship world-sim example both scope
// state to a chat). `triggerIndex` is the position in the fragment's `attachments` array.
//
// SQLite surface — mirrors agentPackStore's stance: thin getDb() wrappers, runtime-validated only
// (the native better-sqlite3 binary can't load under plain Node, so the store returns empty rows
// under the alias stub; the SERVICE logic that consumes it is unit-tested by mocking this module).

import { getDb } from './db'

/** One trigger's retained baseline. Absent columns (null) mean "never evaluated / never fired". */
export interface TriggerState {
  /** The numeric source reading at the previous evaluation (changedBy). null = never evaluated. */
  lastValue: number | null
  /** The 0-based floor index this cadence trigger last fired at. null = never fired. */
  lastFireFloor: number | null
}

/** Read one trigger's retained state, or null when there is no row (first ever evaluation). */
export const getTriggerState = (
  chatId: string,
  packId: string,
  triggerIndex: number
): TriggerState | null => {
  const row = getDb()
    .prepare(
      'SELECT last_value, last_fire_floor FROM agent_pack_trigger_state WHERE chat_id = ? AND pack_id = ? AND trigger_index = ?'
    )
    .get(chatId, packId, triggerIndex) as
    | { last_value: number | null; last_fire_floor: number | null }
    | undefined
  if (!row) return null
  return {
    lastValue: row.last_value ?? null,
    lastFireFloor: row.last_fire_floor ?? null
  }
}

/** Upsert the changedBy baseline (`lastValue`) for a trigger, preserving any cadence column. */
export const setTriggerLastValue = (
  chatId: string,
  packId: string,
  triggerIndex: number,
  lastValue: number
): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_pack_trigger_state (chat_id, pack_id, trigger_index, last_value, last_fire_floor)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(chat_id, pack_id, trigger_index) DO UPDATE SET last_value = excluded.last_value`
    )
    .run(chatId, packId, triggerIndex, lastValue)
}

/** Upsert the cadence baseline (`lastFireFloor`) for a trigger, preserving any changedBy column. */
export const setTriggerLastFireFloor = (
  chatId: string,
  packId: string,
  triggerIndex: number,
  lastFireFloor: number
): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_pack_trigger_state (chat_id, pack_id, trigger_index, last_value, last_fire_floor)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(chat_id, pack_id, trigger_index) DO UPDATE SET last_fire_floor = excluded.last_fire_floor`
    )
    .run(chatId, packId, triggerIndex, lastFireFloor)
}

/** Delete EVERY retained trigger baseline for a pack (across all chats). Called on uninstall so a
 *  pack's per-(chat, trigger) baselines don't outlive its library row (agentPackStore.deletePack
 *  already prunes the activation + override rows; this is the third table keyed by pack_id, which that
 *  helper does NOT reach — the store lives in a different module). Idempotent — a no-op when a pack
 *  never fired a stateful trigger. */
export const deleteTriggerStateForPack = (packId: string): void => {
  getDb().prepare('DELETE FROM agent_pack_trigger_state WHERE pack_id = ?').run(packId)
}
