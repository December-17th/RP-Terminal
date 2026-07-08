import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createFreezeController,
  type FreezeTarget,
  type FreezeEffects
} from '../src/main/services/wcvFreezeFrame'

// A deferred capture: resolves only when we call .resolve(url), so a test can interleave a
// suppress/restore transition between "capture requested" and "capture arrived".
function deferredCapture(): {
  capture: () => Promise<string | null>
  resolve: (url: string | null) => void
  reject: (err: unknown) => void
} {
  let resolve!: (url: string | null) => void
  let reject!: (err: unknown) => void
  const p = new Promise<string | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { capture: () => p, resolve, reject }
}

type Tgt = FreezeTarget & {
  setVisible: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
}

function target(id: string, capture: () => Promise<string | null>): Tgt {
  return { id, capture: vi.fn(capture), setVisible: vi.fn() }
}

function harness(targets: Tgt[]) {
  const showFreeze = vi.fn()
  const clearFreeze = vi.fn()
  const effects: FreezeEffects = {
    visibleTargets: () => targets,
    showFreeze,
    clearFreeze
  }
  return { effects, showFreeze, clearFreeze }
}

// Let all pending microtasks (the capture().then chain) flush.
const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve())

describe('createFreezeController — freeze-precache: suppress hides synchronously from a cached still', () => {
  it('suppress with a WARM cache hides every view synchronously + shows cached frames (no capture on the hot path)', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const b = target('static:world', () => Promise.resolve('data:b'))
    const { effects, showFreeze } = harness([a, b])
    const c = createFreezeController(effects)

    // Warm the cache while the views are live + visible.
    c.warmTarget(a)
    c.warmTarget(b)
    await flush()
    a.capture.mockClear()
    b.capture.mockClear()

    c.suppress()
    // SYNCHRONOUS: hidden immediately, cached frames pushed, no await needed.
    expect(c.isSuppressed()).toBe(true)
    expect(a.setVisible).toHaveBeenCalledWith(false)
    expect(b.setVisible).toHaveBeenCalledWith(false)
    expect(showFreeze).toHaveBeenCalledWith({ 'static:self': 'data:a', 'static:world': 'data:b' })
    // The hot path must NOT capture — that async wait was the removed menu lag.
    expect(a.capture).not.toHaveBeenCalled()
    expect(b.capture).not.toHaveBeenCalled()
  })

  it('suppress with a COLD cache hides synchronously but shows no bitmap (blank fallback)', () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects, showFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.suppress() // never warmed
    expect(a.setVisible).toHaveBeenCalledWith(false)
    expect(a.capture).not.toHaveBeenCalled()
    expect(showFreeze).not.toHaveBeenCalled()
  })

  it('suppress with a PARTIALLY warm cache hides all, shows only the cached frames', async () => {
    const warm = target('static:self', () => Promise.resolve('data:a'))
    const cold = target('static:world', () => Promise.resolve('data:b'))
    const { effects, showFreeze } = harness([warm, cold])
    const c = createFreezeController(effects)

    c.warmTarget(warm) // only one warmed
    await flush()

    c.suppress()
    expect(warm.setVisible).toHaveBeenCalledWith(false)
    expect(cold.setVisible).toHaveBeenCalledWith(false)
    expect(showFreeze).toHaveBeenCalledWith({ 'static:self': 'data:a' })
  })

  it('a failed / empty warm capture leaves the cache empty (that view blanks on suppress)', async () => {
    const empty = target('static:mid', () => Promise.resolve(null)) // mid-load / zero-size
    const thrown = target('static:err', () => Promise.reject(new Error('destroyed')))
    const { effects, showFreeze } = harness([empty, thrown])
    const c = createFreezeController(effects)

    c.warmTarget(empty)
    c.warmTarget(thrown)
    await flush()

    c.suppress()
    expect(empty.setVisible).toHaveBeenCalledWith(false)
    expect(thrown.setVisible).toHaveBeenCalledWith(false)
    expect(showFreeze).not.toHaveBeenCalled()
  })

  it('a later good warm replaces an earlier empty one in the cache', async () => {
    vi.useFakeTimers()
    try {
      let call = 0
      const results = [Promise.resolve(null), Promise.resolve('data:good')]
      const a = target('static:self', () => results[call++])
      const { effects, showFreeze } = harness([a])
      const c = createFreezeController(effects)

      c.warmTarget(a) // empty → nothing cached
      await flush()
      vi.advanceTimersByTime(2000) // clear the throttle window
      c.warmTarget(a) // succeeds → cached
      await flush()

      c.suppress()
      expect(showFreeze).toHaveBeenCalledWith({ 'static:self': 'data:good' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('restore shows the live views again and clears the freeze', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects, clearFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.warmTarget(a)
    await flush()
    c.suppress()
    a.setVisible.mockClear()

    c.restore()
    expect(c.isSuppressed()).toBe(false)
    expect(a.setVisible).toHaveBeenCalledWith(true)
    expect(clearFreeze).toHaveBeenCalledTimes(1)
  })
})

describe('createFreezeController — cache warming (throttle, after-restore refresh, suppressed guard)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never captures while suppressed', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects } = harness([a])
    const c = createFreezeController(effects)

    c.suppress()
    c.warmTarget(a)
    c.warmVisible()
    await Promise.resolve()
    expect(a.capture).not.toHaveBeenCalled()
  })

  it('throttles repeated warms of the same target to at most once per interval', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects } = harness([a])
    const c = createFreezeController(effects)

    c.warmTarget(a)
    c.warmTarget(a) // within the throttle window → skipped
    expect(a.capture).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1600) // past the throttle window
    c.warmTarget(a)
    expect(a.capture).toHaveBeenCalledTimes(2)
  })

  it('restore schedules a debounced cache refresh of the now-visible views', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects } = harness([a])
    const c = createFreezeController(effects)

    // Warm once, then suppress/restore. The restore refresh is debounced.
    c.warmTarget(a)
    await Promise.resolve()
    vi.advanceTimersByTime(1600) // clear the throttle so the refresh can capture
    a.capture.mockClear()

    c.suppress()
    c.restore()
    expect(a.capture).not.toHaveBeenCalled() // not synchronously
    vi.advanceTimersByTime(300) // past the debounce
    expect(a.capture).toHaveBeenCalledTimes(1)
  })

  it('warmVisible warms every currently-visible target (throttled per target)', () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const b = target('static:world', () => Promise.resolve('data:b'))
    const { effects } = harness([a, b])
    const c = createFreezeController(effects)

    c.warmVisible()
    expect(a.capture).toHaveBeenCalledTimes(1)
    expect(b.capture).toHaveBeenCalledTimes(1)
    c.warmVisible() // throttled
    expect(a.capture).toHaveBeenCalledTimes(1)
    expect(b.capture).toHaveBeenCalledTimes(1)
  })
})

