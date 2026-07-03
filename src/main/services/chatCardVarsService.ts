// Per-chat, card-scoped key/value store (TavernHelper getVariables({type:'chat'})). A general bag for any
// card's per-session UI state — NOT MVU stat_data (never schema-validated/stripped). One per-profile JSON
// keyed by chatId; whole-object set semantics. Cards must namespace their keys (e.g. party.members).
import path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { withLock } from './asyncLock'
import { varsLockKey } from './floorService'

type AllChats = Record<string, Record<string, any>>

const filePath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chat-card-vars.json')

const loadAll = (profileId: string): AllChats =>
  readJsonSync<AllChats>(filePath(profileId)) || {}

export const getChatCardVars = (profileId: string, chatId: string): Record<string, any> => {
  const all = loadAll(profileId)
  const v = all[chatId]
  return v && typeof v === 'object' ? v : {}
}

/** Whole-object write of the chat's per-session KV bag (synchronous). Serialized per chat through the
 *  vars lock (WP1.5 / ADR 0003) on the SAME `vars:<chatId>` key as floor writes, so the session-KV
 *  read-modify-write pattern (`getChatCardVars` → mutate → `setChatCardVars`, e.g. vars.save session
 *  scope, the party-panel WCV host, the WCV IPC vars write) can't lose an update under concurrency.
 *  The lock's fast path runs a single writer synchronously, so existing behavior is unchanged; the
 *  returned promise is not awaited to preserve the `void` (synchronous) contract. */
export const setChatCardVars = (
  profileId: string,
  chatId: string,
  vars: Record<string, any>
): void => {
  void withLock(varsLockKey(chatId), () => {
    try {
      const all = loadAll(profileId)
      all[chatId] = vars && typeof vars === 'object' ? vars : {}
      writeJsonSyncAtomic(filePath(profileId), all)
    } catch {
      /* non-fatal — UI state */
    }
  })
}
