/**
 * Per-endpoint RPM rate limiter (workflow spec §9 / D9). Presets that share an endpoint share one
 * budget (provider limits are per-account/endpoint), so the window is keyed by endpoint, not preset.
 * `acquire` resolves immediately while the sliding 60s window has room; otherwise the caller waits
 * in a FIFO queue until the oldest send ages out — requests are DELAYED, never dropped. A queued
 * acquire whose AbortSignal fires (Stop / turn abort) drops out of the queue instead of firing late.
 *
 * The limit itself travels with the caller (each preset's `rpm_limit`), so two presets on one
 * endpoint with different declared limits each gate against their own number over the shared window.
 */

const WINDOW_MS = 60_000

interface Waiter {
  rpm: number
  resolve: () => void
  reject: (e: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface Bucket {
  /** Send timestamps within the last WINDOW_MS (pruned lazily), oldest first. */
  stamps: number[]
  queue: Waiter[]
  timer?: ReturnType<typeof setTimeout>
}

const buckets = new Map<string, Bucket>()

const abortError = (): Error => {
  const e = new Error('RPM queue: request aborted before sending')
  e.name = 'AbortError'
  return e
}

const prune = (b: Bucket, now: number): void => {
  while (b.stamps.length && b.stamps[0] <= now - WINDOW_MS) b.stamps.shift()
}

/** Resolve as many queued waiters as the window now allows, then re-arm the wake timer. */
const drain = (key: string): void => {
  const b = buckets.get(key)
  if (!b) return
  if (b.timer) {
    clearTimeout(b.timer)
    b.timer = undefined
  }
  const now = Date.now()
  prune(b, now)
  while (b.queue.length && b.stamps.length < b.queue[0].rpm) {
    const w = b.queue.shift()!
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
    b.stamps.push(now)
    w.resolve()
  }
  if (b.queue.length) {
    // The head needs (stamps.length - rpm + 1) oldest sends to age out; wake when the decisive one does.
    const head = b.queue[0]
    const decisive = b.stamps[Math.max(0, b.stamps.length - head.rpm)]
    b.timer = setTimeout(() => drain(key), Math.max(10, decisive + WINDOW_MS - now))
  } else if (!b.stamps.length) {
    buckets.delete(key) // idle bucket — don't accumulate per-endpoint state forever
  }
}

/**
 * Acquire a send slot for `key` under an `rpm` requests-per-minute budget. `rpm <= 0` = unlimited
 * (no-op). Resolves when the caller may send; rejects with an AbortError if `signal` fires while
 * still queued (an already-sent request is the fetch signal's business, not ours).
 */
export const acquireRpmSlot = (key: string, rpm: number, signal?: AbortSignal): Promise<void> => {
  if (!rpm || rpm <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError())

  let b = buckets.get(key)
  if (!b) {
    b = { stamps: [], queue: [] }
    buckets.set(key, b)
  }
  const now = Date.now()
  prune(b, now)
  if (!b.queue.length && b.stamps.length < rpm) {
    b.stamps.push(now)
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { rpm, resolve, reject, signal }
    if (signal) {
      w.onAbort = (): void => {
        const idx = b!.queue.indexOf(w)
        if (idx !== -1) b!.queue.splice(idx, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', w.onAbort, { once: true })
    }
    b!.queue.push(w)
    if (!b!.timer) {
      const decisive = b!.stamps[Math.max(0, b!.stamps.length - rpm)]
      b!.timer = setTimeout(() => drain(key), Math.max(10, (decisive ?? now) + WINDOW_MS - now))
    }
  })
}

/** Test hook: drop all windows, queues and timers (queued waiters are rejected as aborted). */
export const resetRpmLimiter = (): void => {
  for (const b of buckets.values()) {
    if (b.timer) clearTimeout(b.timer)
    for (const w of b.queue) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
      w.reject(abortError())
    }
  }
  buckets.clear()
}
