// Per-chat, card-scoped key/value store (TavernHelper getVariables({type:'chat'})). A general bag for any
// card's per-session UI state — NOT MVU stat_data (never schema-validated/stripped). Whole-object set
// semantics; cards must namespace their keys (e.g. party.members).
//
// Stored as one JSON file PER CHAT inside the session store: `profiles/<id>/chats/<chatId>/session-vars.json`
// (decentralize-save-system §B1; migrated from the legacy shared `chat-card-vars.json` in §B5). The split
// also fixes a latent lost-update race the old shared file had: the write locked per CHAT but rewrote the
// whole PROFILE file, so two chats writing concurrently could drop each other's update. A per-chat file
// under the same per-chat lock cannot.
import path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { withLock } from './asyncLock'
import { varsLockKey } from './floorService'

const varsFilePath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chats', chatId, 'session-vars.json')

export const getChatCardVars = (profileId: string, chatId: string): Record<string, any> => {
  const v = readJsonSync<Record<string, any>>(varsFilePath(profileId, chatId))
  return v && typeof v === 'object' ? v : {}
}

/** Whole-object write of the chat's per-session KV bag (synchronous). Serialized per chat through the
 *  vars lock (WP1.5 / ADR 0003) on the SAME `vars:<chatId>` key as floor writes, so the read-modify-write
 *  pattern (`getChatCardVars` → mutate → `setChatCardVars`, e.g. vars.save session scope, the party-panel
 *  WCV host, the WCV IPC vars write) can't lose an update. The lock's fast path runs a single writer
 *  synchronously, so behavior is unchanged; the promise is not awaited (preserving the `void` contract). */
export const setChatCardVars = (
  profileId: string,
  chatId: string,
  vars: Record<string, any>
): void => {
  void withLock(varsLockKey(chatId), () => {
    try {
      writeJsonSyncAtomic(
        varsFilePath(profileId, chatId),
        vars && typeof vars === 'object' ? vars : {}
      )
    } catch {
      /* non-fatal — UI state */
    }
  })
}
