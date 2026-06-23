/**
 * Card render mode — shared by main (regex _meta) and renderer (routing + settings).
 * Pure (no node/electron/DOM).
 *
 * - inline:   same-origin srcdoc iframe embedded in the message DOM (native feel).
 * - isolated: out-of-process WebContentsView overlay (crash-isolated).
 */
export type CardRenderMode = 'inline' | 'isolated'

export const DEFAULT_CARD_RENDER_MODE: CardRenderMode = 'inline'

/** Effective mode for a card block: a per-card override wins, else the global default. */
export const resolveCardMode = (
  override: CardRenderMode | undefined,
  globalDefault: CardRenderMode
): CardRenderMode => override ?? globalDefault
