import { describe, expect, it } from 'vitest'

import {
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderAdapter
} from '../../src/main/services/agentRuntime/provider'
import {
  createAgentHarness,
  createToolRegistry
} from '../../src/main/services/agentRuntime/harness'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'

/**
 * Microscope-lite D2: token attribution is captured on EVERY finished run — success as well as the
 * CONTEXT_BUDGET failures that historically were the only runs to surface it.
 */

const dispatchFor = (adapter: ProviderAdapter) =>
  createProviderDispatch({
    adapter,
    getSettings: () =>
      ({
        api: { provider: 'openai', endpoint: 'https://provider.test/v1', model: 'm' },
        api_presets: [
          {
            id: 'fixed-preset',
            name: 'Fixed preset',
            provider: 'openai',
            endpoint: 'https://provider.test/v1',
            api_key: 'secret',
            model: 'fixed-model'
          }
        ],
        active_api_preset_id: 'fixed-preset',
        cache: { mode: 'baseline' }
      }) as Settings,
    getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
  })

const definition = () => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Budgeted',
    prompt: [{ role: 'system', content: 'Return the requested result.' }],
    inputSchema: { type: 'object' },
    result: { mode: 'text' },
    tools: [],
    defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const textAdapter = () =>
  createScriptedProviderAdapter([
    {
      events: [
        { type: 'text-delta', delta: 'ok' },
        { type: 'finish', reason: 'stop' }
      ]
    }
  ])

describe('AgentHarness context budget (D2)', () => {
  it('populates record- and attempt-level budget on a successful run', async () => {
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(textAdapter()),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition(),
      input: { request: 'answer' },
      profileId: 'p'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const budget = result.evidence.contextBudget
    expect(budget).toBeDefined()
    expect(budget?.limit).toBeGreaterThan(0)
    expect(budget?.regions.some((region) => region.region === 'harness-policy')).toBe(true)
    expect(budget?.regions.some((region) => region.region === 'output-reserve')).toBe(true)
    // The record budget is the latest attempt's budget.
    expect(result.evidence.attempts[0].contextBudget).toEqual(budget)
  })

  it('keeps the CONTEXT_BUDGET failure shape — evidence and failure budgets agree', async () => {
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(textAdapter()),
      toolRegistry: createToolRegistry(),
      // Force the step-0 attribution over the modeled context window.
      contextWindowTokensForTest: 1
    })

    const result = await harness.execute({
      definition: definition(),
      input: { request: 'answer' },
      profileId: 'p'
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CONTEXT_BUDGET')
    expect(result.evidence.contextBudget).toBeDefined()
    expect(result.evidence.attempts[0].contextBudget).toEqual(result.evidence.contextBudget)
    // Unchanged: the failure still carries the budget that tripped the limit.
    expect(result.failure.contextBudget).toEqual(result.evidence.contextBudget)
  })
})
