import path from 'path'
import { getChat, appendFloor, truncateFloors } from './chatService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import { loadGlobals, saveGlobals } from './templateService'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { FloorFile } from '../types/chat'
import { getPath, setPath, delPath } from '../../shared/objectPath'

/**
 * Host-side engine bridge for the P1 card-script runtime. Card scripts run in a
 * sandboxed (opaque-origin) iframe in the renderer and reach the engine only
 * through permission-checked IPC that lands here. Everything is additive: var
 * ops reuse the existing floor.variables / template-globals model so script
 * state stays coherent with the status-panel widgets and the next generation.
 *
 * Clean-room: this is our own API surface, not derived from js-slash-runner.
 */

// dot/bracket var get/set/del live in the shared objectPath module

export type VarScope = 'local' | 'global' | 'message' | 'character'
export type VarOp = 'get' | 'set' | 'inc' | 'dec' | 'del' | 'insert'

export interface VarAction {
  op: VarOp
  scope?: VarScope
  key?: string
  value?: any
  /** For scope 'message': the floor index to target (defaults to the latest floor). */
  messageId?: number
  /** For scope 'character': the card id whose persistent vars to read/mutate. */
  cardId?: string
}

export interface VarResult {
  value: any
  scope: VarScope
  /** The full store after the op, so the renderer can sync widgets live. */
  store: Record<string, any>
}

const applyOp = (store: Record<string, any>, action: VarAction): any => {
  const { op, key, value } = action
  switch (op) {
    case 'get':
      return key ? getPath(store, key) : store
    case 'set':
      if (key) setPath(store, key, value)
      return value
    case 'insert':
      // Insert-or-keep: only writes when the key is currently absent (TH insertVariables).
      if (key && getPath(store, key) === undefined) setPath(store, key, value)
      return key ? getPath(store, key) : undefined
    case 'inc': {
      if (!key) return undefined
      const n = (Number(getPath(store, key)) || 0) + (value === undefined ? 1 : Number(value))
      setPath(store, key, n)
      return n
    }
    case 'dec': {
      if (!key) return undefined
      const n = (Number(getPath(store, key)) || 0) - (value === undefined ? 1 : Number(value))
      setPath(store, key, n)
      return n
    }
    case 'del':
      if (key) delPath(store, key)
      return undefined
    default:
      return undefined
  }
}

// Character-scoped vars persist per card across all its sessions (TH-2). File-keyed by
// card id, alongside the per-profile template globals.
const characterVarsPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'character-vars.json')

const loadCharacterVars = (profileId: string): Record<string, Record<string, any>> =>
  readJsonSync<Record<string, Record<string, any>>>(characterVarsPath(profileId)) || {}

const saveCharacterVars = (profileId: string, all: Record<string, Record<string, any>>): void => {
  try {
    writeJsonSyncAtomic(characterVarsPath(profileId), all)
  } catch {
    /* non-fatal */
  }
}

/**
 * Read/mutate a variable in one of four scopes (TH-2):
 *  - `global`    — per-profile template globals.
 *  - `local`     — the latest floor's variables (drives the status widgets).
 *  - `message`   — a specific floor's variables (`action.messageId`, default = latest).
 *  - `character` — per-card vars persisted across sessions (`action.cardId`).
 * (The `script` scope maps to per-owner storage in the shim, not here.)
 */
export const pluginVars = (profileId: string, chatId: string, action: VarAction): VarResult => {
  const scope: VarScope =
    action.scope === 'global' || action.scope === 'message' || action.scope === 'character'
      ? action.scope
      : 'local'

  if (scope === 'global') {
    const globals = loadGlobals(profileId)
    const value = applyOp(globals, action)
    if (action.op !== 'get') saveGlobals(profileId, globals)
    return { value, scope, store: globals }
  }

  if (scope === 'character') {
    const cardId = action.cardId
    if (!cardId) return { value: undefined, scope, store: {} }
    const all = loadCharacterVars(profileId)
    const store = all[cardId] || {}
    const value = applyOp(store, action)
    if (action.op !== 'get') {
      all[cardId] = store
      saveCharacterVars(profileId, all)
    }
    return { value, scope, store }
  }

  // local / message both live on a floor's variables — the same object the status
  // widgets read and the next generation seeds from. local = latest; message = by id.
  const chat = getChat(profileId, chatId)
  const count = chat?.floor_count ?? 0
  if (count === 0) return { value: undefined, scope, store: {} }
  const target =
    scope === 'message' && typeof action.messageId === 'number' ? action.messageId : count - 1

  const floor = getFloor(profileId, chatId, target)
  const store: Record<string, any> = floor?.variables ?? {}
  const value = applyOp(store, action)
  if (action.op !== 'get' && floor) {
    floor.variables = store
    saveFloor(profileId, chatId, floor)
  }
  return { value, scope, store }
}

