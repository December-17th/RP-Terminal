// src/shared/thRuntime/hostFacets.ts
//
// The card-runtime Host, split into eight type-level facets. This is a purely type-level
// grouping — the runtime Host object stays FLAT (`Host` is their intersection, see types.ts),
// and the ~96 `host.*` call sites in index.ts are unchanged. Each facet gathers a cohesive
// slice of the seam so adapters, the null host, and the (stage-2) channel spec can reason about
// one concern at a time. Every member's doc comment travels with it.
import type { VarOp } from './ops'
import type { TavernRegex } from './tavernRegex'
import type { FloorLike, GenCfgNormalized, StMessage, VarsOrigin } from './hostPrimitives'

/** Variables: stat_data + MVU ops, the three KV scopes (script / chat / global), and the
 *  stat_data change subscription. */
export interface VarsHost {
  statData(): any
  applyVariableOps(ops: VarOp[]): Promise<void>
  setVariables(statData: any): Promise<void>
  // Script-scope variables (TH getVariables({type:'script'}) ) — a card-owned KV store, NOT stat_data.
  getScriptVars(): Record<string, any>
  // Persist the card-scope KV (the full object; mirrors updateVariablesWith({type:'script'}) returning all).
  setScriptVars(vars: Record<string, any>): Promise<void>
  // Chat-scope variables (TH getVariables({type:'chat'})) — a per-chat card-owned KV, NOT stat_data.
  getChatVars(): Record<string, any>
  // Persist the per-chat KV (the full object; mirrors updateVariablesWith({type:'chat'}) returning all).
  setChatVars(vars: Record<string, any>): Promise<void>
  // Global (per-profile) variables — the persistent scope for triggerSlash's /setglobalvar / /getglobalvar.
  // (Local/chat vars use statData + applyVariableOps; the runtime runs the STScript interpreter itself.)
  getGlobalVars(): Promise<Record<string, any>>
  setGlobalVar(key: string, value: any): Promise<void>
  // Whole-object global vars — the getVariables/replaceVariables({type:'global'}) scope. getGlobalVarsSync
  // is SYNC (like getChatVars/getScriptVars) so a card reads its saved settings before its first render;
  // setGlobalVars persists the whole bag. (A beautification card keeps its UI settings here.)
  getGlobalVarsSync(): Record<string, any>
  setGlobalVars(vars: Record<string, any>): Promise<void>
  onVarsChanged(cb: (statData: any, meta?: { origin: VarsOrigin }) => void): () => void
}

/** Worldbook / lorebook: the active-book names plus full library CRUD + bind (trusted cards). */
export interface WorldbookHost {
  worldbookNames(): { primary: string | null; additional: string[] }
  getWorldbook(name?: string): Promise<{ name?: string; entries: any[] }>
  saveWorldbook(name: string | undefined, entries: any[]): Promise<void>
  // Worldbook CRUD/bind (full library — trusted cards). list/chatWorldbookIds are SYNC (called w/o await).
  listWorldbooks(): { id: string; name: string }[]
  chatWorldbookIds(): string[]
  createWorldbook(name: string): Promise<string> // returns the new id
  deleteWorldbook(id: string): Promise<boolean>
  getWorldbookById(id: string): Promise<{ name?: string; entries: any[] }>
  saveWorldbookById(id: string, entries: any[]): Promise<void>
  bindWorldbook(id: string, on: boolean): Promise<void>
}

/** Chat / character: the floor stream, chat id + persona, message writes, chat lifecycle, and
 *  character + preset metadata. */
export interface ChatHost {
  floors(): FloorLike[]
  // Active chat id — the WCV transport's ctx is empty (main resolves the session from e.sender), so this
  // is a getter rather than `ctx.chatId` (SillyTavern.getCurrentChatId).
  currentChatId(): string
  personaName(): string
  /** The active user persona's description — expands `{{persona}}`. Empty only when no bio is set. */
  personaDescription(): string
  setChatMessages(msgs: any): Promise<boolean>
  deleteChatMessages(ids: any): Promise<boolean>
  createChat(arg?: any): Promise<string>
  saveChat(chat: StMessage[]): Promise<boolean>
  reloadChat(): Promise<boolean>
  charData(): any
  charAvatarPath(): string | null
  preset(): { name: string; parameters?: any } | null
  presetNames(): string[]
}

