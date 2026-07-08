/**
 * Full-play-area overlay orchestration for card surfaces (PM-A7).
 *
 * A card surface (a `panel_ui` slot) is a WebContentsView that composites ABOVE the DOM only WITHIN
 * its slot rectangle — so a surface can never escape its slot to paint a full-viewport sheet (partner
 * detail, 地图). The app mechanism: a card declares overlay surfaces in `panel_ui.overlays` and calls
 * `requestOverlay(id)` / `closeOverlay()`; the app raises the named surface as a temporary WCV covering
 * the whole panel_ui grid region (above the slots), and tears it down on close.
 *
 * This module owns only the ORCHESTRATION — the one-at-a-time invariant and the id validation — and is
 * PURE + INJECTABLE (no Electron) so it can be unit-tested. The real effects (send the open/close to the
 * renderer, which mounts the overlay WCV over the play-area container) are passed in. The manifest lookup
 * (is `id` declared by the active card?) is done by the caller, which hands the resolved surface in as
 * `decl` (null ⇒ undeclared ⇒ rejected).
 *
 *  - INVARIANT: at most one overlay is open. `request` closes the current one before opening a new id;
 *    requesting the already-open id is a no-op (stays open).
 *  - Undeclared id ⇒ `warn` + `request` returns false, nothing opens.
 *  - `dismiss` closes whatever is open (a no-op when none is) — the app-side / card / switch close path.
 */

/** A declared overlay surface resolved from the active card's `panel_ui.overlays`. */
export interface OverlayDecl {
  entry: string
  title?: string
}

export interface OverlayEffects {
  /** Raise the overlay surface (the renderer mounts a WCV over the play-area container). */
  open: (overlayId: string, decl: OverlayDecl) => void
  /** Tear down the overlay surface with this id (the renderer unmounts its WCV). */
  close: (overlayId: string) => void
  /** An undeclared id was requested — reject loudly (main-side console.warn / log). */
  warn: (overlayId: string) => void
}

export interface OverlayController {
  /**
   * Raise `overlayId` (its resolved `decl`, or null if the active card didn't declare it). Returns
   * whether an overlay is open for that id afterward: true when it opened / was already open, false
   * when the id was undeclared (rejected).
   */
  request: (overlayId: string, decl: OverlayDecl | null) => boolean
  /** Close whatever overlay is open (no-op when none). */
  dismiss: () => void
  /** The currently-open overlay id, or null. */
  current: () => string | null
}

export function createOverlayController(effects: OverlayEffects): OverlayController {
  let current: string | null = null

  const request = (overlayId: string, decl: OverlayDecl | null): boolean => {
    if (!decl) {
      effects.warn(overlayId)
      return false
    }
    if (current === overlayId) return true // already open — idempotent
    if (current) effects.close(current) // one at a time: swap
    current = overlayId
    effects.open(overlayId, decl)
    return true
  }

  const dismiss = (): void => {
    if (current == null) return
    const id = current
    current = null
    effects.close(id)
  }

  return { request, dismiss, current: () => current }
}
