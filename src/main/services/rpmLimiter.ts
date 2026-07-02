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

// ---------------------------------------------------------------------------
// Max-concurrent-per-endpoint cap (spec §18's optional RPM adjunct). RPM alone doesn't bound
// PARALLELISM — a multi-LLM graph can open N simultaneous requests within one window. Same
// keying/travel rules as RPM: the semaphore is per endpoint, the `max` budget travels with the
// caller's preset. Unlike RPM (fire-and-forget stamps), a concurrency slot is HELD for the whole
// request, so acquire resolves to a release function the caller must invoke in a finally.
// ---------------------------------------------------------------------------

interface SemWaiter {
  max: number
  resolve: (release: () => void) => void
  reject: (e: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface Semaphore {
  inFlight: number
  queue: SemWaiter[]
}

const semaphores = new Map<string, Semaphore>()

const semDrain = (key: string): void => {
  const s = semaphores.get(key)
  if (!s) return
  while (s.queue.length && s.inFlight < s.queue[0].max) {
    const w = s.queue.shift()!
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
    s.inFlight++
    w.resolve(makeRelease(key))
  }
  if (!s.queue.length && s.inFlight === 0) semaphores.delete(key)
}

/** One-shot releaser: decrements in-flight and wakes the queue head. Idempotent — a double
 *  release (e.g. a finally that runs twice through a retry wrapper) must not corrupt the count. */
const makeRelease = (key: string): (() => void) => {
  let released = false
  return () => {
    if (released) return
    released = true
    const s = semaphores.get(key)
    if (!s) return
    s.inFlight = Math.max(0, s.inFlight - 1)
    semDrain(key)
  }
}

/**
 * Acquire an in-flight slot for `key` under a `max` concurrent-requests budget. `max <= 0` =
 * unlimited (resolves to a no-op release). Resolves to a release function the caller MUST call
 * when the request settles (finally); rejects with an AbortError if `signal` fires while queued.
 */
export const acquireConcurrencySlot = (
  key: string,
  max: number,
  signal?: AbortSignal
): Promise<() => void> => {
  if (!max || max <= 0) return Promise.resolve(() => {})
  if (signal?.aborted) return Promise.reject(abortError())

  let s = semaphores.get(key)
  if (!s) {
    s = { inFlight: 0, queue: [] }
    semaphores.set(key, s)
  }
  if (!s.queue.length && s.inFlight < max) {
    s.inFlight++
    return Promise.resolve(makeRelease(key))
  }

  return new Promise<() => void>((resolve, reject) => {
    const w: SemWaiter = { max, resolve, reject, signal }
    if (signal) {
      w.onAbort = (): void => {
        const idx = s!.queue.indexOf(w)
        if (idx !== -1) s!.queue.splice(idx, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', w.onAbort, { once: true })
    }
    s!.queue.push(w)
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
  for (const s of semaphores.values()) {
    for (const w of s.queue) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
      w.reject(abortError())
    }
  }
  semaphores.clear()
}
