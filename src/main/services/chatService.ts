import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { notifyChatModeChanged } from './chatEvents'
import { ChatSession, FloorFile, ChatMode, CHAT_MODES } from '../types/chat'
import { LorebookEntry } from '../types/character'
import { getCharacter } from './characterService'
import { getLorebookById } from './lorebookService'
import { buildInitialStatData, mergeDefaults } from './mvuSchema'
import { extractMvuSchema, schemaDefaults } from './mvuZod'
import {
  saveFloor,
  deleteFloorAndSubsequent,
  updateFloorFields,
  refreshChatSummary
} from './floorService'
import * as sessionDbService from './sessionDbService'
import { getTableTemplateById } from './tableTemplateService'
import * as tableDbService from './tableDbService'
import * as tableOpsService from './tableOpsService'
import * as tableProgressService from './tableProgressService'
import { deleteChatFully } from './chatDeleteService'
import { floorStateForChat } from './agentRuntime/floorState'

interface ChatRow {
  id: string
  character_id: string
  created_at: string
  updated_at: string
  lorebook_ids: string | null
  // Denormalized session summary (§B3), maintained by floorService.refreshChatSummary — the launcher
  // reads these off the central index instead of opening each chat's session DB. Null on a legacy/
  // pre-migration or never-written row (self-healed lazily in getChat).
  floor_count: number | null
  last_floor: number | null
  last_floor_ts: string | null
  last_user_preview: string | null
  last_response_preview: string | null
}

export const parseLorebookIds = (raw: string | null): string[] | null => {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

const touch = (chatId: string): void => {
  getDb()
    .prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), chatId)
}

/** Build the renderer-facing session object from the denormalized index row (§B3) — NO session DB is
 *  opened (the launcher lists many chats; also the perf-audit P2-6 fix: one central query, zero
 *  per-chat lookups). The latest-floor preview is precomputed by floorService. */
const buildSession = (row: ChatRow): ChatSession => ({
  id: row.id,
  character_id: row.character_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  floor_count: row.floor_count ?? 0,
  lorebook_ids: parseLorebookIds(row.lorebook_ids),
  floor_index:
    row.last_floor != null
      ? [
          {
            floor: row.last_floor,
            timestamp: row.last_floor_ts ?? row.updated_at,
            user_preview: row.last_user_preview ?? '',
            response_preview: row.last_response_preview ?? ''
          }
        ]
      : []
})

const SUMMARY_COLS =
  'floor_count, last_floor, last_floor_ts, last_user_preview, last_response_preview'

export const getChats = (profileId: string): ChatSession[] => {
  const rows = getDb()
    .prepare(
      `SELECT id, character_id, created_at, updated_at, lorebook_ids, ${SUMMARY_COLS}
       FROM chats WHERE profile_id = ? ORDER BY updated_at DESC`
    )
    .all(profileId) as ChatRow[]
  return rows.map(buildSession)
}

export const getChat = (profileId: string, chatId: string): ChatSession | null => {
  let row = getDb()
    .prepare(
      `SELECT id, character_id, created_at, updated_at, lorebook_ids, ${SUMMARY_COLS}
       FROM chats WHERE id = ? AND profile_id = ?`
    )
    .get(chatId, profileId) as ChatRow | undefined
  if (!row) return null
  // Self-heal (§B3): a legacy/pre-migration row has a null summary. Recompute it once on open (a single
  // chat, so opening its session DB is cheap) and re-read, so the list reflects it next time.
  if (row.floor_count == null) {
    refreshChatSummary(chatId)
    row =
      (getDb()
        .prepare(
          `SELECT id, character_id, created_at, updated_at, lorebook_ids, ${SUMMARY_COLS}
           FROM chats WHERE id = ? AND profile_id = ?`
        )
        .get(chatId, profileId) as ChatRow | undefined) ?? row
  }
  return buildSession(row)
}

