import { describe, it, expect } from 'vitest'
import { parseStPreset } from '../src/main/parsers/stPresetParser'

describe('parseStPreset', () => {
  it('returns null for non-preset input', () => {
    expect(parseStPreset(null, 'x')).toBeNull()
    expect(parseStPreset({}, 'x')).toBeNull()
    expect(parseStPreset({ prompts: 'nope' }, 'x')).toBeNull()
  })

  it('maps ST identifiers to DISTINCT markers (WI before/after no longer collapsed)', () => {
    // Behavior change (issue 11 / ADR 0016 ST 1.18.0 parity): ST keeps worldInfoBefore and
    // worldInfoAfter as separate default markers (openai.js:1367-1368), each with its own
    // role/position — RPT no longer folds them into one `world_info`.
    const preset = parseStPreset(
      {
        name: 'Test',
        prompts: [
          { identifier: 'charDescription', name: 'Char' },
          { identifier: 'personaDescription', name: 'Persona' },
          { identifier: 'worldInfoBefore', name: 'WIB' },
          { identifier: 'worldInfoAfter', name: 'WIA' },
          { identifier: 'chatHistory', name: 'Hist' }
        ]
      },
      'fallback'
    )
    const markers = preset.prompts.map((p: any) => p.marker)
    expect(markers).toEqual([
      'char_description',
      'persona_description',
      'world_info_before',
      'world_info_after',
      'chat_history'
    ])
  })

  it('maps charPersonality/scenario to their own markers (no longer folded/skipped)', () => {
    // Behavior change (issue 11): charPersonality + scenario are distinct ST markers
    // (openai.js:1370-1371), each free to take its own role/position — not folded into
    // char_description at import.
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'charDescription', name: 'Char' },
          { identifier: 'charPersonality', name: 'Pers', role: 'user' },
          { identifier: 'scenario', name: 'Scn' }
        ]
      },
      'fallback'
    )
    const byId = (id: string): any => preset.prompts.find((p: any) => p.identifier === id)
    expect(byId('charPersonality').marker).toBe('char_personality')
    expect(byId('charPersonality').role).toBe('user') // own role survives
    expect(byId('scenario').marker).toBe('scenario')
  })

  it('carries injection_trigger (lowercased) and forbid_overrides through', () => {
    const preset = parseStPreset(
      {
        prompts: [
          {
            identifier: 'main',
            content: 'sys',
            injection_trigger: ['Continue', 'NORMAL'],
            forbid_overrides: true
          },
          { identifier: 'note', content: 'n' } // defaults
        ]
      },
      'fallback'
    )
    const main = preset.prompts.find((p: any) => p.identifier === 'main')
    expect(main.injection_trigger).toEqual(['continue', 'normal'])
    expect(main.forbid_overrides).toBe(true)
    const note = preset.prompts.find((p: any) => p.identifier === 'note')
    expect(note.injection_trigger).toEqual([])
    expect(note.forbid_overrides).toBe(false)
  })

  it('resolves a duplicate identifier FIRST-match (ST getPromptById .find semantics)', () => {
    // ST resolves a prompt object by identifier with `.find` — first wins (PromptManager.js:1257).
    // RPT previously kept the LAST duplicate (Map overwrite); now first.
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'custom_x', name: 'first', content: 'FIRST-WINS' },
          { identifier: 'custom_x', name: 'second', content: 'SECOND-LOSES' }
        ],
        prompt_order: [
          { character_id: 100001, order: [{ identifier: 'custom_x', enabled: true }] }
        ]
      },
      'fallback'
    )
    const blocks = preset.prompts.filter((p: any) => p.identifier === 'custom_x')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('FIRST-WINS')
  })

  it('retains an empty `main`/`jailbreak` (override targets) even with no content', () => {
    // ST keeps a structural (empty) main so relative inserts + card overrides still resolve
    // (PromptManager.js:1531-1537; openai.js:1487-1504). RPT keeps these override targets while
    // still dropping other contentless literals.
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'main', content: '' },
          { identifier: 'jailbreak', content: '' },
          { identifier: 'empty_note', content: '' } // ordinary contentless literal -> dropped
        ]
      },
      'fallback'
    )
    const ids = preset.prompts.map((p: any) => p.identifier)
    expect(ids).toContain('main')
    expect(ids).toContain('jailbreak')
    expect(ids).not.toContain('empty_note')
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

  it('drops contentless ordinary literal blocks (but charPersonality now maps to a marker)', () => {
    // Behavior change (issue 11): charPersonality is NO LONGER skipped — it becomes a
    // char_personality marker. Ordinary contentless literals (`empty`) are still dropped.
    const preset = parseStPreset(
      {
        prompts: [
          { identifier: 'charPersonality', content: '' }, // -> char_personality marker
          { identifier: 'empty', content: '' }, // contentless literal -> dropped
          { identifier: 'note', content: 'keep me' }
        ]
      },
      'fallback'
    )
    expect(preset.prompts.map((p: any) => p.identifier)).toEqual(['charPersonality', 'note'])
    expect(preset.prompts.find((p: any) => p.identifier === 'charPersonality').marker).toBe(
      'char_personality'
    )
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

  // Issue 15 (WP-2.5): an import ALWAYS carries an explicit `squash_system_messages` boolean so the
  // provider seam can pick ST selective squash (true) vs RPT merge-all (false); native presets, which
  // never go through this parser, leave the field undefined and keep merge-all.
  it('extracts squash_system_messages as an explicit boolean (ST oai_settings)', () => {
    expect(parseStPreset({ prompts: [], squash_system_messages: true }, 'f').squash_system_messages).toBe(
      true
    )
    expect(
      parseStPreset({ prompts: [], squash_system_messages: false }, 'f').squash_system_messages
    ).toBe(false)
    // Absent in the source → coerced to false (ST default), never left undefined for an import.
    expect(parseStPreset({ prompts: [] }, 'f').squash_system_messages).toBe(false)
  })
})
