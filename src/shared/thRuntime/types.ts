// src/shared/thRuntime/types.ts
import type { VarOp } from './ops'
import type { TavernRegex } from './tavernRegex'

export type CardCtx = { profileId: string; chatId: string; characterId: string }

/**
 * Origin of a stat_data change, tagged end-to-end so the runtime can fire MVU events faithfully.
 * Real MVU emits `mag_variable_update_*` only on the AI-message FOLD, never on programmatic card
 * writes — so `onVarsChanged` still refreshes the runtime cache for a `card-write`, but the runtime
 * suppresses the MVU/MESSAGE_UPDATED emits for it (that self-echo is what caused the WS-3 write-back
 * loop). `model-fold` = an AI turn folded new variables; `external` = a host-side edit (Variables view,
 * chat edit/delete, re-evaluate, load). Absent meta is treated as a fold (events fire) for back-compat.
 */
export type VarsOrigin = 'model-fold' | 'card-write' | 'external'

export type ThMessage = {
  message_id: number
  role: 'user' | 'assistant'
  message: string
  name?: string
}

export type StMessage = {
  is_user: boolean
  name: string
  mes: string
  send_date: string
  swipes: string[]
  swipe_id: number
  extra: Record<string, any>
}

export type FloorLike = {
  floor?: number
  user_message?: { content?: string }
  response?: { content?: string }
  variables?: any
  swipes?: string[]
  swipe_id?: number
}

export type GenCfgNormalized = {
  userInput?: string
  prompt?: string
  systemPrompt?: string
  maxChatHistory?: number
  maxTokens?: number
  overrides?: any
}

