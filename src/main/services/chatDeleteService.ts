import { getDb } from './db'
import * as tableDbService from './tableDbService'
import * as notesMemoryService from './notesMemoryService'

/**
 * Delete ALL persisted state for one chat — the single centralized teardown reused by
 * `chatService.deleteChat`, `characterService.deleteCharacter`, and `profileService.wipeProfile`,
 * so no delete path can drift and leave orphaned rows/files (performance-audit P1-8).
 *
 * This lives in a LEAF module (imports only `db` + the two per-chat file services) precisely to
 * stay OFF the `chatService ↔ characterService` import edge: `chatService` already imports
 * `characterService` (`getCharacter`), so making `characterService` import `chatService` would form
 * a dependency cycle. All three callers import THIS instead — cycle-free.
 *
 * DB rows go in one transaction. Deleting the `chats` row FK-cascades the tables that REFERENCE
 * `chats(id) ON DELETE CASCADE` (foreign_keys is ON — see db.ts): `floors`, `combat_encounters`,
 * `node_state`, `table_ops`, `vars_ops`, `table_progress`, `table_refill_progress`. The chat-keyed
 * tables that carry NO foreign key never cascade, so they are deleted explicitly:
 *   - `workflow_run_history`     (chat_id NOT NULL; decoupled from chat lifecycle by design — ADR 0003)
 *   - `workflow_trigger_state`   (chat_id NOT NULL)
 *   - `agent_pack_trigger_state` (chat_id NOT NULL)
 *   - `agent_pack_activation`    (only the per-chat EXCEPTION rows — chat_id set; the WORLD-scope rows
 *                                 have chat_id NULL and MUST survive, so `WHERE chat_id = ?` is exact)
 *
 * File-based per-chat state lives OUTSIDE the app DB and cannot be transactional, so it is removed
 * AFTER the DB commit: the table sandbox, its refill shadow, and the plot-recall notes file. Each
 * removal is individually idempotent (a missing file is a no-op).
 */
export const deleteChatFully = (profileId: string, chatId: string): void => {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM workflow_run_history WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM workflow_trigger_state WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM agent_pack_trigger_state WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM agent_pack_activation WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
  })()
  tableDbService.removeSandbox(profileId, chatId)
  tableDbService.removeShadow(profileId, chatId)
  notesMemoryService.removeNotes(profileId, chatId)
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
    getDb()
      .prepare('SELECT id FROM chats WHERE profile_id = ?')
      .all(profileId) as Array<{ id: string }>
  ).map((r) => r.id)
