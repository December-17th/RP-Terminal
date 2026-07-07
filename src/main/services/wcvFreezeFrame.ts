/**
 * Freeze-frame orchestration for WCV suppression (PM-A4).
 *
 * WebContentsViews always paint ABOVE the renderer DOM, so a TopStrip dropdown (plain DOM) would be
 * occluded by the card panels below it. The fix is to HIDE the live WCVs while a menu is open — but a
 * plain hide leaves a blank hole where the panel was. This controller keeps the panels *visually in
 * place* by capturing each visible WCV to a bitmap the moment suppression begins, hiding the live
 * views, and painting those bitmaps into the DOM placeholder behind them. On restore it clears the
 * bitmaps and re-shows the live views.
 *
 * PURE + INJECTABLE so it can be unit-tested without Electron: all side effects (capturing a view,
 * hiding/showing live views, pushing/clearing bitmaps in the renderer) are passed in as effects. The
 * controller owns only the ORCHESTRATION — the invariant, the episode token (cancel), and the
 * failure fallback:
 *
 *  - INVARIANT: while suppressed, live WCVs are hidden (the menu must never be occluded). The
 *    freeze-frame bitmaps are a cosmetic backfill in the DOM behind them, nothing more.
 *  - Suppress: snapshot the currently-visible views, then capture them all (async). When the captures
 *    resolve AND we're still in the same episode, hide the live views and push the bitmaps. A capture
 *    that fails / comes back empty (view mid-load, zero-size) simply yields no bitmap for that slot —
 *    it still gets hidden, falling back to today's blank behavior for that one panel.
 *  - Restore: bump the episode token (cancels any in-flight capture from being applied), show the
 *    live views, clear the bitmaps.
 *  - Rapid open/close: if the menu closes before the captures land, the stale-episode guard drops the
 *    result and the views were never hidden — no flicker, live the whole time.
 */

/** A view we can capture + toggle. `id` is the renderer slot id the bitmap is keyed by. */
export interface FreezeTarget {
  id: string
  /** Capture the view to a data-URL bitmap, or null on failure / empty (mid-load, zero-size). */
  capture: () => Promise<string | null>
  /** Show / hide the LIVE native view. */
  setVisible: (visible: boolean) => void
}

export interface FreezeEffects {
  /** Enumerate the views that are CURRENTLY visible (the ones a menu would occlude). */
  visibleTargets: () => FreezeTarget[]
  /** Push the captured bitmaps to the renderer to paint behind the (now hidden) views. */
  showFreeze: (frames: Record<string, string>) => void
  /** Drop the freeze-frame bitmaps in the renderer (restore = show live again). */
  clearFreeze: () => void
}

export interface FreezeController {
  /** A suppression episode began (first overlay acquired). */
  suppress: () => void
  /** The suppression episode ended (last overlay released). */
  restore: () => void
  /** True while a menu is open (live views hidden). Exposed for late-created views. */
  isSuppressed: () => boolean
  /**
   * A view was created WHILE suppressed (a chat re-render under the open menu). It must start
   * hidden too — the caller hands it here so the controller applies the current episode state.
   */
  onTargetCreated: (target: FreezeTarget) => void
}

export function createFreezeController(effects: FreezeEffects): FreezeController {
  let suppressed = false
  // Bumped on every suppress/restore transition; an async capture checks it before applying so a
  // menu closed (or re-opened) mid-capture drops the stale result instead of flashing a stale frame.
  let episode = 0

  const suppress = (): void => {
    if (suppressed) return
    suppressed = true
    const token = ++episode
    const targets = effects.visibleTargets()
    if (targets.length === 0) return
    // Capture every visible view WHILE it's still on screen (a hidden view captures blank), then
    // hide the live views + paint the bitmaps. Await all so the menu doesn't appear over a
    // half-frozen stage; the token guards against a close/re-open landing between here and there.
    void Promise.all(
      targets.map(async (t) => {
        try {
          return { id: t.id, url: await t.capture() }
        } catch {
          return { id: t.id, url: null }
        }
      })
    ).then((results) => {
      // Stale (the menu closed, or closed-then-reopened) → this episode's captures are void. The
      // newer episode will have run its own capture; do nothing here.
      if (token !== episode || !suppressed) return
      const frames: Record<string, string> = {}
      for (const r of results) {
        if (r.url) frames[r.id] = r.url
      }
      // Hide the live views regardless of capture success — the menu must not be occluded. A view
      // whose capture failed just has no bitmap (blank, today's behavior) instead of a freeze-frame.
      for (const t of targets) t.setVisible(false)
      if (Object.keys(frames).length > 0) effects.showFreeze(frames)
    })
  }

  const restore = (): void => {
    if (!suppressed) return
    suppressed = false
    episode++ // cancel any in-flight capture from being applied
    for (const t of effects.visibleTargets()) t.setVisible(true)
    effects.clearFreeze()
  }

  const onTargetCreated = (target: FreezeTarget): void => {
    // Created under an open menu → keep it hidden (no freeze-frame; it wasn't on screen to capture).
    if (suppressed) target.setVisible(false)
  }

  return {
    suppress,
    restore,
    isSuppressed: () => suppressed,
    onTargetCreated
  }
}
