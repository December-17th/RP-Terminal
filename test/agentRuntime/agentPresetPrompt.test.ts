import { describe, expect, it, vi } from 'vitest'

import {
  createAgentPromptPlanner,
  type AgentPresetAssembler
} from '../../src/main/services/agentRuntime/prompt'
import { buildAttemptLog } from '../../src/main/services/agentRuntime/harness/attemptLog'
import {
  createAgentHarness,
  createToolRegistry
} from '../../src/main/services/agentRuntime/harness'
import {
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderAdapter
} from '../../src/main/services/agentRuntime/provider'
import {
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationHarnessPort
} from '../../src/main/services/agentRuntime/invocation'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import type { HarnessExecutionResult } from '../../src/main/services/agentRuntime/harness'
import {
  parseAgentDefinition,
  resolveInvocationOptions,
  type AgentDefinition,
  type PromptMessage
} from '../../src/shared/agentRuntime'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'

/**
 * ADR 0021 slices 3 + 4, on the Agent-runtime side of the seam: an assembled prompt SUBSTITUTES for
 * the definition's own messages on the way into the FULL `execute` path, a messages Agent is
 * untouched, and a bundle's generation parameters occupy exactly one precedence layer.
 */

const ENVELOPE = { parsed: { prompts: [{ identifier: 'main', content: 'bundled' }] } }

const definition = (overrides: Record<string, unknown> = {}): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Bundled',
    prompt: [{ role: 'system', content: 'Authored instruction.' }],
    result: { mode: 'text' },
    defaults: { retryDelayMs: 0 },
    ...overrides
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const text = (content: string): PromptMessage => ({
  role: 'system',
  content: [{ type: 'text', text: content }]
})

// --- buildAttemptLog: the substitution point ------------------------------------------------

describe('buildAttemptLog prompt substitution', () => {
  const contentsOf = (def: AgentDefinition, request: Parameters<typeof buildAttemptLog>[1]) => {
    const resolved = resolveInvocationOptions(def, undefined)
    if (!resolved.ok) throw new Error('invalid fixture options')
    const built = buildAttemptLog(def, request, resolved.value, 'POLICY')
    if (!built.ok) throw new Error(built.failure.code)
    return [...built.immutablePrefix, ...built.attemptLog].map((message) => message.content)
  }

  it('sends the assembled messages instead of the definition prompt', () => {
    const def = definition()

    const contents = contentsOf(def, {
      definition: def,
      input: {},
      profileId: 'p',
      prompt: [text('ASSEMBLED CONTEXT'), text('Authored instruction.')]
    })

    expect(contents).toEqual([
      'POLICY',
      'ASSEMBLED CONTEXT',
      'Authored instruction.',
      '{}'
    ])
  })

  it('never renders an assembled prompt — the assembler already did', () => {
    const def = definition()

    const contents = contentsOf(def, {
      definition: def,
      input: {},
      profileId: 'p',
      prompt: [text('{{literal}} card data')],
      render: () => 'SHOULD NOT RUN'
    })

    expect(contents).toContain('{{literal}} card data')
  })

  it('is byte-identical to before for a messages Agent (no prompt supplied)', () => {
    const def = definition({ prompt: [{ role: 'system', content: 'Authored instruction.' }] })

    expect(contentsOf(def, { definition: def, input: { a: 1 }, profileId: 'p' })).toEqual([
      'POLICY',
      'Authored instruction.',
      '{"a":1}'
    ])
  })
})

// --- generation-parameter precedence ---------------------------------------------------------

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
    // The resolved API preset — the BOTTOM layer.
    getActivePreset: () =>
      ({ parameters: { temperature: 0.9, max_tokens: 4000, top_p: 0.5 } }) as Preset
  })

const textAdapter = () =>
  createScriptedProviderAdapter([
    { events: [{ type: 'text-delta', delta: 'ok' }, { type: 'finish', reason: 'stop' }] }
  ])

