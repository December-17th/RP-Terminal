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
  createHarnessRunAdapter
} from '../../src/main/services/agentRuntime/runs'
import {
  createAgentPromptPlanner,
  type AgentPresetAssembler
} from '../../src/main/services/agentRuntime/prompt'
import {
  createInvocationRuntime,
  type InvocationFloorPort
} from '../../src/main/services/agentRuntime/invocation'
import { createAgentPromptPreview } from '../../src/main/services/agentRuntime/preview/promptPreview'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import {
  parseAgentDefinition,
  type AgentDefinition,
  type JsonObject,
  type JsonValue,
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

// A SHARED-REFERENCE source: the snapshot hands out the live objects themselves — `promptValues` IS
// `FLOOR_VARS` and `input` IS `FLOOR_INPUT`, not copies. Any in-place write by the preview, the
// planner/assembler, or the attempt-log builder therefore lands in this module state and trips the
// "floor vars were never written" assertion. A cloning port could never fail that assertion.
const FLOOR_VARS: Record<string, JsonValue> = {
  'variables.name': 'Ada',
  'variables.place': 'Harbor'
}
const FLOOR_INPUT: JsonObject = { q: 'hello' }
const floorPort = (): Pick<InvocationFloorPort, 'resolveSource'> => ({
  async resolveSource() {
    return {
      token: 'fixed',
      input: FLOOR_INPUT,
      promptValues: FLOOR_VARS,
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
    for (const key of Object.keys(FLOOR_VARS)) delete FLOOR_VARS[key]
    Object.assign(FLOOR_VARS, { 'variables.name': 'Ada', 'variables.place': 'Harbor' })
    for (const key of Object.keys(FLOOR_INPUT)) delete FLOOR_INPUT[key]
    Object.assign(FLOOR_INPUT, { q: 'hello' })
  })

  /**
   * Drives a REAL invocation through the Invocation Runtime's public entry (`runtime.run`, i.e.
   * `enqueue` → `runQueued`) so the captured prompt comes from the runtime's OWN Harness-request
   * shaping. Hand-building the `HarnessRunRequest` here would make the byte-equality guard circular:
   * it would compare the preview against the test's copy of the shaping, not against dispatch.
   */
  const runAndCapture = async (
    def: AgentDefinition,
    floor: Pick<InvocationFloorPort, 'resolveSource'>,
    planner: ReturnType<typeof plannerFor>
  ) => {
    const agent = catalogAgent(def)
    const harness = createHarnessRunAdapter({
      runStore,
      providerDispatch: dispatchFor(textAdapter()),
      toolRegistry: createToolRegistry()
    })
    const runtime = createInvocationRuntime({
      catalog: { get: () => agent },
      harness,
      floor: {
        resolveSource: (request) => floor.resolveSource(request),
        isSourceCurrent: () => true,
        async incorporate({ commitRun }) {
          commitRun()
          return { status: 'committed' }
        }
      },
      promptRenderer: planner,
      createId: () => 'run-1'
    })
    const outcome = await runtime.run({ profileId: 'p', chatId: 'c', floor: 5, agent: def.name })
    expect(outcome.status).toBe('succeeded')
    return runStore.get('c', outcome.invocationId)!.renderedPrompt
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
    const recorded = await runAndCapture(def, floor, planner)

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
    // Floor vars were never written: the port handed out these very objects (not clones), so an
    // in-place mutation anywhere on the preview path would show up here.
    expect(FLOOR_VARS).toEqual({ 'variables.name': 'Ada', 'variables.place': 'Harbor' })
    expect(FLOOR_INPUT).toEqual({ q: 'hello' })
  })

  it('reproduces a preset (assembled) Agent prompt byte-for-byte', async () => {
    const def = definition({ preset: { preset: ENVELOPE } })
    const assembler: AgentPresetAssembler = () => [text('ASSEMBLED CONTEXT'), text('Instruction.')]
    const floor = floorPort()
    const planner = plannerFor(assembler)
    const recorded = await runAndCapture(def, floor, planner)

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
