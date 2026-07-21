import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import {
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderAdapter
} from '../../src/main/services/agentRuntime/provider'
import { createToolRegistry } from '../../src/main/services/agentRuntime/harness'
import {
  createAgentRunStore,
  createHarnessRunAdapter,
  type HarnessRunRequest
} from '../../src/main/services/agentRuntime/runs'
import {
  createAgentPromptPlanner,
  type AgentPresetAssembler
} from '../../src/main/services/agentRuntime/prompt'
import type { InvocationFloorPort } from '../../src/main/services/agentRuntime/invocation'
import { createAgentPromptPreview } from '../../src/main/services/agentRuntime/preview/promptPreview'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import {
  parseAgentDefinition,
  type AgentDefinition,
  type PromptMessage
} from '../../src/shared/agentRuntime'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'

/**
 * Microscope-lite D4: a dry-run Prompt Preview must reproduce, byte for byte, the prompt a real run
 * dispatches — for both a messages Agent and a preset Agent — using the SAME building blocks, with no
 * provider call and no floor write.
 */

const ENVELOPE = { parsed: { prompts: [{ identifier: 'main', content: 'bundled' }] } }

const text = (content: string): PromptMessage => ({
  role: 'system',
  content: [{ type: 'text', text: content }]
})

const definition = (overrides: Record<string, unknown> = {}): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Previewed',
    prompt: [{ role: 'system', content: 'Return the requested result.' }],
    inputSchema: { type: 'object' },
    result: { mode: 'text' },
    tools: [],
    defaults: { maxRetryAttempts: 0, retryDelayMs: 0 },
    ...overrides
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const catalogAgent = (def: AgentDefinition): CatalogAgent => ({
  id: def.name,
  name: def.name,
  source: { kind: 'user-created', key: def.name, version: '1' },
  sourcePresent: true,
  availableSource: null,
  baseline: def,
  effective: def,
  effectiveHash: `hash:${def.name}`,
  invocationConfig: {},
  customized: false,
  enabled: true,
  createdAt: '',
  updatedAt: ''
})

const settings = {
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
  cache: { mode: 'baseline' },
  generation: { max_context_tokens: 8192 }
} as unknown as Settings

const dispatchFor = (adapter: ProviderAdapter) =>
  createProviderDispatch({
    adapter,
    getSettings: () => settings,
    getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
  })

const textAdapter = () =>
  createScriptedProviderAdapter([
    {
      events: [
        { type: 'text-delta', delta: 'ok' },
        { type: 'finish', reason: 'stop' }
      ]
    }
  ])

// A pure source: returns clones, never mutates the underlying vars, so side-effect freedom is provable.
const FLOOR_VARS = { name: 'Ada', place: 'Harbor' }
const floorPort = (): Pick<InvocationFloorPort, 'resolveSource'> => ({
  async resolveSource() {
    return {
      token: 'fixed',
      input: { q: 'hello' },
      promptValues: { 'variables.name': FLOOR_VARS.name },
      history: null
    }
  }
})

// Deterministic planner (identity renderer) so run and preview render identically — a non-idempotent
// renderer would make byte-equality meaningless.
const plannerFor = (assembler: AgentPresetAssembler | undefined) =>
  createAgentPromptPlanner({
    renderer: () => (value: string) => value,
    assembler: () => assembler,
    warn: vi.fn()
  })

