import path from 'path'
import { getChat, appendFloor, truncateFloors } from './chatService'
import { editFloorTranscript, getAllFloors, getFloor } from './floorService'
import { normalizeSwipes } from './swipeHelpers'
import { loadGlobals, saveGlobals } from './templateService'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { FloorFile } from '../types/chat'
import { getPath, setPath, delPath, toParts } from '../../shared/objectPath'
import { isWritableVariablesPath } from '../../shared/agentRuntime/paths'
import {
  floorStateForChat,
  type FloorStateOperation,
  type FloorTranscriptUpdate
} from './agentRuntime/floorState'

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

/**
 * Translate an APPLIED floor-variable write into the journal operation that reproduces it on replay.
 * Floor variables belong to FloorState, so a card write is journaled (source 'card') instead of being
 * saved onto the floor row — otherwise the next Forward Replay silently discards it.
 *
 * It is a translation, not a rename, because two things differ from `applyOp`'s own write:
 *  - PATH DIALECT: `applyOp` resolves dot/bracket paths through `toParts` ("a[0].b" → a,0,b) while
 *    FloorState splits a journal path on '.', so the key is normalized through `toParts` first.
 *  - ARRAY INTERMEDIATES: replay recreates a missing OR array intermediate as a plain object
 *    (`variablesParentAt`), so a write reaching THROUGH an array cannot be journaled leaf-deep without
 *    destroying that array. Such a write is journaled at the shallowest ancestor whose chain is all
 *    plain objects, carrying that ancestor's post-write subtree as the value.
 *  - RELATIVE WRITES: `inc`/`dec` journal as `increment` (a `dec` as a negative one), so a re-fold that
 *    moves the BASE value underneath the write reproduces what the card asked for (+5) instead of the
 *    absolute it happened to observe (105). Three cases can't be expressed that way and stay a `set`,
 *    because FloorState would otherwise reject them: a non-exact (array-ancestor) path, a non-finite
 *    delta (`Number('abc')` → NaN, rejected by `validateOperation`), and a base that EXISTS but is not
 *    a finite number — `applyOp` coerces it (`Number('5') || 0`) while replay throws REPLAY_FAILED on
 *    incrementing a non-number. An ABSENT base is fine: both treat it as 0.
 *  - NO-OPS: `applyOp` is allowed to write NOTHING — an `insert` onto a key that already exists (that
 *    IS its semantic), a `set`/`inc` of the value already stored, a `del` of an absent key. Journaling
 *    the absolute `set <current value>` below for one of those would turn "leave this alone" into "pin
 *    this value": a later replay against a base that MOVED would overwrite the newer value with the
 *    stale one, inverting the operation. Nothing changed, so there is nothing to reproduce — the same
 *    guard `applyVariableOps` (generation/varsWrite.ts) applies when its deltas are all no-ops.
 * Otherwise the value is JSON round-tripped — exactly what `JSON.stringify(floor.variables)` used to
 * persist — and a value that does not survive that (undefined / a function / NaN's null) becomes a
 * `delete`, since the key simply vanished from the stored JSON before. Returns null when nothing is
 * journalable (no key — `applyOp` changed nothing either — a write that changed nothing, or a
 * reserved/invalid `variables.…` path).
 */
