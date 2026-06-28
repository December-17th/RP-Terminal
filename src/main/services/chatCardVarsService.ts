// Per-chat, card-scoped key/value store (TavernHelper getVariables({type:'chat'})). A general bag for any
// card's per-session UI state — NOT MVU stat_data (never schema-validated/stripped). One per-profile JSON
// keyed by chatId; whole-object set semantics. Cards must namespace their keys (e.g. party.members).
import path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'

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

export const setChatCardVars = (
  profileId: string,
  chatId: string,
  vars: Record<string, any>
): void => {
  try {
    const all = loadAll(profileId)
    all[chatId] = vars && typeof vars === 'object' ? vars : {}
    writeJsonSyncAtomic(filePath(profileId), all)
  } catch {
    /* non-fatal — UI state */
  }
}
