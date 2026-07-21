import { getDb } from './db'
import * as sessionDbService from './sessionDbService'
import { agentRunStore } from './agentRuntime/runs/AgentRunStore'

/**
 * Delete ALL persisted state for one chat — the single centralized teardown reused by
 * `chatService.deleteChat`, `characterService.deleteCharacter`, and `profileService.wipeProfile`,
 * so no delete path can drift and leave orphaned rows/files (performance-audit P1-8).
 *
 * This lives in a LEAF module (imports only `db` + the session-store service) precisely to stay OFF
 * the `chatService ↔ characterService` import edge: `chatService` already imports
 * `characterService` (`getCharacter`), so making `characterService` import `chatService` would form
 * a dependency cycle. All three callers import THIS instead — cycle-free.
 *
 * Under the decentralized save layout (§B), a chat's floors/ops/combat/node_state/tables/notes live
 * in its per-session store FOLDER, removed as a unit after the DB commit. What remains CENTRAL are
 * the chat-keyed rows that carry no foreign key (§B0 exceptions — cross-scope / pack-library-coupled),
 * deleted explicitly in one transaction:
 *   - `workflow_run_history`     (chat_id NOT NULL; decoupled from chat lifecycle by design — ADR 0003)
 *   - `workflow_trigger_state`   (chat_id NOT NULL; doc-trigger baselines)
 *   - `agent_pack_trigger_state` (chat_id NOT NULL)
 *   - `agent_pack_activation`    (only the per-chat EXCEPTION rows — chat_id set; the WORLD-scope rows
 *                                 have chat_id NULL and MUST survive, so `WHERE chat_id = ?` is exact)
 *   - `agent_pack_overrides`     (only the `chat:<id>` scope rows — world/profile scopes survive)
 *
 * `sessionDbService.removeSession` closes the cached handle first (Windows file locks) then removes
 * the folder + WAL sidecars (§B4); it is idempotent for a chat that never had a session store.
 */
export const deleteChatFully = (profileId: string, chatId: string): void => {
  // Abort live invocations before removing the owning session folder; this also emits deletion
  // edges so renderer activity cannot remain stuck on a chat that no longer exists.
  agentRunStore.deleteChatForProfile(profileId, chatId)
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM workflow_run_history WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM workflow_trigger_state WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM agent_pack_trigger_state WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM agent_pack_activation WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM agent_pack_overrides WHERE scope = ?').run(`chat:${chatId}`)
    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
  })()
  sessionDbService.removeSession(profileId, chatId)
}

/** The chat ids belonging to a character (for centralized cascade on character deletion). */
export const chatIdsForCharacter = (profileId: string, characterId: string): string[] =>
  (
    getDb()
      .prepare('SELECT id FROM chats WHERE character_id = ? AND profile_id = ?')
      .all(characterId, profileId) as Array<{ id: string }>
  ).map((r) => r.id)

/** The chat ids belonging to a profile (for centralized cascade on profile wipe). */
export const chatIdsForProfile = (profileId: string): string[] =>
  (
    getDb().prepare('SELECT id FROM chats WHERE profile_id = ?').all(profileId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
