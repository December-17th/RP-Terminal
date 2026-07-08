import { describe, it, expect, vi } from 'vitest'
import { createOverlayController, type OverlayEffects } from '../src/main/services/wcvOverlay'
import { createFreezeController, type FreezeTarget } from '../src/main/services/wcvFreezeFrame'

function harness() {
  const open = vi.fn()
  const close = vi.fn()
  const warn = vi.fn()
  const effects: OverlayEffects = { open, close, warn }
  return { effects, open, close, warn, c: createOverlayController(effects) }
}

const decl = (entry = 'data:text/html,<b>sheet</b>', title?: string) => ({ entry, title })

describe('createOverlayController — the one-at-a-time raise/dismiss + reject logic (PM-A7)', () => {
  it('a declared id mounts the surface over the play area and becomes current', () => {
    const { c, open, warn } = harness()
    const ok = c.request('partner', decl('data:sheet', '薇拉'))
    expect(ok).toBe(true)
    expect(c.current()).toBe('partner')
    expect(open).toHaveBeenCalledWith('partner', { entry: 'data:sheet', title: '薇拉' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('closeOverlay unmounts the current overlay (a no-op when none is open)', () => {
    const { c, close } = harness()
    c.request('partner', decl())
    close.mockClear()
    c.dismiss()
    expect(close).toHaveBeenCalledWith('partner')
    expect(c.current()).toBeNull()
    // Second dismiss with nothing open → no further close.
    close.mockClear()
    c.dismiss()
    expect(close).not.toHaveBeenCalled()
  })

  it('a second request for a DIFFERENT id closes the first, then opens the second (swap)', () => {
    const { c, open, close } = harness()
    c.request('partner', decl('data:a'))
    open.mockClear()
    c.request('map', decl('data:b'))
    expect(close).toHaveBeenCalledWith('partner') // previous closed first
    expect(open).toHaveBeenCalledWith('map', { entry: 'data:b', title: undefined })
    expect(c.current()).toBe('map')
  })

  it('requesting the already-open id is idempotent (stays open, no re-open)', () => {
    const { c, open, close } = harness()
    c.request('partner', decl('data:a'))
    open.mockClear()
    const ok = c.request('partner', decl('data:a'))
    expect(ok).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(c.current()).toBe('partner')
  })

  it('an UNDECLARED id (null decl) is rejected + warned, nothing opens', () => {
    const { c, open, warn } = harness()
    const ok = c.request('bogus', null)
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith('bogus')
    expect(open).not.toHaveBeenCalled()
    expect(c.current()).toBeNull()
  })

  it('a rejected request while another overlay is open leaves the open one untouched', () => {
    const { c, open, close } = harness()
    c.request('partner', decl('data:a'))
    open.mockClear()
    close.mockClear()
    const ok = c.request('bogus', null)
    expect(ok).toBe(false)
    expect(close).not.toHaveBeenCalled() // the live overlay is NOT torn down
    expect(c.current()).toBe('partner')
  })
})

describe('an open overlay participates in freeze-frame like any other WCV slot (PM-A7 × PM-A4)', () => {
  it('the reserved overlay:<id> slot is enumerated, pre-cached, then hidden from its cached still under a TopStrip dropdown', async () => {
    // The overlay is a normal WcvPanel under slot id `overlay:<id>`, so it lands in main's slot map and
    // is returned by the freeze controller's visibleTargets enumeration — no overlay-specific freeze code.
    // Freeze-precache: the still is captured WHILE the overlay is live (warm), and suppress hides
    // synchronously from that cache — no capture on the menu-open hot path.
    const setVisible = vi.fn()
    const capture = vi.fn(() => Promise.resolve('data:frame'))
    const overlayTarget: FreezeTarget = { id: 'overlay:partner', capture, setVisible }
    const showFreeze = vi.fn()
    const fc = createFreezeController({
      visibleTargets: () => [overlayTarget],
      showFreeze,
      clearFreeze: vi.fn()
    })
    fc.warmTarget(overlayTarget) // captured while live + visible
    await new Promise((r) => setTimeout(r, 0))
    capture.mockClear()

    fc.suppress()
    expect(setVisible).toHaveBeenCalledWith(false)
    expect(showFreeze).toHaveBeenCalledWith({ 'overlay:partner': 'data:frame' })
    expect(capture).not.toHaveBeenCalled() // no capture on the suppress hot path
  })
})
