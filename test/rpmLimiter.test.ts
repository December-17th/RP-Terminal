import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  acquireConcurrencySlot,
  acquireRpmSlot,
  resetRpmLimiter
} from '../src/main/services/rpmLimiter'

// Sliding-window RPM limiter (workflow spec §9 / D9): under-limit acquires resolve immediately,
// over-limit acquires wait FIFO until the window frees, and a queued acquire aborted by Stop
// drops out instead of firing late.

/** Track a promise's settlement without awaiting it (so fake time can advance in between). */
const probe = (
  p: Promise<void>
): { done: () => boolean; rejected: () => boolean; err: () => Error | undefined } => {
  let done = false
  let rejected = false
  let err: Error | undefined
  p.then(
    () => {
      done = true
    },
    (e) => {
      rejected = true
      err = e
    }
  )
  return { done: () => done, rejected: () => rejected, err: () => err }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('rpmLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    resetRpmLimiter()
    vi.useRealTimers()
  })

  it('rpm <= 0 means unlimited (always immediate)', async () => {
    for (let i = 0; i < 50; i++) await acquireRpmSlot('ep', 0)
    for (let i = 0; i < 50; i++) await acquireRpmSlot('ep', -1)
  })

  it('resolves immediately while the window has room', async () => {
    const a = probe(acquireRpmSlot('ep', 3))
    const b = probe(acquireRpmSlot('ep', 3))
    const c = probe(acquireRpmSlot('ep', 3))
    await flush()
    expect(a.done() && b.done() && c.done()).toBe(true)
  })

  it('delays the over-limit request until the oldest send ages out (delay, not drop)', async () => {
    await acquireRpmSlot('ep', 2)
    vi.advanceTimersByTime(1000)
    await acquireRpmSlot('ep', 2)

    const third = probe(acquireRpmSlot('ep', 2))
    await flush()
    expect(third.done()).toBe(false)

    // First send was at t=0; its slot frees at t=60s. We're at t=1s → not yet at 58s more.
    vi.advanceTimersByTime(58_000)
    await flush()
    expect(third.done()).toBe(false)

    vi.advanceTimersByTime(1_100)
    await flush()
    expect(third.done()).toBe(true)
  })

  it('wakes queued waiters in FIFO order as slots free', async () => {
    await acquireRpmSlot('ep', 1)
    const order: string[] = []
    acquireRpmSlot('ep', 1).then(() => order.push('a'))
    acquireRpmSlot('ep', 1).then(() => order.push('b'))
    await flush()
    expect(order).toEqual([])

    vi.advanceTimersByTime(60_100)
    await flush()
    expect(order).toEqual(['a'])

    vi.advanceTimersByTime(60_100)
    await flush()
    expect(order).toEqual(['a', 'b'])
  })

  it('a queued acquire aborted by its signal rejects and never takes a slot', async () => {
    await acquireRpmSlot('ep', 1)
    const ctrl = new AbortController()
    const queued = probe(acquireRpmSlot('ep', 1, ctrl.signal))
    const behind = probe(acquireRpmSlot('ep', 1))
    await flush()

    ctrl.abort()
    await flush()
    expect(queued.rejected()).toBe(true)
    expect(queued.err()?.name).toBe('AbortError')

    // The freed slot goes to the NEXT waiter, not the aborted one.
    vi.advanceTimersByTime(60_100)
    await flush()
    expect(behind.done()).toBe(true)
  })

  it('an already-aborted signal rejects without queueing', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = probe(acquireRpmSlot('ep', 5, ctrl.signal))
    await flush()
    expect(p.rejected()).toBe(true)
  })

  it('keys are independent budgets', async () => {
    await acquireRpmSlot('ep-a', 1)
    const otherKey = probe(acquireRpmSlot('ep-b', 1))
    await flush()
    expect(otherKey.done()).toBe(true)
  })

  it('an immediate acquire behind a non-empty queue waits its turn (no overtaking)', async () => {
    await acquireRpmSlot('ep', 2)
    await acquireRpmSlot('ep', 2)
    const first = probe(acquireRpmSlot('ep', 2))
    // Window has room for rpm=3 callers, but the FIFO queue is non-empty — no jumping ahead.
    const second = probe(acquireRpmSlot('ep', 3))
    await flush()
    expect(first.done()).toBe(false)
    expect(second.done()).toBe(false)

    vi.advanceTimersByTime(60_100)
    await flush()
    expect(first.done()).toBe(true)
    expect(second.done()).toBe(true)
  })
})

