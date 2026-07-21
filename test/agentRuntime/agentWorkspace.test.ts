import { describe, expect, it } from 'vitest'
import { validateDraft } from '../../src/renderer/src/components/agents/AgentEditor'
import {
  agentInputFields,
  defaultAgentInput
} from '../../src/renderer/src/components/agents/AgentManualRunForm'
import { agentRunDurationMs } from '../../src/renderer/src/components/agents/AgentRunDetail'
import { parseInvocationPlan } from '../../src/shared/agentRuntime'
import type { AgentDefinition } from '../../src/shared/agentRuntime'

const base = (): AgentDefinition => ({
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'Editable',
  prompt: [{ role: 'system', content: [{ type: 'text', text: 'do the thing' }] }],
  inputSchema: { type: 'object' },
  result: { mode: 'text' },
  tools: [],
  defaults: {
    required: false,
    maxSteps: 1,
    maxRetryAttempts: 3,
    retryDelayMs: 3000,
    blocksNextTurn: false,
    toolResultMaxTokens: 10000,
    notification: 'failure'
  }
})

/** The smallest envelope that actually parses into a preset — one identifiable prompt block. */
const USABLE_ENVELOPE = { prompts: [{ identifier: 'main', content: 'You are a simulator.' }] }

describe('Agent editor field validation', () => {
  it('accepts a well-formed definition', () => {
    expect(validateDraft(base())).toEqual([])
  })

  it('reports each problem against the field responsible for it', () => {
    const draft = base()
    draft.name = '  '
    draft.prompt = [{ role: 'system', content: [{ type: 'text', text: '   ' }] }]
    draft.defaults.maxSteps = 0
    draft.defaults.maxRetryAttempts = -1
    draft.defaults.retryDelayMs = -5
    draft.defaults.toolResultMaxTokens = 0

    expect(
      validateDraft(draft)
        .map((issue) => issue.field)
        .sort()
    ).toEqual([
      'defaults.maxRetryAttempts',
      'defaults.maxSteps',
      'defaults.retryDelayMs',
      'defaults.toolResultMaxTokens',
      'name',
      'prompt.0'
    ])
  })

  it('requires at least one prompt message', () => {
    const draft = base()
    draft.prompt = []

    expect(validateDraft(draft)).toContainEqual({
      field: 'prompt',
      message: 'atLeastOneMessage'
    })
  })

  it('rejects a result slot outside the agent_results root', () => {
    const draft = base()
    draft.result = { mode: 'text', saveAs: 'variables.stat_data.hp' as never }

    expect(validateDraft(draft)).toContainEqual({ field: 'result.saveAs', message: 'slotPath' })
  })

  it('accepts a slot beneath the agent_results root', () => {
    const draft = base()
    draft.result = { mode: 'text', saveAs: 'variables.__rpt.agent_results.world' as never }

    expect(validateDraft(draft)).toEqual([])
  })

  it('requires a schema for a json result', () => {
    const draft = base()
    draft.result = { mode: 'json' } as never

    expect(validateDraft(draft)).toContainEqual({
      field: 'result.schema',
      message: 'schemaRequired'
    })
  })
})

