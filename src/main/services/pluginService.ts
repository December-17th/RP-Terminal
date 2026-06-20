import path from 'path'
import { getChat } from './chatService'
import { getAllFloors, getFloor, saveFloor } from './floorService'
import { loadGlobals, saveGlobals } from './templateService'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'

/**
 * Host-side engine bridge for the P1 card-script runtime. Card scripts run in a
 * sandboxed (opaque-origin) iframe in the renderer and reach the engine only
 * through permission-checked IPC that lands here. Everything is additive: var
 * ops reuse the existing floor.variables / template-globals model so script
 * state stays coherent with the status-panel widgets and the next generation.
 *
 * Clean-room: this is our own API surface, not derived from js-slash-runner.
 */

// --- dot/bracket path get/set (parity with templateService's variable engine;
// duplicated deliberately to keep the two process-boundary helpers independent). ---
const toParts = (p: string): string[] =>
  String(p)
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)

const getPath = (obj: any, p: string | null | undefined): any => {
  if (p == null || p === '') return obj
  let cur = obj
  for (const part of toParts(p)) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

const setPath = (obj: any, p: string, val: any): void => {
  const parts = toParts(p)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = val
}

const delPath = (obj: any, p: string): void => {
  const parts = toParts(p)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return
    cur = cur[parts[i]]
  }
  if (cur) delete cur[parts[parts.length - 1]]
}

export type VarScope = 'local' | 'global'
export type VarOp = 'get' | 'set' | 'inc' | 'dec' | 'del'

export interface VarAction {
  op: VarOp
  scope?: VarScope
  key?: string
  value?: any
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

/** Read/mutate a chat-local (latest floor) or global variable. */
export const pluginVars = (profileId: string, chatId: string, action: VarAction): VarResult => {
  const scope: VarScope = action.scope === 'global' ? 'global' : 'local'

  if (scope === 'global') {
    const globals = loadGlobals(profileId)
    const value = applyOp(globals, action)
    if (action.op !== 'get') saveGlobals(profileId, globals)
    return { value, scope, store: globals }
  }

  // Local scope lives on the latest floor's variables — the same object the
  // status widgets read and the next generation seeds from.
  const chat = getChat(profileId, chatId)
  const count = chat?.floor_count ?? 0
  if (count === 0) return { value: undefined, scope, store: {} }

  const floor = getFloor(profileId, chatId, count - 1)
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

// --- Per-card permission grants (file-based, per profile) ---
// Card scripts use the card id as their plugin identity. Low-risk capabilities
// (vars, chat:read, ui) are auto-granted by the host; only sensitive ones
// (currently `generate`) are recorded here after a user prompt. `enabled`
// lets the user switch a card's scripts off entirely.
export interface CardGrants {
  enabled?: boolean
  generate?: boolean
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
