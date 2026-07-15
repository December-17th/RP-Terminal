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
