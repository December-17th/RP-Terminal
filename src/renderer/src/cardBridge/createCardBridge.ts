// src/renderer/src/cardBridge/createCardBridge.ts
import { createThRuntime } from '../../../shared/thRuntime'
import { createInlineHost } from './host'
import type { CardCtx } from '../../../shared/thRuntime/types'

export type { CardCtx }

export function createCardBridge(ctx: CardCtx): Record<string, unknown> {
  const g = createThRuntime(createInlineHost(ctx))
  // lodash `_` and Zod `z` are injected by cardBridge/index.ts onto the result; keep the keys present.
  return { ...g, _: undefined, z: undefined }
}
