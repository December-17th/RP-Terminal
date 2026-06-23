// src/shared/thRuntime/types.ts
import type { VarOp } from './ops'

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
  formatRegex(text: string): string
  personaName(): string
  // --- ASYNC ops ---
  applyVariableOps(ops: VarOp[]): Promise<void>
  setVariables(statData: any): Promise<void>
  generate(input: string): Promise<{ content: string } | string>
  generateRaw(cfg: GenCfgNormalized): Promise<string>
  getWorldbook(name?: string): Promise<{ name?: string; entries: any[] }>
  saveWorldbook(name: string | undefined, entries: any[]): Promise<void>
  setChatMessages(msgs: any): Promise<boolean>
  deleteChatMessages(ids: any): Promise<boolean>
  createChat(arg?: any): Promise<string>
  createChatMessages(msgs: any): Promise<string>
  saveChat(chat: StMessage[]): Promise<boolean>
  reloadChat(): Promise<boolean>
  triggerSlash(cmd: string): Promise<string>
  setInput(text: string): void
  // --- events + engine ---
  onVarsChanged(cb: (statData: any) => void): () => void
  onHostEvent(cb: (name: string, payload?: any) => void): () => void
  evalTemplate(tmpl: string, data?: any): string
  evalTemplateError(tmpl: string, data?: any): string | null
  prepareContext(data?: any): any
}

/** What createThRuntime returns — spread onto the card window by each transport. */
export type ThGlobals = Record<string, any>