/** The single seam between the realm-agnostic TH runtime and each transport. */
export interface Host {
  ctx: CardCtx
  // --- SYNC getters (called without await) ---
  statData(): any
  floors(): FloorLike[]
  charData(): any
  charAvatarPath(): string | null
  preset(): { name: string; parameters?: any } | null
  presetNames(): string[]
  worldbookNames(): { primary: string | null; additional: string[] }
  regexes(): { find: string; replace: string }[]
  // Full TavernHelper-shaped regexes for a scope (getTavernRegexes); `option` is the TH `{type}` arg.
  regexesFull(option?: any): TavernRegex[]
  isCharacterRegexesEnabled(): boolean
  formatRegex(text: string): string
  personaName(): string
  // Active chat id — the WCV transport's ctx is empty (main resolves the session from e.sender), so this
  // is a getter rather than `ctx.chatId` (SillyTavern.getCurrentChatId).
  currentChatId(): string
  // Script-scope variables (TH getVariables({type:'script'}) ) — a card-owned KV store, NOT stat_data.
  getScriptVars(): Record<string, any>
  // Chat-scope variables (TH getVariables({type:'chat'})) — a per-chat card-owned KV, NOT stat_data.
  getChatVars(): Record<string, any>
  // Render the script's action buttons (replaceScriptButtons) — the host shows the visible ones in the
  // menu above the input; a click is delivered back as a host event named after the button.
  setButtons(buttons: { name: string; visible: boolean }[]): void
  // --- ASYNC ops ---
  applyVariableOps(ops: VarOp[]): Promise<void>
  setVariables(statData: any): Promise<void>
  generate(input: string): Promise<{ content: string } | string>
  generateRaw(cfg: GenCfgNormalized): Promise<string>
  getWorldbook(name?: string): Promise<{ name?: string; entries: any[] }>
  saveWorldbook(name: string | undefined, entries: any[]): Promise<void>
  // Replace the regexes in a scope (replaceTavernRegexes/updateTavernRegexesWith); `option` is TH `{type}`.
  replaceRegexes(regexes: any[], option?: any): Promise<void>
  // Persist the card-scope KV (the full object; mirrors updateVariablesWith({type:'script'}) returning all).
  setScriptVars(vars: Record<string, any>): Promise<void>
  // Persist the per-chat KV (the full object; mirrors updateVariablesWith({type:'chat'}) returning all).
  setChatVars(vars: Record<string, any>): Promise<void>
  // Worldbook CRUD/bind (full library — trusted cards). list/chatWorldbookIds are SYNC (called w/o await).
  listWorldbooks(): { id: string; name: string }[]
  chatWorldbookIds(): string[]
  createWorldbook(name: string): Promise<string> // returns the new id
  deleteWorldbook(id: string): Promise<boolean>
  getWorldbookById(id: string): Promise<{ name?: string; entries: any[] }>
  saveWorldbookById(id: string, entries: any[]): Promise<void>
  bindWorldbook(id: string, on: boolean): Promise<void>
  setChatMessages(msgs: any): Promise<boolean>
  deleteChatMessages(ids: any): Promise<boolean>
  createChat(arg?: any): Promise<string>
  saveChat(chat: StMessage[]): Promise<boolean>
  reloadChat(): Promise<boolean>
  setInput(text: string): void
  /** "Press the send button": submit the CURRENT action-box content as the player's turn — what
   *  `/trigger` maps to (ST's /trigger drives the same Generate flow the send button does).
   *  Optional so older Host adapters keep compiling; the runtime falls back to an empty-action
   *  generate when absent. */
  submitInput?(): void
  // Global (per-profile) variables — the persistent scope for triggerSlash's /setglobalvar / /getglobalvar.
  // (Local/chat vars use statData + applyVariableOps; the runtime runs the STScript interpreter itself.)
  getGlobalVars(): Promise<Record<string, any>>
  setGlobalVar(key: string, value: any): Promise<void>
  // Whole-object global vars — the getVariables/replaceVariables({type:'global'}) scope. getGlobalVarsSync
  // is SYNC (like getChatVars/getScriptVars) so a card reads its saved settings before its first render;
  // setGlobalVars persists the whole bag. (A beautification card keeps its UI settings here.)
  getGlobalVarsSync(): Record<string, any>
  setGlobalVars(vars: Record<string, any>): Promise<void>
  // Resolve a character portrait to an rptasset:// URL for the calling card's world, or null.
  assetUrl(name: string, type: string, mood?: string): Promise<string | null>
  // Enumerate one entry's files (all variants of a name+type) for the calling card's world (WA-3): the
  // base first as `variant:null`, then variant tokens naturally sorted. Empty array on a miss. Same
  // lorebook-id precedence + category inference as `assetUrl`. Backs the bare `assetList` global.
  assetList(name: string, type: string): Promise<{ variant: string | null; url: string }[]>
  // Import an image into the calling card's world under the naming convention (WA-3): main opens the OS
  // image picker (user-mediated, per the security stance), copies the pick in as `<name>_<type>[_<variant>]`,
  // invalidates the index, and resolves the new rptasset:// URL (null on cancel/invalid). A host-privilege
  // action — exposed on `rptHost.requestAssetImport` (like requestOverlay), not as a bare read global.
  requestAssetImport(arg: {
    name: string
    type: string
    variant?: string
  }): Promise<string | null>
  // Engine-computed duel build preview for the active chat (read-only). See the build-preview design.
  getDuelPreview(): Promise<import('../combat/deckbuilder/preview').DuelPreview | null>
  // Raise a full-play-area overlay surface declared in the active card's `panel_ui.overlays` (PM-A7):
  // the app mounts the named surface as a WCV covering the whole panel_ui grid region above the slots.
  // One overlay at a time — requesting another closes the current one first. Resolves `true` when it
  // opened, `false` when the id isn't declared by the active card. `closeOverlay` tears down whatever
  // overlay is open (a no-op when none is). Both transports route to the same app mechanism.
  requestOverlay(id: string): Promise<boolean>
  closeOverlay(): Promise<void>
  // --- events + engine ---
  onVarsChanged(cb: (statData: any, meta?: { origin: VarsOrigin }) => void): () => void
  onHostEvent(cb: (name: string, payload?: any) => void): () => void
  evalTemplate(tmpl: string, data?: any): string
  evalTemplateError(tmpl: string, data?: any): string | null
  prepareContext(data?: any): any
}

/** What createThRuntime returns — spread onto the card window by each transport. */
export type ThGlobals = Record<string, any>
