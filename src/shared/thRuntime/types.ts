// src/shared/thRuntime/types.ts
import type { VarOp } from './ops'
import type { TavernRegex } from './tavernRegex'

export type CardCtx = { profileId: string; chatId: string; characterId: string }

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
  // Global (per-profile) variables — the persistent scope for triggerSlash's /setglobalvar / /getglobalvar.
  // (Local/chat vars use statData + applyVariableOps; the runtime runs the STScript interpreter itself.)
  getGlobalVars(): Promise<Record<string, any>>
  setGlobalVar(key: string, value: any): Promise<void>
  // Resolve a character portrait to an rptasset:// URL for the calling card's world, or null.
  assetUrl(name: string, type: string, mood?: string): Promise<string | null>
  // --- events + engine ---
  onVarsChanged(cb: (statData: any) => void): () => void
  onHostEvent(cb: (name: string, payload?: any) => void): () => void
  evalTemplate(tmpl: string, data?: any): string
  evalTemplateError(tmpl: string, data?: any): string | null
  prepareContext(data?: any): any
}

/** What createThRuntime returns — spread onto the card window by each transport. */
export type ThGlobals = Record<string, any>
