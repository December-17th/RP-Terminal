// test/thRuntimePreset.test.ts
//
// Issue 19 item 1: getPreset('in_use') returns the real TavernHelper preset shape (incl. a live `prompts`
// array — the 狐神抚 control surface) and prompt-choice mutations persist through host.savePreset. Both
// transports inherit this from the shared runtime, so testing the runtime over a fake host covers both.
import { describe, it, expect } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import { mapPresetToThShape, mergePresetView } from '../src/shared/thRuntime/presetShape'
import type { Host, HostPresetView } from '../src/shared/thRuntime/types'

const view = (): HostPresetView => ({
  name: 'My Preset',
  parameters: { temperature: 0.7, max_tokens: 2000 },
  prompts: [
    {
      id: 'main',
      identifier: 'main',
      name: 'Main',
      role: 'system',
      content: 'sys',
      enabled: true,
      marker: 'none',
      injection_depth: null,
      injection_order: 100
    },
    {
      id: 'jailbreak',
      identifier: 'jailbreak',
      name: 'JB',
      role: 'system',
      content: 'jb',
      enabled: true,
      marker: 'none',
      injection_depth: null,
      injection_order: 100
    }
  ],
  prompts_unused: [
    {
      id: 'spare',
      identifier: 'spare',
      name: 'Spare',
      role: 'user',
      content: 'x',
      enabled: false,
      injection_depth: null,
      injection_order: 100
    }
  ],
  extensions: { SPreset: { RegexBinding: { enabled: true } } }
})

function hostWith(): { host: Host; saved: unknown[] } {
  const saved: unknown[] = []
  const host: Host = {
    ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
    preset: () => view(),
    presetNames: () => ['My Preset', 'Other'],
    savePreset: async (p) => {
      saved.push(p)
      return true
    }
  }
  return { host, saved }
}

describe('getPreset("in_use") — TavernHelper shape (spec §7)', () => {
  it('maps the normalized view to { name, settings, parameters, prompts, prompts_unused, extensions }', () => {
    const { host } = hostWith()
    const rt = createThRuntime(host) as any
    const p = rt.getPreset('in_use')
    expect(p.name).toBe('My Preset')
    // settings === parameters (both kept; parameters is the legacy alias cards already read)
    expect(p.settings).toEqual({ temperature: 0.7, max_tokens: 2000 })
    expect(p.parameters).toEqual({ temperature: 0.7, max_tokens: 2000 })
    expect(p.prompts.map((x: any) => x.id)).toEqual(['main', 'jailbreak'])
    expect(p.prompts[0].enabled).toBe(true)
    expect(p.prompts_unused.map((x: any) => x.id)).toEqual(['spare'])
    expect(p.extensions).toEqual({ SPreset: { RegexBinding: { enabled: true } } })
  })

  it('defaults to in_use, resolves the active name, and returns null for any other name', () => {
    const { host } = hostWith()
    const rt = createThRuntime(host) as any
    expect(rt.getPreset()).not.toBeNull() // undefined defaults to in_use
    expect(rt.getPreset('My Preset')).not.toBeNull() // the active preset's own name
    expect(rt.getPreset('Some Other Preset')).toBeNull()
    expect(rt.getLoadedPresetName()).toBe('My Preset')
  })

  it('replacePreset persists a toggled prompt through host.savePreset, keeping the untouched ones', async () => {
    const { host, saved } = hostWith()
    const rt = createThRuntime(host) as any
    const p = rt.getPreset('in_use')
    // The 狐神抚 case: card toggles ONE prompt's enabled and hands the object back.
    p.prompts.find((x: any) => x.id === 'jailbreak').enabled = false
    const ok = await rt.replacePreset('in_use', p)
    expect(ok).toBe(true)
    expect(saved).toHaveLength(1)
    const persisted = saved[0] as any
    expect(persisted.name).toBe('My Preset')
    expect(persisted.prompts.find((x: any) => x.identifier === 'main').enabled).toBe(true)
    expect(persisted.prompts.find((x: any) => x.identifier === 'jailbreak').enabled).toBe(false)
    expect(persisted.parameters.temperature).toBe(0.7)
  })

  it('updatePresetWith applies an updater over the current shape', async () => {
    const { host, saved } = hostWith()
    const rt = createThRuntime(host) as any
    await rt.updatePresetWith((preset: any) => {
      preset.prompts[0].enabled = false
      return preset
    })
    expect((saved[0] as any).prompts[0].enabled).toBe(false)
  })
})

describe('presetShape pure mappers', () => {
  it('mergePresetView never drops prompts a partial edit omits, and ignores unknown ids', () => {
    const base = view()
    const merged = mergePresetView(base, {
      prompts: [
        { identifier: 'main', enabled: false }, // toggle only main
        { identifier: 'ghost', enabled: false } // unknown id — ignored
      ]
    })
    expect(merged.prompts.map((p) => p.identifier)).toEqual(['main', 'jailbreak'])
    expect(merged.prompts[0].enabled).toBe(false)
    expect(merged.prompts[1].enabled).toBe(true) // untouched survives
  })

  it('mergePresetView overlays name + settings/parameters when present', () => {
    const merged = mergePresetView(view(), { name: 'Renamed', settings: { temperature: 0.1 } })
    expect(merged.name).toBe('Renamed')
    expect(merged.parameters.temperature).toBe(0.1)
    expect(merged.parameters.max_tokens).toBe(2000) // sibling preserved
  })

  it('mapPresetToThShape returns null for a null view', () => {
    expect(mapPresetToThShape(null)).toBeNull()
  })
})
