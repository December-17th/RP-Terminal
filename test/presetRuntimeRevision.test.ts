import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePresetStore } from '../src/renderer/src/stores/presetStore'

afterEach(() => {
  vi.unstubAllGlobals()
  usePresetStore.setState({ runtimeRevision: 0 })
})

describe('preset runtime invalidation', () => {
  it('increments when the installed scripts for the active preset change in place', () => {
    usePresetStore.setState({ runtimeRevision: 4 })
    usePresetStore.getState().invalidateRuntime()
    expect(usePresetStore.getState().runtimeRevision).toBe(5)
  })

  it('increments after switching the active preset', async () => {
    const setActivePreset = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        setActivePreset,
        getPreset: vi.fn().mockResolvedValue({
          name: 'Second',
          parameters: { temperature: 0.7, max_tokens: 100 },
          prompts: []
        })
      }
    })
    usePresetStore.setState({ activeId: 'first', runtimeRevision: 7 })

    await usePresetStore.getState().select('profile', 'second')

    expect(setActivePreset).toHaveBeenCalledWith('profile', 'second')
    expect(usePresetStore.getState().activeId).toBe('second')
    expect(usePresetStore.getState().runtimeRevision).toBe(8)
  })
})