/** Regex: the display/prompt regex pairs, full TavernHelper-shaped regexes, and replacement. */
export interface RegexHost {
  regexes(): { find: string; replace: string }[]
  // Full TavernHelper-shaped regexes for a scope (getTavernRegexes); `option` is the TH `{type}` arg.
  regexesFull(option?: any): TavernRegex[]
  isCharacterRegexesEnabled(): boolean
  formatRegex(text: string): string
  // Replace the regexes in a scope (replaceTavernRegexes/updateTavernRegexesWith); `option` is TH `{type}`.
  replaceRegexes(regexes: any[], option?: any): Promise<void>
}

/** Surface: the input box + send button, action buttons, overlay surfaces, and runtime theming. */
export interface SurfaceHost {
  setInput(text: string): void
  /** "Press the send button": submit the CURRENT action-box content as the player's turn — what
   *  `/trigger` maps to (ST's /trigger drives the same Generate flow the send button does), which is
   *  what makes the ubiquitous `/setinput x | /trigger` and `/send x | /trigger` clickable-options
   *  combos work. Fire-and-forget (the runtime returns '', like clicking send). */
  submitInput(): void
  // Render the script's action buttons (replaceScriptButtons) — the host shows the visible ones in the
  // menu above the input; a click is delivered back as a host event named after the button.
  setButtons(buttons: { name: string; visible: boolean }[]): void
  // Raise a full-play-area overlay surface declared in the active card's `panel_ui.overlays` (PM-A7):
  // the app mounts the named surface as a WCV covering the whole panel_ui grid region above the slots.
  // One overlay at a time — requesting another closes the current one first. Resolves `true` when it
  // opened, `false` when the id isn't declared by the active card. `closeOverlay` tears down whatever
  // overlay is open (a no-op when none is). Both transports route to the same app mechanism.
  requestOverlay(id: string): Promise<boolean>
  closeOverlay(): Promise<void>
  // Runtime theming (runtime-theme-api-design). A card's running UI restyles the play shell + chat
  // message box at runtime. `setPlayTheme` derives + AA-checks the override (same trust model as the
  // static card theme) and applies it, returning false when rejected (contrast fails, or the user's
  // allow_card_themes opt-out is off). `theme` null/{} clears the runtime layer. Both transports route
  // to the renderer authority (the effective base tokens live there). `getPlayThemeSync` returns the
  // fully-resolved effective token map + a source tag. Like requestOverlay, also surfaced on rptHost.
  setPlayTheme(
    theme: Record<string, unknown> | null,
    opts?: { target?: 'shell' | 'message'; persist?: 'session' | 'chat' | 'global' }
  ): Promise<boolean>
  getPlayThemeSync(): { tokens: Record<string, string>; source: 'user' | 'card' | 'runtime' }
}

/** Assets: character portraits, model-authored scenes, variant enumeration, and picker-backed import. */
export interface AssetHost {
  // Resolve a character portrait to an rptasset:// URL for the calling card's world, or null.
  assetUrl(name: string, type: string, mood?: string): Promise<string | null>
  /** Resolve a model-authored hierarchical location to an rptasset:// URL for the calling card's
   *  world, or null. */
  sceneAssetUrl(location: string, type: '全景' | '背景'): Promise<string | null>
  // Enumerate one entry's files (all variants of a name+type) for the calling card's world (WA-3): the
  // base first as `variant:null`, then variant tokens naturally sorted. Empty array on a miss. Same
  // lorebook-id precedence + category inference as `assetUrl`. Backs the bare `assetList` global.
  assetList(name: string, type: string): Promise<{ variant: string | null; url: string }[]>
  // Import an image into the calling card's world under the naming convention (WA-3): main opens the OS
  // image picker (user-mediated, per the security stance), copies the pick in as `<name>_<type>[_<variant>]`,
  // invalidates the index, and resolves the new rptasset:// URL (null on cancel/invalid). A host-privilege
  // action — exposed on `rptHost.requestAssetImport` (like requestOverlay), not as a bare read global.
  requestAssetImport(arg: { name: string; type: string; variant?: string }): Promise<string | null>
}

/** Generation: the two generate entry points plus the read-only duel build preview. */
export interface GenHost {
  generate(input: string): Promise<{ content: string } | string>
  generateRaw(cfg: GenCfgNormalized): Promise<string>
  // Engine-computed duel build preview for the active chat (read-only). See the build-preview design.
  getDuelPreview(): Promise<import('../combat/deckbuilder/preview').DuelPreview | null>
}

/** Engine: the EJS/ST-Prompt-Template evaluation hooks and the host-event subscription. */
export interface EngineHost {
  evalTemplate(tmpl: string, data?: any): string
  evalTemplateError(tmpl: string, data?: any): string | null
  prepareContext(data?: any): any
  onHostEvent(cb: (name: string, payload?: any) => void): () => void
}
