// src/renderer/src/cardBridge/createCardBridge.ts
import { createThRuntime } from '../../../shared/thRuntime'
import { createInlineHost } from './host'
import type { CardCtx } from '../../../shared/thRuntime/types'

export type { CardCtx }

export function createCardBridge(ctx: CardCtx): Record<string, unknown> {
  // `ctx.chatScope`, when present, makes this card's chat reads reflect the panel's own messages instead
  // of the real chat (chat-READ-only; see createThRuntime). Unscoped ctx keeps today's behavior exactly.
  const g = createThRuntime(createInlineHost(ctx), { chatScope: ctx.chatScope })
  // lodash `_` and Zod `z` are injected by cardBridge/index.ts onto the result; keep the keys present.
  return { ...g, _: undefined, z: undefined }
}