describe('bundled generation-parameter precedence', () => {
  const runWith = async (def: AgentDefinition, options?: Record<string, unknown>) => {
    const adapter = textAdapter()
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })
    const result = await harness.execute({
      definition: def,
      input: {},
      profileId: 'p',
      ...(options ? { options } : {})
    })
    expect(result.ok).toBe(true)
    return adapter.requests[0].parameters
  }

  it('sits directly above the resolved API preset', async () => {
    const def = definition({
      preset: { preset: ENVELOPE, generationParameters: { temperature: 0.2 } }
    })

    const parameters = await runWith(def)

    expect(parameters.temperature).toBe(0.2)
    // Untouched keys still come from the resolved preset.
    expect(parameters.top_p).toBe(0.5)
    expect(parameters.max_tokens).toBe(4000)
  })

  it('sits below an explicit per-invocation override', async () => {
    const def = definition({
      preset: { preset: ENVELOPE, generationParameters: { temperature: 0.2, max_tokens: 100 } }
    })

    const parameters = await runWith(def, { generationParameters: { temperature: 0.7 } })

    expect(parameters.temperature).toBe(0.7)
    // The bundle still wins over the API preset where the invocation said nothing.
    expect(parameters.max_tokens).toBe(100)
  })

  it('changes nothing for an Agent with no bundle', async () => {
    const parameters = await runWith(definition())

    expect(parameters).toMatchObject({ temperature: 0.9, max_tokens: 4000, top_p: 0.5 })
  })
})

// --- the planner chooses between rendering and assembly ---------------------------------------

const plannerDeps = (assembler: AgentPresetAssembler | undefined) => ({
  renderer: () => (value: string) => `rendered:${value}`,
  assembler: () => assembler,
  warn: vi.fn()
})

describe('Agent prompt planner', () => {
  const scope = { profileId: 'p', chatId: 'c', floor: 3 }

  it('returns a renderer for a messages Agent and never calls the assembler', () => {
    const assembler = vi.fn<AgentPresetAssembler>(() => [text('nope')])
    const plan = createAgentPromptPlanner(plannerDeps(assembler))({
      ...scope,
      agent: definition()
    })

    expect(plan?.render?.('x')).toBe('rendered:x')
    expect(plan).not.toHaveProperty('prompt')
    expect(assembler).not.toHaveBeenCalled()
  })

  it('assembles for a preset Agent and returns NO renderer', () => {
    const assembler = vi.fn<AgentPresetAssembler>(() => [text('assembled')])
    const agent = definition({ preset: { preset: ENVELOPE } })

    const plan = createAgentPromptPlanner(plannerDeps(assembler))({ ...scope, agent })

    expect(plan?.prompt).toEqual([text('assembled')])
    expect(plan).not.toHaveProperty('render')
    expect(assembler.mock.calls[0][0].definition).toBe(agent)
    expect(assembler.mock.calls[0][0].render?.('x')).toBe('rendered:x')
  })

  it('resolves the History Policy with the invocation winning over the Agent default', () => {
    const assembler = vi.fn<AgentPresetAssembler>(() => [text('assembled')])
    const agent = definition({
      preset: { preset: ENVELOPE },
      defaults: {
        retryDelayMs: 0,
        history: { maxFloors: 2, includeUserMessages: false, includePlayerResults: false }
      }
    })
    const planner = createAgentPromptPlanner(plannerDeps(assembler))

    planner({ ...scope, agent })
    expect(assembler.mock.calls[0][0].history).toEqual({
      maxFloors: 2,
      includeUserMessages: false,
      includePlayerResults: false
    })

    planner({
      ...scope,
      agent,
      options: { history: { maxFloors: 9, includeUserMessages: true, includePlayerResults: true } }
    })
    expect(assembler.mock.calls[1][0].history).toEqual({
      maxFloors: 9,
      includeUserMessages: true,
      includePlayerResults: true
    })
  })

  it('omits history entirely when the Agent declares no Policy', () => {
    const assembler = vi.fn<AgentPresetAssembler>(() => [text('assembled')])

    createAgentPromptPlanner(plannerDeps(assembler))({
      ...scope,
      agent: definition({ preset: { preset: ENVELOPE } })
    })

    expect(assembler.mock.calls[0][0]).not.toHaveProperty('history')
  })

  // Fail-open stays fail-open — but never SILENTLY. Each fallback must carry a warning naming what
  // was lost, or a degraded run is indistinguishable from a healthy one in the UI.
  it('falls open to the renderer when assembly throws, and marks the run degraded', () => {
    const agent = definition({ preset: { preset: ENVELOPE } })
    const deps = plannerDeps(() => {
      throw new Error('the bundled preset envelope could not be read')
    })

    const plan = createAgentPromptPlanner(deps)({ ...scope, agent })

    expect(plan?.render?.('x')).toBe('rendered:x')
    expect(plan?.warnings).toHaveLength(1)
    // Names the cause AND the consequence.
    expect(plan?.warnings?.[0]).toContain('the bundled preset envelope could not be read')
    expect(plan?.warnings?.[0]).toContain('character card, persona, world info and history')
    expect(deps.warn).toHaveBeenCalled()
  })

  it('marks the run degraded when assembly yields nothing', () => {
    const deps = plannerDeps(() => undefined)

    const plan = createAgentPromptPlanner(deps)({
      ...scope,
      agent: definition({ preset: { preset: ENVELOPE } })
    })

    expect(plan?.render?.('x')).toBe('rendered:x')
    expect(plan?.warnings?.[0]).toContain('produced no messages')
  })

  it('marks the run degraded when no assembler is registered at all', () => {
    const deps = plannerDeps(undefined)

    const plan = createAgentPromptPlanner(deps)({
      ...scope,
      agent: definition({ preset: { preset: ENVELOPE } })
    })

    expect(plan?.render?.('x')).toBe('rendered:x')
    expect(plan?.warnings?.[0]).toContain('No preset assembler is registered')
    expect(deps.warn).toHaveBeenCalled()
  })

  it('never marks a healthy run — neither a messages Agent nor a successful assembly', () => {
    const planner = createAgentPromptPlanner(plannerDeps(() => [text('assembled')]))

    expect(planner({ ...scope, agent: definition() })).not.toHaveProperty('warnings')
    expect(
      planner({ ...scope, agent: definition({ preset: { preset: ENVELOPE } }) })
    ).not.toHaveProperty('warnings')
  })
})