/** Snapshot both variable scopes for a chat (script init). */
export const getVars = (
  profileId: string,
  chatId: string
): { local: Record<string, any>; global: Record<string, any> } => {
  const chat = getChat(profileId, chatId)
  const count = chat?.floor_count ?? 0
  const local = count > 0 ? (getFloor(profileId, chatId, count - 1)?.variables ?? {}) : {}
  return { local, global: loadGlobals(profileId) }
}

/** Whole-object read/write of the per-profile global vars (template-globals.json) — the
 *  TavernHelper getVariables/replaceVariables({type:'global'}) counterpart, shared by both card
 *  transports and the Variables panel's "全局变量" tab. Per-key ops still go through pluginVars. */
export const getGlobalVars = (profileId: string): Record<string, any> => loadGlobals(profileId)
export const setGlobalVars = (profileId: string, vars: Record<string, any>): void =>
  saveGlobals(profileId, vars && typeof vars === 'object' ? vars : {})

export interface PluginMessage {
  floor: number
  user: string
  response: string
}

/** Read-only chat transcript for `rpt.chat.getMessages()`. */
export const getMessages = (profileId: string, chatId: string): PluginMessage[] => {
  const chat = getChat(profileId, chatId)
  if (!chat) return []
  return getAllFloors(profileId, chatId, chat.floor_count).map((f) => ({
    floor: f.floor,
    user: f.user_message.content,
    response: f.response.content
  }))
}

/** Edit a floor's user and/or response text in place (TH setChatMessages). Keeps the
 *  active swipe in sync with the edited response. */
export const setMessage = (
  profileId: string,
  chatId: string,
  floorIndex: number,
  patch: { user?: string; response?: string }
): boolean => {
  const floor = getFloor(profileId, chatId, floorIndex)
  if (!floor) return false
  if (typeof patch.user === 'string') floor.user_message.content = patch.user
  if (typeof patch.response === 'string') {
    floor.response.content = patch.response
    const s = normalizeSwipes(floor.swipes, patch.response, floor.swipe_id)
    s.swipes[s.swipe_id] = patch.response
    floor.swipes = s.swipes
    floor.swipe_id = s.swipe_id
  }
  saveFloor(profileId, chatId, floor)
  return true
}

/** Delete a floor and everything after it (TH deleteChatMessages). */
export const deleteMessages = (profileId: string, chatId: string, fromIndex: number): boolean => {
  truncateFloors(profileId, chatId, Math.max(0, fromIndex))
  return true
}

/** Append a new floor (TH createChatMessages — append only; mid-history insert is not
 *  supported by the floor model). Returns the new floor index, or -1 on failure. */
export const createMessage = (
  profileId: string,
  chatId: string,
  msg: { user?: string; response?: string }
): number => {
  const chat = getChat(profileId, chatId)
  if (!chat) return -1
  const now = new Date().toISOString()
  const floor: FloorFile = {
    floor: chat.floor_count,
    chat_id: chatId,
    timestamp: now,
    user_message: { content: msg.user || '', timestamp: now },
    response: { content: msg.response || '', model: '', provider: '' },
    events: [],
    // Carry the running state forward so widgets/next-turn seeding stay coherent.
    variables:
      chat.floor_count > 0
        ? (getFloor(profileId, chatId, chat.floor_count - 1)?.variables ?? {})
        : {}
  }
  appendFloor(profileId, chatId, floor)
  return floor.floor
}

// --- Per-card permission grants (file-based, per profile) ---
// Card scripts use the card id as their plugin identity. Low-risk capabilities
// (vars, chat:read, ui) are auto-granted by the host; only sensitive ones
// (currently `generate`) are recorded here after a user prompt. `enabled`
// lets the user switch a card's scripts off entirely.
export interface CardGrants {
  enabled?: boolean
  generate?: boolean
  /** Allow this world's scripts to load code from the internet (remote import directives). */
  remoteScripts?: boolean
  /** Full trust: run this world's own frames (card scripts + its frontend cards) with a
   * real (same-origin) origin so native ES-module imports / ST-style runtime work. Implies
   * the frame can reach the app (incl. API keys) — only for a world whose card you trust.
   * Scoped to the world card's scripts + what they import. */
  trusted?: boolean
}

const grantsPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'plugin-grants.json')

const readAllGrants = (profileId: string): Record<string, CardGrants> =>
  readJsonSync<Record<string, CardGrants>>(grantsPath(profileId)) || {}

export const getGrants = (profileId: string, cardId: string): CardGrants =>
  readAllGrants(profileId)[cardId] || {}

export const setGrants = (profileId: string, cardId: string, patch: CardGrants): CardGrants => {
  const all = readAllGrants(profileId)
  const merged = { ...(all[cardId] || {}), ...patch }
  all[cardId] = merged
  try {
    writeJsonSyncAtomic(grantsPath(profileId), all)
  } catch {
    /* non-fatal — grants are a convenience cache */
  }
  return merged
}
