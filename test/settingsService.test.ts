import { describe, it, expect } from 'vitest'
import { normalize, getDefaultSettings } from '../src/main/services/settingsService'

describe('settings normalize', () => {
  it('seeds a single "Default" API preset from the live api block when none exist', () => {
    const s = normalize({
      api: {
        provider: 'anthropic',
        endpoint: 'https://x',
        api_key: 'k',
        model: 'm',
        default_params: {}
      }
    })
    expect(s.api_presets).toHaveLength(1)
    expect(s.api_presets[0]).toMatchObject({
      id: 'default',
      name: 'Default',
      provider: 'anthropic',
      endpoint: 'https://x',
      api_key: 'k',
      model: 'm'
    })
    expect(s.active_api_preset_id).toBe('default')
  })

  it('fills defaults for an empty input', () => {
    const s = normalize({})
    expect(s.persona).toEqual({ name: 'User', description: '', inject: true, depth: null })
    expect(s.generation.max_context_tokens).toBe(32000)
    expect(s.ui.font_size).toBe(16)
  })

  it('merges per-section so a partial section keeps the other defaults', () => {
    const s = normalize({ ui: { font_size: 22 } as any, persona: { name: 'Lyra' } as any })
    expect(s.ui.font_size).toBe(22)
    expect(s.ui.theme).toBe('dark') // default preserved
    expect(s.ui.show_fps).toBe(false)
    expect(s.persona.name).toBe('Lyra')
    expect(s.persona.inject).toBe(true) // default preserved
  })

  it('repairs an active_api_preset_id that points at no existing preset', () => {
    const s = normalize({
      api_presets: [{ id: 'a', name: 'A', provider: 'openai', endpoint: '', api_key: '', model: '' }],
      active_api_preset_id: 'gone'
    })
    expect(s.active_api_preset_id).toBe('a')
  })

  it('keeps an existing preset set instead of reseeding', () => {
    const presets = [
      { id: 'a', name: 'A', provider: 'openai', endpoint: '', api_key: '', model: '' },
      { id: 'b', name: 'B', provider: 'anthropic', endpoint: '', api_key: '', model: '' }
    ]
    const s = normalize({ api_presets: presets, active_api_preset_id: 'b' })
    expect(s.api_presets).toHaveLength(2)
    expect(s.active_api_preset_id).toBe('b')
  })

  it('getDefaultSettings has no presets (they are seeded by normalize)', () => {
    expect(getDefaultSettings().api_presets).toEqual([])
  })
})
