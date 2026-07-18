// test/thRuntimeExtensionSettings.test.ts
//
// Issue 19 item 2: getContext().extensionSettings is REAL (durable, seeded from the saved bag) and
// saveSettingsDebounced actually persists it (it was a no-op stub before). Runtime-over-fake-host, so
// both transports inherit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import type { Host } from '../src/shared/thRuntime/types'

function hostWith(seed: Record<string, any>): { host: Host; saved: Record<string, any>[] } {
  const saved: Record<string, any>[] = []
  const host: Host = {
    ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
    getExtensionSettingsSync: () => seed,
    setExtensionSettings: async (s) => {
      saved.push(s)
    }
  }
  return { host, saved }
}

describe('extensionSettings + saveSettingsDebounced (issue 19)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('seeds the bag from the saved store and force-defaults EjsTemplate.enabled', () => {
    const { host } = hostWith({ MyCard: { theme: 'dark' } })
    const rt = createThRuntime(host) as any
    const es = rt.SillyTavern.getContext().extensionSettings
    expect(es.MyCard).toEqual({ theme: 'dark' }) // saved settings survive a reload
    expect(es.EjsTemplate.enabled).toBe(true) // feature flag always present
  })

  it('saveSettingsDebounced persists the live bag through the host (was a no-op)', async () => {
    const { host, saved } = hostWith({})
    const rt = createThRuntime(host) as any
    const ctx = rt.SillyTavern.getContext()
    ctx.extensionSettings.MyCard = { level: 3 }
    ctx.saveSettingsDebounced()
    ctx.saveSettingsDebounced() // coalesced by the debounce
    expect(saved).toHaveLength(0) // not yet flushed
    await vi.advanceTimersByTimeAsync(250)
    expect(saved).toHaveLength(1)
    expect(saved[0].MyCard).toEqual({ level: 3 })
  })

  it('__rptDispose flushes a pending save so the last edit is not lost', () => {
    const { host, saved } = hostWith({})
    const rt = createThRuntime(host) as any
    rt.SillyTavern.getContext().extensionSettings.MyCard = { n: 1 }
    rt.SillyTavern.getContext().saveSettingsDebounced()
    rt.__rptDispose()
    expect(saved).toHaveLength(1)
    expect(saved[0].MyCard).toEqual({ n: 1 })
  })

  // Hydration gate: a transient seed-read failure surfaces as `undefined` (NOT an empty `{}`). A card write
  // after such a failure must NOT flush the unloaded stub over the valid stored settings.
  it('does NOT overwrite persisted settings when the seed read failed (returned undefined)', async () => {
    const saved: Record<string, any>[] = []
    const host: Host = {
      ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
      getExtensionSettingsSync: () => undefined, // transient read failure, distinct from empty {}
      setExtensionSettings: async (s) => {
        saved.push(s)
      }
    }
    const rt = createThRuntime(host) as any
    const ctx = rt.SillyTavern.getContext()
    ctx.extensionSettings.MyCard = { level: 3 } // a card write lands on the unloaded stub
    ctx.saveSettingsDebounced()
    await vi.advanceTimersByTimeAsync(250)
    expect(saved).toHaveLength(0) // gate held: stored settings not clobbered with the stub
    rt.__rptDispose() // dispose must not flush either (timer was never armed)
    expect(saved).toHaveLength(0)
  })

  it('retries a failed hydration, merges the saved bag, then persists the pending edit', async () => {
    const saved: Record<string, any>[] = []
    let reads = 0
    const host: Host = {
      ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
      getExtensionSettingsSync: () => {
        reads++
        return reads === 1 ? undefined : { ExistingCard: { keep: 'safe' } }
      },
      setExtensionSettings: async (s) => {
        saved.push(s)
      }
    }
    const rt = createThRuntime(host) as any
    const ctx = rt.SillyTavern.getContext()
    ctx.extensionSettings.MyCard = { level: 4 }
    ctx.saveSettingsDebounced()
    await vi.advanceTimersByTimeAsync(250)

    expect(reads).toBe(2)
    expect(saved).toHaveLength(1)
    expect(saved[0].ExistingCard).toEqual({ keep: 'safe' })
    expect(saved[0].MyCard).toEqual({ level: 4 })
  })

  it('warns once and bounds hydration retries while the settings store stays unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let reads = 0
    const host: Host = {
      ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
      getExtensionSettingsSync: () => {
        reads++
        return undefined
      }
    }
    const rt = createThRuntime(host) as any
    const ctx = rt.SillyTavern.getContext()
    ctx.saveSettingsDebounced()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(reads).toBe(3)
    rt.__rptDispose()
  })
})
