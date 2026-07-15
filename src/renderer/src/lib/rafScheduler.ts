/**
 * Frame-coalescing scheduler. Many high-frequency events (raw scroll, mousemove during a drag) can
 * request the same piece of work; this collapses them to at most ONE run per animation frame — the
 * right cadence for keeping a native overlay / layout visually in step without flooding the work.
 *
 * `schedule(cb)` registers `cb` to run on the next frame (later calls in the same frame overwrite the
 * pending callback, so pass a closure that reads the latest accumulated state). `cancel()` drops any
 * pending frame — call it on unmount / drag-end so a queued run can't fire after teardown.
 */
export function createRafScheduler(): { schedule: (cb: () => void) => void; cancel: () => void } {
  let handle = 0
  let pending: (() => void) | null = null
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(0), 16) as unknown as number
  const caf =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (h: number): void => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
  return {
    schedule(cb) {
      pending = cb
      if (handle) return
      handle = raf(() => {
        handle = 0
        const fn = pending
        pending = null
        fn?.()
      })
    },
    cancel() {
      if (handle) caf(handle)
      handle = 0
      pending = null
    }
  }
}
