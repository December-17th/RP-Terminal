/**
 * Freeze-frame orchestration for WCV suppression (PM-A4).
 *
 * WebContentsViews always paint ABOVE the renderer DOM, so a TopStrip dropdown (plain DOM) would be
 * occluded by the card panels below it. The fix is to HIDE the live WCVs while a menu is open — but a
 * plain hide leaves a blank hole where the panel was. This controller keeps the panels *visually in
 * place* by painting a recently-captured bitmap of each view into the DOM placeholder behind it, hiding
 * the live views instantly, and clearing the bitmaps on restore.
 *
 * WHY A CACHE (freeze-precache): `capturePage()` is async and slow (~0.5s for a batch). The original
 * design captured on the suppress hot path and AWAITED the captures before hiding the live views — so
 * for that ~0.5s the live panel kept painting OVER the opening menu (the "upper half lags" the owner
 * reported). We now pre-cache each view's still WHILE it is live and visible, so suppression can hide
 * synchronously and paint the cached frames with NO capture and NO await on the hot path. The trade-off
 * is that a still may be slightly stale (up to the warm interval); the cache is refreshed after every
 * restore and on game-state changes so the next menu-open shows a fresh-ish frame.
 *
 * PURE + INJECTABLE so it can be unit-tested without Electron: all side effects (capturing a view,
 * hiding/showing live views, pushing/clearing bitmaps in the renderer) are passed in as effects. The
 * controller owns only the ORCHESTRATION — the invariant, the episode token (cancel), the cache, and
 * the failure fallback:
 *
 *  - INVARIANT: while suppressed, live WCVs are hidden (the menu must never be occluded). The
 *    freeze-frame bitmaps are a cosmetic backfill in the DOM behind them, nothing more.
 *  - Suppress (SYNC hot path): hide every visible view IMMEDIATELY and push whatever cached bitmaps we
 *    have for them — NO capture, NO await. A target with no cached frame yet is simply hidden with no
 *    bitmap (blank — the same fallback as a capture failure), never occluding the menu.
 *  - Restore: bump the episode token (cancels any in-flight warm capture from being applied), show the
 *    live views, clear the bitmaps, and schedule a debounced cache refresh for next time.
 *  - Warm: capture a view to the cache WHILE it is live + visible (a hidden view captures blank). Never
 *    captures while suppressed; throttled per target so it can't thrash `capturePage`.
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
  /** Push the cached bitmaps to the renderer to paint behind the (now hidden) views. */
  showFreeze: (frames: Record<string, string>) => void
  /** Drop the freeze-frame bitmaps in the renderer (restore = show live again). */
  clearFreeze: () => void
}

export interface FreezeController {
  /** A suppression episode began (first overlay acquired). Hides live views synchronously. */
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
  /**
   * Warm the freeze-frame cache for ONE target (call while it is live + visible — e.g. when its
   * webContents finishes loading). No-op while suppressed or inside the per-target throttle window.
   */
  warmTarget: (target: FreezeTarget) => void
  /**
   * Warm the cache for ALL currently-visible targets (e.g. after a game-state change), so the next
   * menu-open reflects it. Throttled per target; no-op while suppressed.
   */
  warmVisible: () => void
}

/** Minimum interval between captures of the same target — keeps `capturePage` frequency low. */
const WARM_THROTTLE_MS = 1500
/** Debounce after a restore before refreshing the cache, so back-to-back opens don't thrash captures. */
const RESTORE_REFRESH_MS = 250

export function createFreezeController(effects: FreezeEffects): FreezeController {
  let suppressed = false
  // Bumped on every suppress/restore transition; an in-flight warm capture checks it before writing to
  // the cache so a transition that lands mid-capture drops the (now potentially transitional) frame.
  let episode = 0
  // The most recent good still per target id. Populated only while live + visible; read on suppress.
  const cache = new Map<string, string>()
  // When each target's LAST capture was started (Date.now), for the per-target throttle.
  const lastCaptureAt = new Map<string, number>()
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  // Capture a single live target into the cache. Guards: never while suppressed (a hidden view captures
  // blank), never more than once per WARM_THROTTLE_MS per target, and drop the result if a suppress/
  // restore transition happened since we started (stale). A failed/empty capture keeps the last good frame.
  const warm = (target: FreezeTarget): void => {
    if (suppressed) return
    const now = Date.now()
    if (now - (lastCaptureAt.get(target.id) ?? 0) < WARM_THROTTLE_MS) return
    lastCaptureAt.set(target.id, now)
    const token = episode
    target
      .capture()
      .then((url) => {
        if (token !== episode || suppressed) return
        if (url) cache.set(target.id, url)
      })
      .catch(() => {})
  }

  const warmVisible = (): void => {
    if (suppressed) return
    for (const t of effects.visibleTargets()) warm(t)
  }

  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      warmVisible()
    }, RESTORE_REFRESH_MS)
  }

  const suppress = (): void => {
    if (suppressed) return
    suppressed = true
    ++episode // cancel any in-flight warm capture from being written to the cache
    const targets = effects.visibleTargets()
    if (targets.length === 0) return
    // SYNC hot path: hide every live view immediately (the menu must not be occluded) and paint the
    // cached still behind it. No capture, no await here — that wait was the visible lag we removed.
    const frames: Record<string, string> = {}
    for (const t of targets) {
      t.setVisible(false)
      const url = cache.get(t.id)
      if (url) frames[t.id] = url // no cached frame yet → hidden with no bitmap (blank), never occluding
    }
    if (Object.keys(frames).length > 0) effects.showFreeze(frames)
  }

  const restore = (): void => {
    if (!suppressed) return
    suppressed = false
    episode++ // cancel any in-flight warm capture from being applied
    for (const t of effects.visibleTargets()) t.setVisible(true)
    effects.clearFreeze()
    // Freshen the cache now that the views are live again, so the NEXT open has an up-to-date still.
    scheduleRefresh()
  }

  const onTargetCreated = (target: FreezeTarget): void => {
    // Created under an open menu → keep it hidden (no freeze-frame; it wasn't on screen to capture).
    if (suppressed) target.setVisible(false)
  }

  return {
    suppress,
    restore,
    isSuppressed: () => suppressed,
    onTargetCreated,
    warmTarget: warm,
    warmVisible
  }
}
