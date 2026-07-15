import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'

// Spread the inert null host and override ONLY the overlay members this file exercises.
function fakeHost(over = {}) {
  return {
    ...createNullHost(),
    requestOverlay: vi.fn(async () => true),
    closeOverlay: vi.fn(async () => {}),
    ...over
  } as any
}

// PM-A7: both transports inherit the overlay API from the shared runtime — the facade forwards to the
// Host, which each transport implements over its own IPC. This pins the facade wiring (the parity seam).
describe('createThRuntime exposes the overlay API to the card page (PM-A7)', () => {
  it('forwards top-level requestOverlay(id) to host.requestOverlay (coerced to string)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    const ok = await g.requestOverlay('partner')
    expect(ok).toBe(true)
    expect(host.requestOverlay).toHaveBeenCalledWith('partner')
  })

  it('forwards closeOverlay() to host.closeOverlay', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    await g.closeOverlay()
    expect(host.closeOverlay).toHaveBeenCalled()
  })

  it('also exposes both on the TavernHelper sub-object (namespaced parity)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    expect(typeof g.TavernHelper.requestOverlay).toBe('function')
    expect(typeof g.TavernHelper.closeOverlay).toBe('function')
    await g.TavernHelper.requestOverlay('map')
    expect(host.requestOverlay).toHaveBeenCalledWith('map')
  })
})
