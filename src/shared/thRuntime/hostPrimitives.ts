// src/shared/thRuntime/hostPrimitives.ts
//
// Leaf module of primitive type aliases shared by the Host facets (`hostFacets.ts`) and the
// composed seam (`types.ts`). It imports NOTHING from either, so both can depend on it without
// a cycle. `types.ts` re-exports every name here, so `import { … } from '.../types'` still works
// unchanged for all other files.

/**
 * An ISOLATED chat scope for a card rendered inside a UI panel: its messages ARE the panel's content,
 * so the card's chat reads (SillyTavern.chat / getContext().chat / getChatMessages / get*MessageId)
 * reflect these messages instead of the real host chat. General (reusable by reasoning / agent panels).
 * Chat-READ-only — writes, vars/MVU, generation, and worldbook stay on the real host (see createThRuntime).
 */
export type CardChatScope = { messages: Array<{ role: 'user' | 'assistant'; content: string }> }

export type CardCtx = {
  profileId: string
  chatId: string
  characterId: string
  /** When set, the card runs against this scope's messages as its chat instead of the real host floors. */
  chatScope?: CardChatScope
}

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

/**
 * One prompt entry in the Host's normalized preset view — the shape a card's preset control surface
 * (the 狐神抚 case) reads and toggles. Carries BOTH the RPT-native `identifier` and the TavernHelper
 * `id` (they are the same string) so native and TH-faithful cards both resolve it. The runtime maps
 * this into the TH `getPreset('in_use').prompts` shape (see `presetShape.ts`).
 */
export type HostPresetPrompt = {
  id: string
  identifier: string
  name: string
  role: 'system' | 'user' | 'assistant'
  content: string
  enabled: boolean
  marker?: string
  injection_depth?: number | null
  injection_order?: number
}

/**
 * The Host's normalized view of the active ('in_use') preset — the M2 normalized runtime view plus any
 * envelope-derived `prompts_unused`. The runtime maps it into the TavernHelper `Preset` shape
 * (`{ settings, prompts, prompts_unused, extensions }`, docs-confirmed spec §7) AND keeps the legacy
 * `{ name, parameters }` fields cards already read. `prompts_unused` is envelope-derived (main transport
 * only — the inline transport has no envelope, so it is `[]` there; a data-availability difference, not a
 * behavior drift, since the runtime maps both identically).
 */
export type HostPresetView = {
  name: string
  parameters: Record<string, any>
  prompts: HostPresetPrompt[]
  prompts_unused: HostPresetPrompt[]
  extensions: Record<string, any>
}
