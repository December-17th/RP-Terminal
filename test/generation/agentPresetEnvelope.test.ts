import { describe, expect, it } from 'vitest'
import {
  agentPresetRoot,
  inspectAgentPresetEnvelope,
  selectPromptOrder
} from '../../src/shared/agentPresetEnvelope'

/**
 * The shared envelope gate (ADR 0021 §5). Its whole reason to exist is that the Agent editor and the
 * runtime parse must agree: an envelope the editor accepts must be one the runtime can read, and an
 * envelope the runtime would reject must be one the editor refuses to save.
 */
describe('agentPresetRoot', () => {
  it('unwraps the shapes an envelope arrives in, most specific first', () => {
    const preset = { prompts: [{ identifier: 'main' }] }

    expect(agentPresetRoot(preset)).toBe(preset)
    expect(agentPresetRoot({ parsed: preset, sha256: 'abc' })).toBe(preset)
    expect(agentPresetRoot({ importedView: preset, parsed: { other: true } })).toBe(preset)
    // Top-level array wrapping a preset, seen in the wild.
    expect(agentPresetRoot([preset])).toBe(preset)
  })

  it('returns null for anything that is not an object', () => {
    for (const value of [null, undefined, 'preset', 42, [], [1, 2]]) {
      expect(agentPresetRoot(value)).toBeNull()
    }
  })
})

describe('selectPromptOrder', () => {
  it('prefers the 100001 record, then the first list with an order', () => {
    const order = [{ identifier: 'main' }]

    expect(
      selectPromptOrder({
        prompt_order: [
          { character_id: 5, order: [{ identifier: 'other' }] },
          { character_id: 100001, order }
        ]
      })
    ).toBe(order)
    expect(selectPromptOrder({ prompt_order: [{ character_id: 5, order }] })).toBe(order)
    expect(selectPromptOrder({})).toBeNull()
  })
})

describe('inspectAgentPresetEnvelope', () => {
  it('accepts an envelope that can produce at least one prompt block', () => {
    for (const envelope of [
      { prompts: [{ identifier: 'main', content: 'hi' }] },
      { parsed: { prompts: [{ identifier: 'main' }] } },
      // Order-driven: an order entry yields a block even with no matching prompt object.
      { prompts: [], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main' }] }] }
    ]) {
      expect(inspectAgentPresetEnvelope(envelope)).toEqual({ usable: true })
    }
  })

  it('rejects a non-object envelope', () => {
    for (const envelope of [null, 'preset', 42, []]) {
      expect(inspectAgentPresetEnvelope(envelope)).toEqual({
        usable: false,
        problem: 'not-an-object'
      })
    }
  })

  it('rejects an envelope with no prompts array — parseStPreset would reject it outright', () => {
    for (const envelope of [{}, { parsed: {} }, { name: 'P', parameters: {} }]) {
      expect(inspectAgentPresetEnvelope(envelope)).toEqual({
        usable: false,
        problem: 'no-prompts'
      })
    }
  })

  it('rejects prompts that carry no identifier — they produce no blocks', () => {
    for (const envelope of [
      { prompts: [] },
      { prompts: [{ content: 'no identifier' }] },
      { prompts: [{ identifier: '  ' }] }
    ]) {
      expect(inspectAgentPresetEnvelope(envelope)).toEqual({
        usable: false,
        problem: 'no-usable-prompts'
      })
    }
  })
})
