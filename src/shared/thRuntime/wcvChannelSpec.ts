// src/shared/thRuntime/wcvChannelSpec.ts
//
// The single Channel Spec table for the WCV (WebContentsView) transport (ADR 0013). It is keyed by
// Host member name; each entry declares the IPC `channel`, the call `kind` (`sync` = `ipcRenderer.sendSync`,
// `invoke` = request/response, `send` = fire-and-forget), and, for sync getters, the `fallback` value the
// preload adapter returns when the blocking read throws or yields null/undefined.
//
// `createWcvHost` (src/preload/wcvHost.ts) is BUILT from this table by a generic loop, and `wcvIpc.ts`
// (main) references these channel names instead of bare strings — so the two sides can't drift. The table
// is typed `Record<WcvSpecMember, ChannelSpec>`, where `WcvSpecMember` is every Host member EXCEPT the
// hand-written residue: a member without a spec row, or a residue member accidentally listed here, is a
// compile error.
//
// Boundary: this file lives under `shared/` and imports TYPES ONLY (no electron, no main, no renderer) —
// it is pure data + type declarations that both the preload adapter and the main IPC layer consume.
import type { Host } from './types'

/** How a Host member is carried over IPC. */
export type WcvChannelKind = 'sync' | 'invoke' | 'send'

/**
 * Host members NOT driven by this table — they keep hand-written bodies in `createWcvHost`:
 * `ctx` (the root placeholder), the two event subscriptions, the three injected EJS deps, the three
 * shape-normalizing worldbook getters, `createChat` (a deferred ''), and `formatRegex` (its natural
 * fallback is the input text, which a static table can't express).
 */
export type WcvResidueMember =
  | 'ctx'
  | 'onVarsChanged'
  | 'onHostEvent'
  | 'evalTemplate'
  | 'evalTemplateError'
  | 'prepareContext'
  | 'worldbookNames'
  | 'getWorldbook'
  | 'getWorldbookById'
  | 'createChat'
  | 'formatRegex'

/** Every Host member the spec table must cover (the flat Host minus the residue). */
export type WcvSpecMember = Exclude<keyof Host, WcvResidueMember>

export type ChannelSpec = {
  channel: string
  kind: WcvChannelKind
  /** Sync-only: returned when `sendSync` throws or yields null/undefined. Ignored for invoke/send. */
  fallback?: unknown
}