// --- end to end: the assembled prompt reaches the provider through `execute` -------------------

const catalogAgent = (def: AgentDefinition): CatalogAgent => ({
  id: def.name,
  name: def.name,
  source: { kind: 'user-created', key: def.name, version: '1' },
  sourcePresent: true,
  availableSource: null,
  baseline: def,
  effective: def,
  effectiveHash: `hash:${def.name}`,
  customized: false,
  enabled: true,
  createdAt: '',
  updatedAt: ''
})

describe('InvocationRuntime → Harness prompt substitution', () => {
  const floorPort: InvocationFloorPort = {
    async resolveSource(request) {
      return { token: `${request.floor}`, input: {}, promptValues: {}, history: null }
    },
    async isSourceCurrent() {
      return true
    },
    async incorporate() {
      return { status: 'committed' }
    }
  }

  it('hands the assembled prompt to the FULL execute path, not executePrepared', async () => {
    const execute = vi.fn<InvocationHarnessPort['execute']>(
      async (): Promise<HarnessExecutionResult> => ({
        ok: true,
        result: 'done',
        stagedOperations: [],
        evidence: { attempts: [] }
      })
    )
    const agent = catalogAgent(definition({ preset: { preset: ENVELOPE } }))
    const runtime = createInvocationRuntime({
      catalog: { get: () => agent },
      harness: { execute, stop: () => false },
      floor: floorPort,
      promptRenderer: () => ({ prompt: [text('ASSEMBLED')] })
    })

    await runtime.run({ profileId: 'p', chatId: 'c', floor: 4, agent: agent.name })

    const request = execute.mock.calls[0][0]
    expect(request.prompt).toEqual([text('ASSEMBLED')])
    expect(request).not.toHaveProperty('render')
    expect(request).not.toHaveProperty('warnings')
    // The Agent's identity is unchanged — the Run Record still stores the real definition.
    expect(request.agent.definition).toBe(agent.effective)
  })

  it('carries degradation warnings from the port through to the run', async () => {
    const execute = vi.fn<InvocationHarnessPort['execute']>(
      async (): Promise<HarnessExecutionResult> => ({
        ok: true,
        result: 'done',
        stagedOperations: [],
        evidence: { attempts: [] }
      })
    )
    const agent = catalogAgent(definition({ preset: { preset: ENVELOPE } }))
    const runtime = createInvocationRuntime({
      catalog: { get: () => agent },
      harness: { execute, stop: () => false },
      floor: floorPort,
      promptRenderer: () => ({
        render: (value: string) => value,
        warnings: ['Preset assembly failed — context missing']
      })
    })

    await runtime.run({ profileId: 'p', chatId: 'c', floor: 4, agent: agent.name })

    expect(execute.mock.calls[0][0].warnings).toEqual([
      'Preset assembly failed — context missing'
    ])
  })
})
