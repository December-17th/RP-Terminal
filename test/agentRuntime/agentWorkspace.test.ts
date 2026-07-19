import { describe, expect, it } from 'vitest'
import { validateDraft } from '../../src/renderer/src/components/agents/AgentEditor'
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

    expect(validateDraft(draft).map((issue) => issue.field).sort()).toEqual([
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
      preset: { prompts: [], prompt_order: [] },
      generationParameters: { temperature: 0.8, stop: ['</done>'] },
      lorebooks: { mode: 'explicit', lorebooks: ['World'], entries: { exclude: ['Spoilers'] } }
    }

    expect(validateDraft(draft)).toEqual([])
  })

  it('accepts a session-scoped lorebook selection with no explicit list', () => {
    const draft = base()
    draft.preset = { preset: {}, lorebooks: { mode: 'session' } }

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

  it('rejects an explicit selection with an empty lorebook list', () => {
    const draft = base()
    draft.preset = { preset: {}, lorebooks: { mode: 'explicit', lorebooks: [] } }

    expect(validateDraft(draft)).toContainEqual({
      field: 'preset.lorebooks',
      message: 'lorebooksRequired'
    })
  })

  it('lands a blank lorebook name on that row rather than on the list', () => {
    const draft = base()
    draft.preset = { preset: {}, lorebooks: { mode: 'explicit', lorebooks: ['World', '  '] } }

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