describe('createFreezeController — episode guard drops stale warm work', () => {
  it('a warm capture that lands after a suppress/restore transition is NOT written to the cache', async () => {
    const d = deferredCapture()
    const a = target('static:self', d.capture)
    const { effects, showFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.warmTarget(a) // capture pending (episode 0)
    c.suppress() // episode 1 — hides from the (empty) cache
    c.restore() // episode 2
    showFreeze.mockClear()

    d.resolve('data:late') // the warm capture finally lands — must be dropped (episode moved on)
    await flush()

    // The stale frame was NOT cached, so a fresh suppress still finds nothing to show.
    c.suppress()
    expect(showFreeze).not.toHaveBeenCalled()
  })

  it('suppress with no visible views does nothing but flip the flag (no showFreeze)', () => {
    const { effects, showFreeze } = harness([])
    const c = createFreezeController(effects)
    c.suppress()
    expect(c.isSuppressed()).toBe(true)
    expect(showFreeze).not.toHaveBeenCalled()
  })

  it('nested suppress/restore is idempotent at the controller (refcount lives in the caller)', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects, showFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.warmTarget(a)
    await flush()

    c.suppress()
    c.suppress() // a second suppress while already suppressed is a no-op
    expect(showFreeze).toHaveBeenCalledTimes(1)

    c.restore()
    c.restore() // a second restore while already restored is a no-op
    expect(c.isSuppressed()).toBe(false)
  })

  it('a view created while suppressed starts hidden (no freeze-frame — it was never on screen)', () => {
    const { effects } = harness([])
    const c = createFreezeController(effects)
    c.suppress()

    const late = target('static:late', () => Promise.resolve('data:late'))
    c.onTargetCreated(late)
    expect(late.setVisible).toHaveBeenCalledWith(false)
  })

  it('a view created while NOT suppressed is left alone', () => {
    const { effects } = harness([])
    const c = createFreezeController(effects)

    const t = target('static:x', () => Promise.resolve('data:x'))
    c.onTargetCreated(t)
    expect(t.setVisible).not.toHaveBeenCalled()
  })
})