const journalOperation = (
  store: Record<string, any>,
  action: VarAction,
  /** The state at `action.key` BEFORE `applyOp` ran: the raw value (the increment mapping's
   *  replayability test) plus its JSON encoding, SNAPSHOTTED at capture time so the no-op guard's
   *  "before" can never turn out to be an alias of the post-write value. */
  before: { value: unknown; json: string | undefined }
): FloorStateOperation | null => {
  const parts = toParts(action.key ?? '')
  if (!parts.length) return null
  let depth = parts.length
  for (let i = 0, cursor: any = store; i < parts.length - 1; i++) {
    cursor = cursor?.[parts[i]]
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      depth = i + 1
      break
    }
  }
  const key = parts.slice(0, depth).join('.')
  const journalPath = `variables.${key}`
  if (!isWritableVariablesPath(journalPath)) return null
  // The no-op guard (see NO-OPS above). Compared at `action.key` rather than at `journalPath`: the leaf
  // is the only place a write ever lands, and `journalPath` is an ancestor of it, so the journaled
  // subtree changed exactly when the leaf did.
  if (JSON.stringify(getPath(store, action.key)) === before.json) return null
  if ((action.op === 'inc' || action.op === 'dec') && depth === parts.length) {
    const magnitude = action.value === undefined ? 1 : Number(action.value)
    const delta = action.op === 'dec' ? -magnitude : magnitude
    const replayableBase =
      before.value === undefined ||
      (typeof before.value === 'number' && Number.isFinite(before.value))
    if (Number.isFinite(delta) && replayableBase)
      return { kind: 'increment', path: journalPath, value: delta }
  }
  const encoded = JSON.stringify(getPath(store, key))
  return encoded === undefined
    ? { kind: 'delete', path: journalPath }
    : { kind: 'set', path: journalPath, value: JSON.parse(encoded) }
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
  // Captured BEFORE the write, both halves at once: an inc/dec journals as a relative `increment`,
  // which is only replayable when the base it starts from is absent or a finite number, and the JSON
  // encoding is what the no-op guard compares the post-write leaf against (see journalOperation).
  const beforeValue = action.key ? getPath(store, action.key) : undefined
  const before = { value: beforeValue, json: JSON.stringify(beforeValue) }
  const value = applyOp(store, action)
  if (action.op === 'get' || !floor) return { value, scope, store }
  // FloorState owns floors.variables: JOURNAL the write (source 'card') instead of saving the floor
  // back. A script write is not re-derivable from response text, so an unjournaled one was silently
  // discarded by the next replay (an upstream edit, an MVU re-evaluation). Journaling also republishes
  // the affected suffix, so the store returned here is the re-folded one the DB now holds.
  const operation = journalOperation(store, action, before)
  if (!operation) return { value, scope, store }
  floorStateForChat(chatId)?.append(chatId, target, 'card', [operation])
  return { value, scope, store: getFloor(profileId, chatId, target)?.variables ?? store }
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

/**
 * Edit a floor's user and/or response text in place (TH setChatMessages). Keeps the active swipe in
 * sync with the edited response.
 *
 * Routed through `floorService.editFloorTranscript` — the ONE transcript-edit operation, shared with
 * the UI edit (`updateFloorFields`) and the swipe paths — so this surface cannot carry weaker
 * guarantees than they do: the re-fold (a card rewriting a response with different `<UpdateVariable>`
 * content used to leave the OLD variables standing), the launcher summary, the memory-maintain
 * staleness fence, and the refill engine's edit signal.
 */
export const setMessage = (
  profileId: string,
  chatId: string,
  floorIndex: number,
  patch: { user?: string; response?: string }
): boolean => {
  const floor = getFloor(profileId, chatId, floorIndex)
  if (!floor) return false
  const update: FloorTranscriptUpdate = { floor: floorIndex }
  if (typeof patch.user === 'string') update.userContent = patch.user
  if (typeof patch.response === 'string') {
    const s = normalizeSwipes(floor.swipes, patch.response, floor.swipe_id)
    s.swipes[s.swipe_id] = patch.response
    update.responseContent = patch.response
    update.swipes = s.swipes
    update.swipeId = s.swipe_id
  }
  // An empty patch changed nothing, and `editFloorTranscript` owns that short-circuit: no replay (the
  // old no-op re-save of the same row), no epoch bump, no listener — and this call still reports success.
  editFloorTranscript(profileId, chatId, update)
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
  /**
   * High trust (ADR 0017) — the per-preset opt-in that lets this owner's remote-code scripts RUN.
   * DELIBERATELY WEAKER than `trusted`: it unlocks network fetch + DOM freedom INSIDE the isolated
   * WCV realm ONLY (implies `remoteScripts`), and never grants app-renderer / main / key reach. Set
   * on a `preset:<id>` grant key by `setPresetHighTrust`. "No real harm" survives as realm isolation.
   */
  highTrust?: boolean
  /** The user has made an EXPLICIT trust decision (via the import-time trust modal or the
   * legacy run-time prompt). When true the run-time script hosts must NOT re-prompt — a denial
   * is respected and a grant runs the scripts. The user can still change it from Settings → Scripts. */
  decided?: boolean
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