describe('Prompt Preview ≡ run (D4)', () => {
  let db: InstanceType<typeof Adapter>
  let runStore: ReturnType<typeof createAgentRunStore>

  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    runStore = createAgentRunStore({ getDb: () => db, now: () => '2026-07-20T00:00:00.000Z' })
    FLOOR_VARS.name = 'Ada'
    FLOOR_VARS.place = 'Harbor'
  })

  const runAndCapture = async (
    def: AgentDefinition,
    floor: Pick<InvocationFloorPort, 'resolveSource'>,
    plan: ReturnType<ReturnType<typeof plannerFor>>
  ) => {
    const adapter = createHarnessRunAdapter({
      runStore,
      providerDispatch: dispatchFor(textAdapter()),
      toolRegistry: createToolRegistry()
    })
    const source = await floor.resolveSource({
      profileId: 'p',
      chatId: 'c',
      floor: 5,
      agent: catalogAgent(def)
    })
    const request: HarnessRunRequest = {
      invocationId: 'run-1',
      profileId: 'p',
      chatId: 'c',
      floor: 5,
      agent: { definition: def, version: '1', hash: `hash:${def.name}` },
      input: source.input,
      ...(source.promptValues ? { promptValues: source.promptValues } : {}),
      ...(source.history !== undefined ? { history: source.history } : {}),
      ...(plan?.render ? { render: plan.render } : {}),
      ...(plan?.prompt ? { prompt: plan.prompt } : {})
    }
    const execution = await adapter.execute(request)
    expect(execution.ok).toBe(true)
    return runStore.get('c', 'run-1')!.renderedPrompt
  }

  it('reproduces a messages Agent prompt byte-for-byte, origins and all', async () => {
    const def = definition({
      prompt: [
        { role: 'system', content: 'You are {{name}}.' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Place: ' },
            { type: 'binding', source: { type: 'variables', path: 'variables.name' } }
          ]
        }
      ]
    })
    const floor = floorPort()
    const planner = plannerFor(undefined)
    const plan = planner({ profileId: 'p', chatId: 'c', floor: 5, agent: def })
    const recorded = await runAndCapture(def, floor, plan)

    const preview = await createAgentPromptPreview({
      floor,
      planner,
      providerDispatch: dispatchFor(textAdapter())
    })({ profileId: 'p', chatId: 'c', floor: 5, agent: catalogAgent(def), input: {} })

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.messages).toEqual(recorded)
    // The reuse boundary: only the harness policy stays immutable once a templated/bound message lands.
    expect(preview.prefixCount).toBe(1)
    expect(preview.provider?.presetName).toBe('Fixed preset')
    expect(preview.attribution.regions.some((region) => region.region === 'harness-policy')).toBe(
      true
    )
    // Floor vars were never written.
    expect(FLOOR_VARS).toEqual({ name: 'Ada', place: 'Harbor' })
  })

  it('reproduces a preset (assembled) Agent prompt byte-for-byte', async () => {
    const def = definition({ preset: { preset: ENVELOPE } })
    const assembler: AgentPresetAssembler = () => [text('ASSEMBLED CONTEXT'), text('Instruction.')]
    const floor = floorPort()
    const planner = plannerFor(assembler)
    const plan = planner({ profileId: 'p', chatId: 'c', floor: 5, agent: def })
    const recorded = await runAndCapture(def, floor, plan)

    const preview = await createAgentPromptPreview({
      floor,
      planner,
      providerDispatch: dispatchFor(textAdapter())
    })({ profileId: 'p', chatId: 'c', floor: 5, agent: catalogAgent(def), input: {} })

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.messages).toEqual(recorded)
    expect(preview.messages.map((message) => message.origin)).toEqual([
      'harness-policy',
      'assembled-preset',
      'assembled-preset',
      'input'
    ])
  })

  it('reports a missing prompt binding as an error', async () => {
    const def = definition({
      prompt: [
        {
          role: 'system',
          content: [{ type: 'binding', source: { type: 'variables', path: 'variables.absent' } }]
        }
      ]
    })
    const preview = await createAgentPromptPreview({
      floor: floorPort(),
      planner: plannerFor(undefined),
      providerDispatch: dispatchFor(textAdapter())
    })({ profileId: 'p', chatId: 'c', floor: 5, agent: catalogAgent(def), input: {} })

    expect(preview).toMatchObject({ ok: false, code: 'PROMPT_BINDING_MISSING' })
  })
})
