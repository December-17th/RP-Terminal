// src/renderer/src/cardBridge/index.ts
import { createCardBridge, type CardCtx } from './createCardBridge'
import lodash from 'lodash'
import { cardZod } from '../../../shared/cardZod'

export { installCardTopSurface } from './topSurface'

/**
 * Install window.__rptCardBridge so an inline card's bootstrap (running in a same-origin iframe)
 * can synchronously fetch its API globals via window.parent.__rptCardBridge(ctx). Idempotent.
 * Vue/jQuery are NOT provided here — they must run in the IFRAME's realm (see cardLibs.ts), so they
 * bind to the iframe's document; only realm-safe values (data + pure functions) come from here.
 */
export function installCardBridge(): void {
  if (typeof window === 'undefined') return
  if ((window as any).__rptCardBridge) return
  ;(window as any).__rptCardBridge = (ctx: CardCtx): Record<string, unknown> => {
    const g = createCardBridge(ctx)
    // realm-safe pure libs (no DOM): provide from the app bundle.
    g._ = lodash
    g.z = cardZod
    return g
  }
}