// Max-concurrent semaphore (spec §18 adjunct): slots are HELD until released, waiters wake FIFO
// on release, aborts drop out of the queue. No timers involved — purely release-driven.
describe('concurrency limiter', () => {
  afterEach(() => {
    resetRpmLimiter()
  })

  /** probe() for a promise resolving to the release fn. */
  const probeSem = (
    p: Promise<() => void>
  ): {
    done: () => boolean
    rejected: () => boolean
    err: () => Error | undefined
    release: () => void
  } => {
    let done = false
    let rejected = false
    let err: Error | undefined
    let rel: (() => void) | undefined
    p.then(
      (r) => {
        done = true
        rel = r
      },
      (e) => {
        rejected = true
        err = e
      }
    )
    return { done: () => done, rejected: () => rejected, err: () => err, release: () => rel?.() }
  }

  const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('max <= 0 means unlimited (always immediate, no-op release)', async () => {
    for (let i = 0; i < 20; i++) (await acquireConcurrencySlot('ep', 0))()
    for (let i = 0; i < 20; i++) (await acquireConcurrencySlot('ep', -1))()
  })

  it('holds callers over the cap until a slot is released (FIFO)', async () => {
    const a = probeSem(acquireConcurrencySlot('ep', 2))
    const b = probeSem(acquireConcurrencySlot('ep', 2))
    const c = probeSem(acquireConcurrencySlot('ep', 2))
    const d = probeSem(acquireConcurrencySlot('ep', 2))
    await flush()
    expect(a.done() && b.done()).toBe(true)
    expect(c.done() || d.done()).toBe(false)

    a.release()
    await flush()
    expect(c.done()).toBe(true)
    expect(d.done()).toBe(false)

    c.release()
    await flush()
    expect(d.done()).toBe(true)
  })

  it('release is idempotent — double release frees only one slot', async () => {
    const a = probeSem(acquireConcurrencySlot('ep', 1))
    const b = probeSem(acquireConcurrencySlot('ep', 1))
    const c = probeSem(acquireConcurrencySlot('ep', 1))
    await flush()
    expect(a.done()).toBe(true)

    a.release()
    a.release() // second call must not free b AND c
    await flush()
    expect(b.done()).toBe(true)
    expect(c.done()).toBe(false)

    b.release()
    await flush()
    expect(c.done()).toBe(true)
  })

  it('a queued acquire aborted by its signal rejects; the released slot goes to the next waiter', async () => {
    const a = probeSem(acquireConcurrencySlot('ep', 1))
    const ctrl = new AbortController()
    const queued = probeSem(acquireConcurrencySlot('ep', 1, ctrl.signal))
    const behind = probeSem(acquireConcurrencySlot('ep', 1))
    await flush()
    expect(a.done()).toBe(true)

    ctrl.abort()
    await flush()
    expect(queued.rejected()).toBe(true)
    expect(queued.err()?.name).toBe('AbortError')

    a.release()
    await flush()
    expect(behind.done()).toBe(true)
  })

  it('an already-aborted signal rejects without taking a slot', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = probeSem(acquireConcurrencySlot('ep', 5, ctrl.signal))
    await flush()
    expect(p.rejected()).toBe(true)

    const next = probeSem(acquireConcurrencySlot('ep', 1))
    await flush()
    expect(next.done()).toBe(true)
  })

  it('keys are independent caps', async () => {
    probeSem(acquireConcurrencySlot('ep-a', 1))
    const other = probeSem(acquireConcurrencySlot('ep-b', 1))
    await flush()
    expect(other.done()).toBe(true)
  })
})
