/**
 * Keyed async mutex — strict per-key FIFO mutual exclusion (agent-packs plan WP1.5).
 *
 * WHY THIS EXISTS — ADR 0003 (`docs/adr/0003-headless-runs-are-turn-decoupled-and-state-mediated.md`):
 * headless runs make multiple engine runs live concurrently, so a run's read-modify-write of a
 * shared resource (a memory table, a floor's variables) can interleave at its `await` points with
 * another run's, losing an update. Turns must read a CONSISTENT committed snapshot. This lock is the
 * "resource write locks … move from wishlist to required" the ADR calls out. A caller wraps its whole
 * critical section (read → await → write) in ONE `withLock(key, fn)` call; concurrent calls on the
 * SAME key run one-at-a-time in submission order, while DIFFERENT keys never contend.
 *
 * IMPLEMENTATION — a promise-chain-per-key. Each key maps to the tail promise of its queue; a new
 * acquire chains `fn` onto that tail (so it runs only after every earlier holder settles) and becomes
 * the new tail. The chain self-cleans: when the last holder drains (the tail is still the promise we
 * installed), the map entry is deleted, so idle keys leave no residue (no unbounded growth).
 *
 * FAST PATH — an UNCONTENDED synchronous `fn` runs to completion synchronously WITHIN this call
 * before it returns, because we invoke `fn()` eagerly when the key has no in-flight chain and our
 * write bodies contain no `await`. That is what keeps the single-writer path byte-identical: existing
 * synchronous callers of the wrapped services still observe their side effects synchronously; only a
 * genuinely CONCURRENT caller (whose `fn` is still settling) is deferred and serialized.
 *
 * ERRORS — a throw/reject in `fn` releases the lock (the queue advances) and PROPAGATES to that
 * caller's returned promise; it never poisons later holders on the same key.
 *
 * REENTRANCY — this mutex is NOT reentrant: calling `withLock(k, …)` for a key already held by an
 * ancestor `withLock(k, …)` on the same async stack deadlocks (the inner acquire waits on a tail that
 * only settles when the outer `fn` returns, which is waiting on the inner). Never nest same-key
 * acquisitions; wrap the OUTERMOST critical section only.
 */

/** Per-key queue tail. The value is the promise the most-recently-enqueued holder settles; a key is
 *  absent when its queue is empty (self-cleaned on drain). Untyped payloads — the tail is only ever
 *  awaited for SEQUENCING, never for its value. */
const tails = new Map<string, Promise<unknown>>()

/**
 * Run `fn` under strict FIFO mutual exclusion for `key`. Resolves/rejects with `fn`'s result; the
 * lock is released (queue advances, and the key's map entry is freed if it was the last holder) after
 * `fn` settles, whether it resolved or threw. Different keys run fully concurrently.
 */
export const withLock = <T>(key: string, fn: () => Promise<T> | T): Promise<T> => {
  // CONTENDED PATH — a holder is already tracked on this key: chain `fn` after it. `.then(fn)` is what
  // enforces FIFO: `fn` cannot start until the current tail settles. A rejecting predecessor must NOT
  // abort us (its own caller already saw the error), so swallow its outcome before running `fn`.
  if (tails.has(key)) {
    const prev = tails.get(key) as Promise<unknown>
    const run = prev.then(
      () => fn(),
      () => fn()
    )
    setTail(key, run)
    return run
  }

  // IDLE (FAST) PATH — run `fn` NOW, synchronously. This is the single-writer transparency guarantee:
  // a synchronous `fn` completes here before we return (existing sync callers see their side effect
  // immediately). We then check whether `fn` finished synchronously:
  let result: Promise<T> | T
  try {
    result = fn()
  } catch (err) {
    // Synchronous throw: the body is DONE and the key never became busy — nothing to track. Return a
    // rejected promise (async callers see the error; sync callers ignore it, exactly as before).
    return Promise.reject(err)
  }
  if (!isThenable(result)) {
    // Synchronous completion: the body already ran to the end and the key is idle again RIGHT NOW, so
    // a subsequent synchronous same-key call must ALSO hit the fast path (preserving the pre-lock
    // single-threaded ordering). We therefore do NOT install a tail — no entry to linger, no deferral.
    return Promise.resolve(result)
  }
  // Async body: it yielded a pending promise, so the key is genuinely held until it settles. Track it
  // as the tail so later acquires queue behind it.
  const run = result as Promise<T>
  setTail(key, run)
  return run
}

/** Duck-typed thenable check (a `fn` may return any Promise-like). */
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function'

/** Install `run` as the key's queue tail and arrange self-cleanup. The tail swallows `run`'s outcome
 *  so it never becomes an unhandled rejection and a later holder chaining on it isn't aborted; the
 *  entry is deleted on drain ONLY if we are still the tail (no newer holder enqueued meanwhile),
 *  keeping the map free of drained keys. */
const setTail = (key: string, run: Promise<unknown>): void => {
  const tail = run.then(
    () => {},
    () => {}
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
}

/** TEST-ONLY introspection: number of keys with an in-flight queue (should return to 0 once every
 *  holder drains). Exported so the unit test can assert the map self-cleans (no unbounded growth)
 *  without reaching into module internals. */
export const _lockedKeyCount = (): number => tails.size
