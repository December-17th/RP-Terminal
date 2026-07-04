import { describe, it, expect, beforeEach } from 'vitest'

// Keyed async mutex (agent-packs WP1.5; ADR 0003). Pins: strict per-key FIFO under contention,
// independent keys run concurrently, a throw releases the lock + propagates, and the per-key map
// entry self-cleans after the queue drains (no unbounded growth).

import { withLock, _lockedKeyCount } from '../src/main/services/asyncLock'

/** A deferred: a promise plus its resolve, to drive precise interleavings from the test. */
const deferred = <T>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Let all currently-queued microtasks drain (chain-cleanup runs on a microtask). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('withLock', () => {
  beforeEach(async () => {
    // Ensure a clean map between tests (the module is a singleton). Draining any prior work is enough
    // since the map self-cleans; assert it started empty so a leak in a prior test can't mask a bug.
    await flush()
    expect(_lockedKeyCount()).toBe(0)
  })

  it('serializes same-key callers in strict FIFO submission order', async () => {
    const order: number[] = []
    const gate = deferred<void>()

    // First holder blocks on `gate`; the next two are submitted while it is in flight, so they queue.
    const p1 = withLock('k', async () => {
      await gate.promise
      order.push(1)
    })
    const p2 = withLock('k', async () => {
      order.push(2)
    })
    const p3 = withLock('k', async () => {
      order.push(3)
    })

    // Nothing has run yet — the first holder is parked on the gate, the rest are queued behind it.
    await flush()
    expect(order).toEqual([])

    gate.resolve()
    await Promise.all([p1, p2, p3])
    // FIFO: submission order 1 → 2 → 3, regardless of how trivially fast 2 and 3 are.
    expect(order).toEqual([1, 2, 3])
  })

  it('runs different keys concurrently (no cross-key contention)', async () => {
    const order: string[] = []
    const gateA = deferred<void>()

    // Key A blocks; key B must NOT wait on it — it runs to completion while A is parked.
    const a = withLock('A', async () => {
      await gateA.promise
      order.push('A')
    })
    const b = withLock('B', async () => {
      order.push('B')
    })

    await b
    expect(order).toEqual(['B']) // B finished while A is still blocked

    gateA.resolve()
    await a
    expect(order).toEqual(['B', 'A'])
  })

  it('runs an uncontended synchronous fn on the fast path (side effect before return)', async () => {
    // The single-writer transparency guarantee: an idle key runs `fn` synchronously WITHIN the call,
    // so a synchronous side effect is visible before `withLock` returns (what keeps saveFloor et al.
    // synchronous). We prove it by observing the flag set before we ever await the returned promise.
    let ran = false
    const p = withLock('sync', () => {
      ran = true
      return 42
    })
    expect(ran).toBe(true) // fast path: body already executed
    await expect(p).resolves.toBe(42)
  })

  it('releases the lock and propagates when fn throws, without poisoning later holders', async () => {
    const boom = new Error('boom')
    const gate = deferred<void>()

    const failing = withLock('k', async () => {
      await gate.promise
      throw boom
    })
    // Queued behind the failing holder; must still run after it rejects (error is isolated).
    const after = withLock('k', async () => 'ok')

    gate.resolve()
    await expect(failing).rejects.toBe(boom)
    await expect(after).resolves.toBe('ok')
  })

  it('propagates a synchronous throw from an uncontended fn', async () => {
    const boom = new Error('sync-boom')
    await expect(withLock('k', () => {
      throw boom
    })).rejects.toBe(boom)
  })

  it('cleans up the per-key map entry after the queue drains (no unbounded growth)', async () => {
    // A burst of same-key work, then a burst across many distinct keys — after everything settles the
    // map must be empty (every entry self-deleted on drain).
    await Promise.all([
      withLock('x', async () => {}),
      withLock('x', async () => {}),
      withLock('x', async () => {})
    ])
    await flush()
    expect(_lockedKeyCount()).toBe(0)

    await Promise.all(Array.from({ length: 50 }, (_, i) => withLock(`key-${i}`, async () => {})))
    await flush()
    expect(_lockedKeyCount()).toBe(0)
  })

  it('keeps exactly one live entry while a single key is contended, then frees it', async () => {
    const gate = deferred<void>()
    const p1 = withLock('one', async () => {
      await gate.promise
    })
    const p2 = withLock('one', async () => {})
    // While work is in flight/queued, exactly the one key is tracked.
    expect(_lockedKeyCount()).toBe(1)
    gate.resolve()
    await Promise.all([p1, p2])
    await flush()
    expect(_lockedKeyCount()).toBe(0)
  })
})
