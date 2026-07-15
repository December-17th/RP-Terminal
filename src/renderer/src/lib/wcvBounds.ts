/**
 * Shared WebContentsView bounds plumbing for the two renderer hosts that push a native overlay's rect to
 * main (WcvMessageFrame, WcvPanel). Both measure their own DOM rect and clamp it differently, but the
 * tail is identical: round to integer device pixels, compare against the last rect we sent for that
 * slot, and skip a send whose rounded bounds are unchanged (a native overlay only moves on integer
 * pixels, so a sub-pixel-only change is a no-op flood). That round/compare/dedup tail lives here so both
 * hosts stay byte-identical to each other and to main-side `wcvManager.round`.
 */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Round to integer device pixels — byte-identical to main-side `wcvManager.round`
 * (src/main/services/wcvManager.ts): plain round on x/y, clamped-non-negative round on width/height.
 */
export function roundBounds(b: Bounds): Bounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  }
}

/** Exact integer-bounds equality (call on already-rounded bounds). */
export function boundsEqual(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * A per-target deduplicating sender. `send(slotId, bounds)` rounds the bounds, and only invokes `sendFn`
 * (with the RAW, unrounded bounds — main rounds again) when the rounded rect differs from the last one
 * sent for that slotId. `prime` records a slot's initial rounded rect without sending (e.g. right after
 * an ensure that already carried the initial bounds); `forget` drops a slot's entry on destroy.
 *
 * One sender may be shared across many slots (module-level, like WcvPanel's several instances) or scoped
 * to a single slot (per-effect, like WcvMessageFrame) — the slotId keying makes both safe.
 */
export function makeBoundsSender(sendFn: (slotId: string, bounds: Bounds) => void): {
  send: (slotId: string, bounds: Bounds) => void
  prime: (slotId: string, bounds: Bounds) => void
  forget: (slotId: string) => void
} {
  const lastSent = new Map<string, Bounds>()
  return {
    send(slotId, bounds) {
      const rounded = roundBounds(bounds)
      const prev = lastSent.get(slotId)
      if (prev && boundsEqual(prev, rounded)) return
      lastSent.set(slotId, rounded)
      sendFn(slotId, bounds)
    },
    prime(slotId, bounds) {
      lastSent.set(slotId, roundBounds(bounds))
    },
    forget(slotId) {
      lastSent.delete(slotId)
    }
  }
}
