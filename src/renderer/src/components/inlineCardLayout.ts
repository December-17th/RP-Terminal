import { replaceVhInContent } from '../../../shared/cardEnv'
import type { CardSizing } from '../../../shared/cardRenderMode'

export interface InlineCardLayout {
  html: string
  scrollable: boolean
}

/** Build the document-layout policy shared by InlineCardFrame's source and measurement paths. */
export function createInlineCardLayout(html: string, _sizing: CardSizing): InlineCardLayout {
  return {
    // JS-Slash-Runner rewrites viewport minimums before mounting the card. This decouples 100vh-style
    // page floors from the iframe's own changing height without destroying ordinary control/card minima.
    html: replaceVhInContent(html),
    // Fit normally has no overflow because its iframe matches the content. Keeping overflow available
    // also provides a safe fallback at the fit safety ceiling; Fill requires it by construction.
    scrollable: true
  }
}

/** Remove only root height feedback; authored descendant minimum heights are layout data, not host policy. */
export function normalizeInlineFitDocument(doc: Document): void {
  for (const el of [doc.documentElement, doc.body]) {
    if (el && el.style.height !== 'auto') el.style.setProperty('height', 'auto', 'important')
  }
}