/** The active lorebook ids for a session (null = default to the character's own lorebook). */
export const getChatLorebookIds = (profileId: string, chatId: string): string[] | null => {
  const row = getDb()
    .prepare('SELECT lorebook_ids FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { lorebook_ids: string | null } | undefined
  return row ? parseLorebookIds(row.lorebook_ids) : null
}

/** The world-info matched for the mode it was cached under (Phase H inc 2). */
export interface CachedWorldInfo {
  mode: string
  entries: LorebookEntry[]
}

/** Read the cached L2 world-info for a session, or null if absent/unparseable. */
export const getCachedWorldInfo = (profileId: string, chatId: string): CachedWorldInfo | null => {
  const row = getDb()
    .prepare('SELECT cached_world_info FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { cached_world_info: string | null } | undefined
  if (!row?.cached_world_info) return null
  try {
    const v = JSON.parse(row.cached_world_info)
    if (v && typeof v.mode === 'string' && Array.isArray(v.entries)) return v as CachedWorldInfo
  } catch {
    // fall through — treat a corrupt cache as a miss (forces a clean re-match)
  }
  return null
}

/** Store (or clear, with null) the cached L2 world-info for a session. */
export const setCachedWorldInfo = (
  profileId: string,
  chatId: string,
  value: CachedWorldInfo | null
): void => {
  getDb()
    .prepare('UPDATE chats SET cached_world_info = ? WHERE id = ? AND profile_id = ?')
    .run(value === null ? null : JSON.stringify(value), chatId, profileId)
}

/** Invalidate the cached world-info for every session in a profile — called after a
 * lorebook edit so the next turn re-matches against the updated content (otherwise the
 * stable-within-a-mode cache would hide the edit until the next transition). */
export const clearWorldInfoCacheForProfile = (profileId: string): void => {
  getDb().prepare('UPDATE chats SET cached_world_info = NULL WHERE profile_id = ?').run(profileId)
}

/** Set the active lorebook ids for a session (pass null to fall back to default). */
export const setChatLorebookIds = (
  profileId: string,
  chatId: string,
  ids: string[] | null
): void => {
  getDb()
    .prepare('UPDATE chats SET lorebook_ids = ? WHERE id = ? AND profile_id = ?')
    .run(ids === null ? null : JSON.stringify(ids), chatId, profileId)
  // The active book set changed — drop the cached match so the next turn re-scans.
  setCachedWorldInfo(profileId, chatId, null)
}

/** The active FSM mode for a session (Phase H); a missing/invalid value defaults to 'explore'. */
export const getChatMode = (profileId: string, chatId: string): ChatMode => {
  const row = getDb()
    .prepare('SELECT mode FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { mode: string | null } | undefined
  return CHAT_MODES.includes(row?.mode as ChatMode) ? (row!.mode as ChatMode) : 'explore'
}

/** Switch a session's FSM mode. Unknown values are coerced to 'explore'. Broadcasts the change
 *  so the renderer follows a MAIN-initiated switch (e.g. a workflow tool node starting combat). */
export const setChatMode = (profileId: string, chatId: string, mode: ChatMode): void => {
  const m: ChatMode = CHAT_MODES.includes(mode) ? mode : 'explore'
  getDb()
    .prepare('UPDATE chats SET mode = ? WHERE id = ? AND profile_id = ?')
    .run(m, chatId, profileId)
  notifyChatModeChanged(chatId, m)
}

/** Project Yuzu (ADR 0008 §7): is this session in VN play mode? Reads the additive `vn_mode` column
 *  (1 = on) — orthogonal to `getChatMode`'s FSM state, so it never interferes with Explore/Combat routing.
 *  A missing/NULL value is off. `isYuzuMode` is the semantic predicate the generation seams read. */
export const isYuzuMode = (profileId: string, chatId: string): boolean => {
  const row = getDb()
    .prepare('SELECT vn_mode FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { vn_mode: number | null } | undefined
  return row?.vn_mode === 1
}

/** Turn a session's VN play mode on/off (Project Yuzu). Additive; leaves the FSM `mode` untouched. */
export const setVnMode = (profileId: string, chatId: string, on: boolean): void => {
  getDb()
    .prepare('UPDATE chats SET vn_mode = ? WHERE id = ? AND profile_id = ?')
    .run(on ? 1 : 0, chatId, profileId)
}

/** The session-tier workflow override for a chat; null = inherit world/global/builtin (spec §12). */
export const getChatWorkflowId = (profileId: string, chatId: string): string | null => {
  const row = getDb()
    .prepare('SELECT workflow_id FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { workflow_id: string | null } | undefined
  return row?.workflow_id ?? null
}

/** Set (or clear, with null) the session-tier workflow override for a chat. */
export const setChatWorkflowId = (profileId: string, chatId: string, id: string | null): void => {
  getDb()
    .prepare('UPDATE chats SET workflow_id = ? WHERE id = ? AND profile_id = ?')
    .run(id, chatId, profileId)
}

/** The assigned table-template id for a chat; null = table memory off (SQL-table-memory issue 02). */
export const getChatTableTemplateId = (profileId: string, chatId: string): string | null => {
  const row = getDb()
    .prepare('SELECT table_template_id FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { table_template_id: string | null } | undefined
  return row?.table_template_id ?? null
}

/**
 * Assign (or clear, with null) a chat's table template. Both are DESTRUCTIVE to the sandbox: a new
 * id (re)instantiates the per-chat sandbox DB from the template's DDL; null removes the sandbox
 * file. The renderer confirms before calling either. A missing/invalid template id clears instead.
 */
export const setChatTableTemplateId = (
  profileId: string,
  chatId: string,
  id: string | null
): void => {
  const template = id ? getTableTemplateById(profileId, id) : null
  const effectiveId = template ? id : null
  // (Re)assignment wipes the op log + progress and re-instantiates the sandbox — destructive to the
  // same per-chat state a live refill owns. Claim the write guard by token so an assign mid-refill is
  // REFUSED (throws `tables.memoryWriteBusy`) instead of corrupting the op log under the refill's feet.
  const token = tableOpsService.beginTableWrite(chatId)
  if (token === null) throw new Error('tables.memoryWriteBusy')
  try {
    getDb()
      .prepare('UPDATE chats SET table_template_id = ? WHERE id = ? AND profile_id = ?')
      .run(effectiveId, chatId, profileId)
    // The sandbox is recreated from scratch on (re)assign/unassign, so the chat's SQL op log is stale
    // (it referenced the OLD template's tables) — clear it, or a later rewind would replay dead ops.
    tableOpsService.deleteAllOps(profileId, chatId)
    // Per-table maintenance progress pointers referenced the OLD template's tables — reset them too
    // (issue 07), so a reassigned template starts from "never processed" and cadences begin fresh.
    tableProgressService.resetProgress(profileId, chatId)
    // An INTERRUPTED refill leaves a persisted `table_refill_progress` row + a shadow file. Both refer
    // to the OLD template's tables/floors; if they survive, the workbench would offer Resume against the
    // NEW template using the stale `completedUntil`, skipping floors whose ops we just cleared. Drop the
    // progress row inline (chatService must NOT import tableRefillService — refill imports chatService,
    // so calling its resetProgress would create a cycle) and remove the shadow via tableDbService.
    sessionDbService
      .getSessionDbByChat(chatId)
      ?.prepare('DELETE FROM table_refill_progress WHERE chat_id = ?')
      .run(chatId)
    tableDbService.removeShadow(profileId, chatId)
    if (template) tableDbService.instantiate(profileId, chatId, template)
    else tableDbService.removeSandbox(profileId, chatId)
  } finally {
    tableOpsService.endTableWrite(chatId, token)
  }
}

/**
 * Every chat currently bound to a table template (SQL-table-memory). Shares the exact SELECT
 * `removeTableTemplateIdFromChats` uses; the structural-edit migration (`tableStructureService`)
 * enumerates bound chats through this so it can migrate each one's sandbox + re-baseline its op log.
 */
export const listChatIdsForTableTemplate = (profileId: string, templateId: string): string[] =>
  (
    getDb()
      .prepare('SELECT id FROM chats WHERE profile_id = ? AND table_template_id = ?')
      .all(profileId, templateId) as Array<{ id: string }>
  ).map((r) => r.id)

/** Strip a table-template id out of every session that had it assigned (called when it's deleted).
 *  Pre-checks EVERY bound chat's write guard before unbinding any: if a live refill owns one, throws
 *  `tables.memoryWriteBusy` so the template delete is refused atomically (nothing unbound) rather than
 *  half-unbinding and then failing mid-loop when `setChatTableTemplateId` hits the busy chat. */
export const removeTableTemplateIdFromChats = (profileId: string, templateId: string): void => {
  const rows = getDb()
    .prepare('SELECT id FROM chats WHERE profile_id = ? AND table_template_id = ?')
    .all(profileId, templateId) as Array<{ id: string }>
  for (const row of rows) {
    if (tableOpsService.isTableWriteBusy(row.id)) throw new Error('tables.memoryWriteBusy')
  }
  for (const row of rows) setChatTableTemplateId(profileId, row.id, null)
}

/** Clear a workflow id out of every session that had it selected (called when it's deleted). */
export const removeWorkflowIdFromChats = (profileId: string, workflowId: string): void => {
  getDb()
    .prepare('UPDATE chats SET workflow_id = NULL WHERE profile_id = ? AND workflow_id = ?')
    .run(profileId, workflowId)
}

/** Strip a lorebook id out of every session's active set (called when it's deleted). */
export const removeLorebookIdFromChats = (profileId: string, lorebookId: string): void => {
  const rows = getDb()
    .prepare('SELECT id, lorebook_ids FROM chats WHERE profile_id = ? AND lorebook_ids IS NOT NULL')
    .all(profileId) as Array<{ id: string; lorebook_ids: string | null }>
  for (const row of rows) {
    const ids = parseLorebookIds(row.lorebook_ids)
    if (ids && ids.includes(lorebookId)) {
      setChatLorebookIds(
        profileId,
        row.id,
        ids.filter((x) => x !== lorebookId)
      )
    }
  }
}

export const createChat = async (profileId: string, characterId: string): Promise<ChatSession> => {
  const now = new Date().toISOString()
  const id = uuidv4()
  // Born decentralized: session_migrated = 1 so the one-time migration (§B5) never touches it.
  getDb()
    .prepare(
      'INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, session_migrated) VALUES (?, ?, ?, ?, ?, 1)'
    )
    .run(id, profileId, characterId, now, now)

  // Seed the opening greeting (first_mes) as floor 0, with no user message.
  const card = getCharacter(profileId, characterId)
  if (card?.data.first_mes) {
    // Seed initial MVU/RPG state: native state_schema.defaults, plus (R4) a card-shipped
    // Zod data_schema's defaults extracted in the sandbox, then [initvar] entries on top.
    const ext = card.data.extensions?.rp_terminal
    let defaults: unknown = ext?.state_schema?.defaults
    if (typeof ext?.data_schema === 'string' && ext.data_schema.trim()) {
      const node = await extractMvuSchema(ext.data_schema)
      defaults = mergeDefaults(schemaDefaults(node ?? undefined), ext?.state_schema?.defaults)
    }
    const charBook = getLorebookById(profileId, characterId)
    const statData = buildInitialStatData(defaults, charBook ? [charBook] : [])

    const greeting: FloorFile = {
      floor: 0,
      chat_id: id,
      timestamp: now,
      user_message: { content: '', timestamp: now },
      response: { content: card.data.first_mes, model: '', provider: 'greeting' },
      events: [],
      variables: Object.keys(statData).length ? { stat_data: statData } : {}
    }
    floorStateForChat(id)?.setBaseline(id, greeting.variables)
    appendFloor(profileId, id, greeting)
  }

  return getChat(profileId, id) as ChatSession
}

/** Persist a floor and bump the chat's updated_at. floor_count is derived, not stored. */
export const appendFloor = (profileId: string, chatId: string, floor: FloorFile): void => {
  saveFloor(profileId, chatId, floor)
  touch(chatId)
}

/** Delete floors >= fromFloor (regenerate / edit) and bump updated_at. When table memory is on,
 *  drop the SQL ops at/after the cut and rebuild the sandbox by ordered replay of the survivors
 *  (issue 03 rewind hook). Cheap no-op when no template is assigned. */
export const truncateFloors = (profileId: string, chatId: string, fromFloor: number): void => {
  deleteFloorAndSubsequent(profileId, chatId, fromFloor)
  // FloorState already removed general and legacy variable operations in the same transaction as
  // the floors. Table-memory journals remain a separate store and rebuild boundary.
  const templateId = getChatTableTemplateId(profileId, chatId)
  if (templateId) {
    tableOpsService.deleteOpsFrom(profileId, chatId, fromFloor)
    const template = getTableTemplateById(profileId, templateId)
    tableOpsService.rebuildSandbox(profileId, chatId, template)
    // Rewind clamp (issue 07): pull every per-table progress pointer at/after the cut back to
    // fromFloor - 1, so cadences resume immediately instead of stalling on an overshot pointer.
    tableProgressService.clampProgress(profileId, chatId, fromFloor)
  }
  touch(chatId)
}

// Centralized per-chat teardown (FK-cascade rows + non-cascading chat-keyed tables + per-chat files)
// lives in the leaf `chatDeleteService` so characterService/profileService reuse the SAME cleanup
// without importing chatService (which would cycle — chatService imports characterService).
export const deleteChat = (profileId: string, chatId: string): void => {
  deleteChatFully(profileId, chatId)
}

/** Edit a floor's user message and/or response text, then bump updated_at. */
export const editFloorContent = (
  profileId: string,
  chatId: string,
  floorIndex: number,
  userContent: string | null,
  responseContent: string | null
): void => {
  updateFloorFields(profileId, chatId, floorIndex, userContent, responseContent)
  touch(chatId)
}
