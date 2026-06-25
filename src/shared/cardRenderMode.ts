/**
 * Card render mode — shared by main (regex _meta) and renderer (routing + settings).
 * Pure (no node/electron/DOM).
 *
 * - inline:   same-origin srcdoc iframe embedded in the message DOM (native feel).
 * - isolated: out-of-process WebContentsView overlay (crash-isolated).
 * - panel:    NOT rendered in the message — a URL-loader regex UI the user PROMOTED to a docked WCV panel
 *             (the message marker is stripped; the UI is selectable as a workspace view). Opt-in per regex.
 */
export type CardRenderMode = 'inline' | 'isolated' | 'panel'

export const DEFAULT_CARD_RENDER_MODE: CardRenderMode = 'inline'

/** Effective mode for a card block: a per-card override wins, else the global default. */
export const resolveCardMode = (
  override: CardRenderMode | undefined,
  globalDefault: CardRenderMode
): CardRenderMode => override ?? globalDefault

// --- Card sizing (SP2) — fit (content-fit, default) vs fill (vh-driven, fills the frame) ---
// The CardSizing type lives with the rendering-env in cardEnv (it shapes the injected --TH-viewport-height
// + the vh rewrite); re-exported here so the render-mode-adjacent settings/routing import it from one home.
export type { CardSizing } from './cardEnv'
import type { CardSizing } from './cardEnv'

export const DEFAULT_CARD_SIZING: CardSizing = 'fit'

/** Effective sizing for a card block: a per-card override wins, else the global default. */
export const resolveCardSizing = (
  override: CardSizing | undefined,
  globalDefault: CardSizing
): CardSizing => override ?? globalDefault
