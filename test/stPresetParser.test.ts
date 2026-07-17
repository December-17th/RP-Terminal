import { describe, it, expect } from 'vitest'
import { parseStPreset } from '../src/main/parsers/stPresetParser'

describe('parseStPreset', () => {
  it('returns null for non-preset input', () => {
    expect(parseStPreset(null, 'x')).toBeNull()
    expect(parseStPreset({}, 'x')).toBeNull()
    expect(parseStPreset({ prompts: 'nope' }, 'x')).toBeNull()
  })

  it('maps ST identifiers to dynamic markers and dedupes duplicates', () => {
    const preset = parseStPreset(
      {
        name: 'Test',
        prompts: [
          { identifier: 'charDescription', name: 'Char' },
          { identifier: 'personaDescription', name: 'Persona' },
          { identifier: 'worldInfoBefore', name: 'WIB' },
          { identifier: 'worldInfoAfter', name: 'WIA' }, // dup world_info -> dropped
          { identifier: 'chatHistory', name: 'Hist' }
        ]
      },
      'fallback'
    )
    const markers = preset.prompts.map((p: any) => p.marker)
    expect(markers).toEqual([
      'char_description',
      'persona_description',
      'world_info',
      'chat_history'
    ])
  })

  it('honors prompt_order (order + enabled) over raw prompt order', () => {
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'main', name: 'Main', content: 'hello', role: 'system' },
          { identifier: 'jailbreak', name: 'JB', content: 'jb', role: 'system' }
        ],
        prompt_order: [
          {
            character_id: 100,
            order: [
              { identifier: 'jailbreak', enabled: true },
              { identifier: 'main', enabled: false }
            ]
          }
        ]
      },
      'fallback'
    )
    expect(preset.prompts.map((p: any) => p.identifier)).toEqual(['jailbreak', 'main'])
    expect(preset.prompts.find((p: any) => p.identifier === 'main').enabled).toBe(false)
  })

  it('selects the character_id 100001 order list when multiple lists exist', () => {
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'alpha', name: 'Alpha', content: 'glorp wibble', role: 'system' },
          { identifier: 'beta', name: 'Beta', content: 'zonk frit', role: 'system' }
        ],
        prompt_order: [
          {
            character_id: 42,
            order: [
              { identifier: 'alpha', enabled: true },
              { identifier: 'beta', enabled: true }
            ]
          },
          {
            character_id: 100001,
            order: [
              { identifier: 'beta', enabled: true },
              { identifier: 'alpha', enabled: false }
            ]
          }
        ]
      },
      'fallback'
    )
    // Order + enablement come from the 100001 record, not the first list.
    expect(preset.prompts.map((p: any) => p.identifier)).toEqual(['beta', 'alpha'])
    expect(preset.prompts.find((p: any) => p.identifier === 'alpha').enabled).toBe(false)
  })

  it('takes enablement from the order entry alone, ignoring prompt-object enabled', () => {
    const preset = parseStPreset(
      {
        prompts: [
          // Literal block disabled at the prompt-object level...
          { identifier: 'kappa', name: 'Kappa', content: 'murble snix', enabled: false }
        ],
        prompt_order: [
          {
            character_id: 100001,
            // ...but ENABLED in the order entry — the order entry wins.
            order: [{ identifier: 'kappa', enabled: true }]
          }
        ]
      },
      'fallback'
    )
    expect(preset.prompts.find((p: any) => p.identifier === 'kappa').enabled).toBe(true)
  })

  it('skips folded identifiers and contentless literal blocks', () => {
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'charPersonality', content: 'folded away' }, // skipped
          { identifier: 'empty', content: '' }, // contentless literal -> dropped
          { identifier: 'note', content: 'keep me' }
        ]
      },
      'fallback'
    )
    expect(preset.prompts.map((p: any) => p.identifier)).toEqual(['note'])
  })

  it('maps sampler params (temperature, openai_max_tokens)', () => {
    const preset = parseStPreset(
      { prompts: [], temperature: 0.7, openai_max_tokens: 1234, top_p: 0.95 },
      'fallback'
    )
    expect(preset.parameters.temperature).toBe(0.7)
    expect(preset.parameters.max_tokens).toBe(1234)
    expect(preset.parameters.top_p).toBe(0.95)
  })

  it('maps ST per-prompt injection_position/depth onto injection_depth', () => {
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'atDepth', content: 'x', injection_position: 1, injection_depth: 3 },
          { identifier: 'atDepthDefault', content: 'y', injection_position: 1 },
          { identifier: 'inline', content: 'z', injection_position: 0 }
        ]
      },
      'f'
    )
    const by = (id: string): any => preset.prompts.find((p: any) => p.identifier === id)
    expect(by('atDepth').injection_depth).toBe(3)
    expect(by('atDepthDefault').injection_depth).toBe(4) // ST default depth
    expect(by('inline').injection_depth).toBeNull()
  })

  it('falls back to defaults and the fallback name', () => {
    const preset = parseStPreset({ prompts: [] }, 'My Fallback')
    expect(preset.name).toBe('My Fallback')
    expect(preset.parameters.temperature).toBe(0.9)
    expect(preset.parameters.max_tokens).toBe(4000)
  })
})