// Channel strings are the EXISTING wcvHost.ts strings, verbatim — including the irregular
// `wcv-register-button` (setButtons) and `wcv-get-play-theme-sync` (getPlayThemeSync).
export const WCV_CHANNEL_SPEC: Record<WcvSpecMember, ChannelSpec> = {
  // --- VarsHost ---
  statData: { channel: 'wcv-host-get-vars-sync', kind: 'sync', fallback: {} },
  applyVariableOps: { channel: 'wcv-host-apply-vars', kind: 'invoke' },
  setVariables: { channel: 'wcv-host-set-vars', kind: 'invoke' },
  getScriptVars: { channel: 'wcv-host-script-vars-get-sync', kind: 'sync', fallback: {} },
  setScriptVars: { channel: 'wcv-host-script-vars-set', kind: 'invoke' },
  getChatVars: { channel: 'wcv-host-chat-vars-get-sync', kind: 'sync', fallback: {} },
  setChatVars: { channel: 'wcv-host-chat-vars-set', kind: 'invoke' },
  getGlobalVars: { channel: 'wcv-host-get-global-vars', kind: 'invoke' },
  setGlobalVar: { channel: 'wcv-host-set-global-var', kind: 'invoke' },
  getGlobalVarsSync: { channel: 'wcv-host-get-global-vars-sync', kind: 'sync', fallback: {} },
  setGlobalVars: { channel: 'wcv-host-set-global-vars', kind: 'invoke' },

  // --- WorldbookHost (worldbookNames / getWorldbook / getWorldbookById are residue) ---
  saveWorldbook: { channel: 'wcv-host-replace-worldbook', kind: 'invoke' },
  listWorldbooks: { channel: 'wcv-host-list-worldbooks-sync', kind: 'sync', fallback: [] },
  chatWorldbookIds: { channel: 'wcv-host-chat-worldbook-ids-sync', kind: 'sync', fallback: [] },
  createWorldbook: { channel: 'wcv-host-create-worldbook', kind: 'invoke' },
  deleteWorldbook: { channel: 'wcv-host-delete-worldbook', kind: 'invoke' },
  saveWorldbookById: { channel: 'wcv-host-save-worldbook-by-id', kind: 'invoke' },
  bindWorldbook: { channel: 'wcv-host-bind-worldbook', kind: 'invoke' },

  // --- ChatHost (createChat is residue) ---
  floors: { channel: 'wcv-host-get-floors-sync', kind: 'sync', fallback: [] },
  currentChatId: { channel: 'wcv-host-get-chat-id-sync', kind: 'sync', fallback: '' },
  personaName: { channel: 'wcv-host-get-persona-name', kind: 'sync', fallback: 'User' },
  personaDescription: { channel: 'wcv-host-get-persona-description', kind: 'sync', fallback: '' },
  setChatMessages: { channel: 'wcv-host-set-chat-messages', kind: 'invoke' },
  deleteChatMessages: { channel: 'wcv-host-delete-chat-messages', kind: 'invoke' },
  saveChat: { channel: 'wcv-host-save-chat', kind: 'invoke' },
  reloadChat: { channel: 'wcv-host-reload-chat', kind: 'invoke' },
  charData: { channel: 'wcv-host-get-char-data', kind: 'sync', fallback: null },
  charAvatarPath: { channel: 'wcv-host-get-char-avatar', kind: 'sync', fallback: null },
  preset: { channel: 'wcv-host-get-preset', kind: 'sync', fallback: null },
  presetNames: { channel: 'wcv-host-get-preset-names', kind: 'sync', fallback: [] },

  // --- RegexHost (formatRegex is residue) ---
  regexes: { channel: 'wcv-host-get-regexes', kind: 'sync', fallback: [] },
  regexesFull: { channel: 'wcv-host-get-regexes-full', kind: 'sync', fallback: [] },
  isCharacterRegexesEnabled: {
    channel: 'wcv-host-is-char-regex-enabled',
    kind: 'sync',
    fallback: true
  },
  replaceRegexes: { channel: 'wcv-host-replace-regexes', kind: 'invoke' },

  // --- SurfaceHost ---
  setInput: { channel: 'wcv-host-set-input', kind: 'send' },
  submitInput: { channel: 'wcv-host-submit-input', kind: 'send' },
  setButtons: { channel: 'wcv-register-button', kind: 'send' },
  requestOverlay: { channel: 'wcv-host-request-overlay', kind: 'invoke' },
  closeOverlay: { channel: 'wcv-host-close-overlay', kind: 'invoke' },
  setPlayTheme: { channel: 'wcv-host-set-play-theme', kind: 'invoke' },
  getPlayThemeSync: {
    channel: 'wcv-get-play-theme-sync',
    kind: 'sync',
    fallback: { tokens: {}, source: 'user' }
  },

  // --- AssetHost ---
  assetUrl: { channel: 'wcv-host-asset-url', kind: 'invoke' },
  sceneAssetUrl: { channel: 'wcv-host-scene-asset-url', kind: 'invoke' },
  assetList: { channel: 'wcv-host-asset-list', kind: 'invoke' },
  requestAssetImport: { channel: 'wcv-host-request-asset-import', kind: 'invoke' },

  // --- GenHost ---
  generate: { channel: 'wcv-host-generate', kind: 'invoke' },
  generateRaw: { channel: 'wcv-host-generate-raw', kind: 'invoke' },
  getDuelPreview: { channel: 'wcv-host-duel-preview', kind: 'invoke' }
}

/**
 * Member → channel-name lookup derived from the spec, for the main IPC layer (`wcvIpc.ts`) and other
 * transports to reference a channel by its Host member without repeating the raw string. Names only —
 * the `kind`/`fallback` live on `WCV_CHANNEL_SPEC`.
 */
export const WCV_CHANNELS = Object.fromEntries(
  Object.entries(WCV_CHANNEL_SPEC).map(([member, spec]) => [member, spec.channel])
) as Record<WcvSpecMember, string>

/**
 * Channel names for the residue members that STILL cross IPC (they have hand-written bodies on both sides,
 * so they can't ride the spec's generic loop, but their channel string must not drift between the preload
 * adapter (`wcvHost.ts`) and the main handlers (`wcvIpc.ts`). The three shape-normalizing worldbook getters
 * and `formatRegex` (whose fallback is the input text) live here; the residue members with NO main handler
 * (`createChat`, the two event subscriptions, the injected EJS deps, `ctx`) are not IPC channels at all.
 */
export const WCV_RESIDUE_CHANNELS = {
  worldbookNames: 'wcv-host-get-worldbook-names-sync',
  getWorldbook: 'wcv-host-get-worldbook',
  getWorldbookById: 'wcv-host-get-worldbook-by-id',
  formatRegex: 'wcv-host-format-regex'
} as const satisfies Partial<Record<WcvResidueMember, string>>
