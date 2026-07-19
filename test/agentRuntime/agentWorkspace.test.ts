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