describe('Agent editor preset bundle validation', () => {
  it('leaves an Agent without a bundle untouched — the saved draft has no preset key at all', () => {
    const draft = base()

    expect(validateDraft(draft)).toEqual([])
    expect('preset' in draft).toBe(false)
    expect(Object.keys(JSON.parse(JSON.stringify(draft)))).not.toContain('preset')
  })

  it('accepts a bundle carrying an envelope, parameter overrides and a lorebook selection', () => {
    const draft = base()
    draft.preset = {
      preset: USABLE_ENVELOPE,
      generationParameters: { temperature: 0.8, stop: ['</done>'] },
      lorebooks: { mode: 'explicit', lorebooks: ['World'], entries: { exclude: ['Spoilers'] } }
    }

    expect(validateDraft(draft)).toEqual([])
  })

  it('accepts a session-scoped lorebook selection with no explicit list', () => {
    const draft = base()
    draft.preset = { preset: USABLE_ENVELOPE, lorebooks: { mode: 'session' } }

    expect(validateDraft(draft)).toEqual([])
  })

  it('rejects an envelope that is not a JSON object', () => {
    for (const envelope of [[], 'preset', 42, null]) {
      const draft = base()
      draft.preset = { preset: envelope as never }

      expect(validateDraft(draft)).toContainEqual({
        field: 'preset.envelope',
        message: 'envelopeObject'
      })
    }
  })

  // The contract layer accepts any object as an envelope (it is opaque there). The editor must not:
  // a bundle that cannot produce a preset saves clean and then falls open to plain rendering for the
  // life of the Agent, with nothing in the UI to say so.
  it('rejects an envelope with no prompts array — it could never produce a preset', () => {
    for (const envelope of [{}, { parsed: {} }, { name: 'Preset', parameters: {} }]) {
      const draft = base()
      draft.preset = { preset: envelope as never }

      expect(validateDraft(draft)).toContainEqual({
        field: 'preset.envelope',
        message: 'envelopeNoPrompts'
      })
    }
  })

  it('rejects an envelope whose prompts define nothing usable', () => {
    for (const envelope of [
      { prompts: [] },
      { prompts: [{ content: 'no identifier' }] },
      { prompts: [{ identifier: '   ' }] },
      { prompts: [], prompt_order: [] }
    ]) {
      const draft = base()
      draft.preset = { preset: envelope as never }

      expect(validateDraft(draft)).toContainEqual({
        field: 'preset.envelope',
        message: 'envelopeNoUsablePrompts'
      })
    }
  })

  it('accepts the envelope shapes a real bundle arrives in', () => {
    for (const envelope of [
      USABLE_ENVELOPE,
      // ADR 0018 wrapper around the nothing-dropped raw.
      { parsed: USABLE_ENVELOPE, sha256: 'abc' },
      // The normalized snapshot written at import.
      { importedView: { name: 'P', parameters: {}, prompts: [{ identifier: 'main' }] } },
      // Order-driven: blocks come from prompt_order even with an empty prompts array.
      { prompts: [], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main' }] }] },
      // Top-level array wrapping a preset, seen in the wild.
      [USABLE_ENVELOPE]
    ]) {
      const draft = base()
      draft.preset = { preset: envelope as never }

      expect(validateDraft(draft)).toEqual([])
    }
  })

  it('rejects an explicit selection with an empty lorebook list', () => {
    const draft = base()
    draft.preset = { preset: USABLE_ENVELOPE, lorebooks: { mode: 'explicit', lorebooks: [] } }

    expect(validateDraft(draft)).toContainEqual({
      field: 'preset.lorebooks',
      message: 'lorebooksRequired'
    })
  })

  it('lands a blank lorebook name on that row rather than on the list', () => {
    const draft = base()
    draft.preset = {
      preset: USABLE_ENVELOPE,
      lorebooks: { mode: 'explicit', lorebooks: ['World', '  '] }
    }

    expect(validateDraft(draft)).toEqual([{ field: 'preset.lorebooks.1', message: 'required' }])
  })
})

describe('Invocation Plan authoring rules', () => {
  it('accepts an ordered sequence with a flat parallel group', () => {
    const parsed = parseInvocationPlan({
      steps: [{ agent: 'Character Progression' }, { parallel: [{ agent: 'World Progression' }] }]
    })

    expect(parsed.ok).toBe(true)
  })

  it('rejects a nested parallel group — the editor offers no control that could build one', () => {
    const parsed = parseInvocationPlan({
      steps: [{ parallel: [{ parallel: [{ agent: 'World Progression' }] }] }]
    })

    expect(parsed.ok).toBe(false)
  })

  it('rejects a step that names no agent', () => {
    expect(parseInvocationPlan({ steps: [{}] }).ok).toBe(false)
  })
})

describe('Agent workspace authoring projections', () => {
  it('projects top-level input schema properties into manual-run fields and defaults', () => {
    const schema = {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string', title: 'Topic', description: 'What to update.' },
        count: { type: 'integer', default: 2 },
        options: { type: 'object' }
      }
    }

    expect(agentInputFields(schema)).toEqual([
      {
        key: 'topic',
        label: 'Topic',
        description: 'What to update.',
        kind: 'string',
        required: true
      },
      {
        key: 'count',
        label: 'count',
        kind: 'integer',
        required: false,
        placeholder: '2'
      },
      { key: 'options', label: 'options', kind: 'json', required: false }
    ])
    expect(defaultAgentInput(schema)).toEqual({ count: 2 })
  })

  it('reports a duration only when a run has a valid finished timestamp', () => {
    expect(
      agentRunDurationMs({
        startedAt: '2026-07-21T10:00:00.000Z',
        finishedAt: '2026-07-21T10:00:00.250Z'
      })
    ).toBe(250)
    expect(agentRunDurationMs({ startedAt: '2026-07-21T10:00:00.000Z' })).toBeNull()
  })
})
