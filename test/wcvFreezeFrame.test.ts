import { describe, it, expect, vi } from 'vitest'
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

function target(id: string, capture: () => Promise<string | null>): FreezeTarget & {
  setVisible: ReturnType<typeof vi.fn>
} {
  return { id, capture, setVisible: vi.fn() }
}

function harness(targets: (FreezeTarget & { setVisible: ReturnType<typeof vi.fn> })[]) {
  const showFreeze = vi.fn()
  const clearFreeze = vi.fn()
  const effects: FreezeEffects = {
    visibleTargets: () => targets,
    showFreeze,
    clearFreeze
  }
  return { effects, showFreeze, clearFreeze }
}

// Let all pending microtasks (the Promise.all().then chain) flush.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createFreezeController — the capture/restore orchestration', () => {
  it('captures each visible view, then hides it and pushes the bitmaps', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const b = target('static:world', () => Promise.resolve('data:b'))
    const { effects, showFreeze } = harness([a, b])
    const c = createFreezeController(effects)

    c.suppress()
    expect(c.isSuppressed()).toBe(true)
    // Views are only hidden AFTER the capture resolves (capture-while-visible).
    expect(a.setVisible).not.toHaveBeenCalled()
    await flush()

    expect(a.setVisible).toHaveBeenCalledWith(false)
    expect(b.setVisible).toHaveBeenCalledWith(false)
    expect(showFreeze).toHaveBeenCalledWith({ 'static:self': 'data:a', 'static:world': 'data:b' })
  })

  it('restore shows the live views again and clears the freeze', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects, clearFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.suppress()
    await flush()
    a.setVisible.mockClear()

    c.restore()
    expect(c.isSuppressed()).toBe(false)
    expect(a.setVisible).toHaveBeenCalledWith(true)
    expect(clearFreeze).toHaveBeenCalledTimes(1)
  })

  it('a capture that fails / comes back empty still hides that view, with no bitmap for it', async () => {
    const ok = target('static:self', () => Promise.resolve('data:a'))
    const empty = target('static:mid', () => Promise.resolve(null)) // mid-load / zero-size
    const thrown = target('static:err', () => Promise.reject(new Error('destroyed')))
    const { effects, showFreeze } = harness([ok, empty, thrown])
    const c = createFreezeController(effects)

    c.suppress()
    await flush()

    // All three hidden (menu must not be occluded)…
    expect(ok.setVisible).toHaveBeenCalledWith(false)
    expect(empty.setVisible).toHaveBeenCalledWith(false)
    expect(thrown.setVisible).toHaveBeenCalledWith(false)
    // …but only the successful capture becomes a freeze-frame (the others fall back to blank).
    expect(showFreeze).toHaveBeenCalledWith({ 'static:self': 'data:a' })
  })

  it('if EVERY capture fails, views are hidden but showFreeze is never called (pure blank)', async () => {
    const a = target('static:self', () => Promise.resolve(null))
    const b = target('static:world', () => Promise.reject(new Error('x')))
    const { effects, showFreeze } = harness([a, b])
    const c = createFreezeController(effects)

    c.suppress()
    await flush()

    expect(a.setVisible).toHaveBeenCalledWith(false)
    expect(b.setVisible).toHaveBeenCalledWith(false)
    expect(showFreeze).not.toHaveBeenCalled()
  })

  it('rapid open→close before the capture lands: never hides, discards the stale frame', async () => {
    const d = deferredCapture()
    const a = target('static:self', d.capture)
    const { effects, showFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.suppress() // capture requested (pending)
    c.restore() // menu closed BEFORE the capture arrives

    // restore() shows the (never-hidden) live view + clears; the pending capture is now stale.
    expect(a.setVisible).toHaveBeenLastCalledWith(true)
    a.setVisible.mockClear()

    d.resolve('data:late') // the capture finally lands — must be dropped
    await flush()

    expect(a.setVisible).not.toHaveBeenCalled() // NOT hidden
    expect(showFreeze).not.toHaveBeenCalled() // stale frame discarded
  })

  it('close-then-reopen mid-capture: the first episode is dropped, the second runs fresh', async () => {
    const first = deferredCapture()
    let call = 0
    const captures = [first.capture, () => Promise.resolve('data:second')]
    const a = target('static:self', () => captures[call++]())
    const { effects, showFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.suppress() // episode 1 — capture pending
    c.restore()
    c.suppress() // episode 2 — a fresh capture (resolves immediately)
    await flush()

    // Episode 2's frame is shown…
    expect(showFreeze).toHaveBeenCalledTimes(1)
    expect(showFreeze).toHaveBeenCalledWith({ 'static:self': 'data:second' })

    // …and episode 1's late capture is ignored (no second showFreeze).
    first.resolve('data:first')
    await flush()
    expect(showFreeze).toHaveBeenCalledTimes(1)
  })

  it('suppress with no visible views does nothing but flip the flag (no showFreeze)', async () => {
    const { effects, showFreeze } = harness([])
    const c = createFreezeController(effects)
    c.suppress()
    await flush()
    expect(c.isSuppressed()).toBe(true)
    expect(showFreeze).not.toHaveBeenCalled()
  })

  it('nested suppress/restore is idempotent at the controller (refcount lives in the caller)', async () => {
    const a = target('static:self', () => Promise.resolve('data:a'))
    const { effects, showFreeze } = harness([a])
    const c = createFreezeController(effects)

    c.suppress()
    c.suppress() // a second suppress while already suppressed is a no-op
    await flush()
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
