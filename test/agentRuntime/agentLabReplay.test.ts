import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import {
  createProviderDispatch,
  type ProviderAdapter,
  type ProviderDispatch
} from '../../src/main/services/agentRuntime/provider'
import { DEFAULT_HARNESS_POLICY } from '../../src/main/services/agentRuntime/harness'
import { createAgentRunStore } from '../../src/main/services/agentRuntime/runs'
import {
  createAgentLabReplay,
  type AgentLabReplayDeps
} from '../../src/main/services/agentRuntime/lab/replay'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import {
  AGENT_LAB_CHANNELS,
  parseAgentDefinition,
  type AgentDefinition,
  type AgentLabCase,
  type AgentRunMessage,
  type AgentRunRecord
} from '../../src/shared/agentRuntime'
import { GATED_CHANNELS } from '../../src/main/ipc/ipcGuards'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'

/**
 * Agent Lab replay round-trip (plan §Verification gate): a captured success replays to success, a
 * captured failure replays to the SAME failure code, a tool call with no recorded result fails with
 * LAB_TOOL_DIVERGENCE (executing nothing real), and the wire prompt the scripted adapter receives is
 * byte-identical to the pinned renderedPrompt.
 */

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

const definition = (overrides: Record<string, unknown> = {}): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Replayed',
    prompt: [{ role: 'system', content: 'You are a test bot.' }],
    inputSchema: { type: 'object' },
    result: { mode: 'text' },
    tools: [],
    defaults: { maxRetryAttempts: 0, retryDelayMs: 0 },
    ...overrides
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const catalogAgent = (def: AgentDefinition): CatalogAgent =>
  ({
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
  }) as CatalogAgent

const INPUT = { q: 'hello' }

const renderedPrompt = (): AgentRunMessage[] => [
  { role: 'system', content: DEFAULT_HARNESS_POLICY, origin: 'harness-policy' },
  { role: 'system', content: 'You are a test bot.', origin: 'agent-prompt' },
  { role: 'user', content: JSON.stringify(INPUT), origin: 'input' }
]

const record = (attempts: unknown[]): AgentRunRecord =>
  ({
    invocationId: 'source-inv',
    agentName: 'Replayed',
    agentHash: 'hash:Replayed',
    input: INPUT,
    history: null,
    renderedPrompt: renderedPrompt(),
    attempts
  }) as unknown as AgentRunRecord

const caseFor = (sourceRecord: AgentRunRecord): AgentLabCase =>
  ({
    id: 'case-1',
    agentId: 'Replayed',
    agentName: 'Replayed',
    name: 'fixture',
    createdAt: '',
    hasSource: true,
    runs: [],
    input: sourceRecord.input,
    sourceRecord
  }) as AgentLabCase

describe('Agent Lab replay', () => {
  let db: InstanceType<typeof Adapter>
  let runStore: ReturnType<typeof createAgentRunStore>
  let capturedAdapter: ProviderAdapter | null

  const depsFor = (def: AgentDefinition): AgentLabReplayDeps => ({
    catalog: { get: () => catalogAgent(def) },
    runStore,
    providerDispatchFactory: (adapter): ProviderDispatch => {
      capturedAdapter = adapter
      return createProviderDispatch({
        adapter,
        getSettings: () => settings,
        getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
      })
    },
    createId: () => 'lab-run-1'
  })

  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    runStore = createAgentRunStore({ getDb: () => db, now: () => '2026-07-21T00:00:00.000Z' })
    capturedAdapter = null
  })

  it('replays a captured success to success and pins the wire prompt byte-for-byte', async () => {
    const source = record([
      {
        appendOnlyLog: [
          { role: 'user', content: JSON.stringify(INPUT) },
          { role: 'assistant', content: 'final answer' }
        ],
        usage: [{ inputTokens: 3, outputTokens: 2 }],
        tools: []
      }
    ])
    const replay = createAgentLabReplay(depsFor(definition()))
    const result = await replay({ profileId: 'p', chatId: 'c', floor: 1, case: caseFor(source) })

    expect(result).toEqual({ ok: true, invocationId: 'lab-run-1', status: 'succeeded' })
    expect(runStore.get('c', 'lab-run-1')?.status).toBe('succeeded')

    const requests = (capturedAdapter as unknown as { requests: Array<{ messages: unknown[] }> })
      .requests
    const wire = requests[0].messages.map((message) => {
      const { role, content } = message as { role: string; content: string }
      return { role, content }
    })
    const pinned = renderedPrompt().map(({ role, content }) => ({ role, content }))
    expect(wire).toEqual(pinned)
  })

  it('replays a captured failure to the same failure code', async () => {
    const source = record([
      {
        appendOnlyLog: [
          { role: 'user', content: JSON.stringify(INPUT) },
          { role: 'assistant', content: 'not json' }
        ],
        usage: [{ inputTokens: 1, outputTokens: 1 }],
        tools: []
      }
    ])
    const def = definition({
      result: {
        mode: 'json',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
      }
    })
    const replay = createAgentLabReplay(depsFor(def))
    const result = await replay({ profileId: 'p', chatId: 'c', floor: 1, case: caseFor(source) })

    expect(result).toEqual({ ok: true, invocationId: 'lab-run-1', status: 'failed' })
    expect(runStore.get('c', 'lab-run-1')?.failure?.code).toBe('INVALID_JSON_RESULT')
  })

  it('fails with LAB_TOOL_DIVERGENCE when a requested tool has no recorded result', async () => {
    const source = record([
      {
        appendOnlyLog: [
          { role: 'user', content: JSON.stringify(INPUT) },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'lookup', argumentsText: '{}', input: {} }]
          }
        ],
        usage: [{ inputTokens: 1, outputTokens: 1 }],
        // No recorded tool result -> the stub must diverge, never execute anything real.
        tools: []
      }
    ])
    const def = definition({
      tools: [
        {
          name: 'lookup',
          description: 'look something up',
          inputSchema: { type: 'object' },
          transactionMode: 'read-only',
          parallelSafe: true
        }
      ]
    })
    const replay = createAgentLabReplay(depsFor(def))
    const result = await replay({ profileId: 'p', chatId: 'c', floor: 1, case: caseFor(source) })

    expect(result).toEqual({ ok: false, code: 'LAB_TOOL_DIVERGENCE' })
  })

  it('refuses to replay a case with no source', async () => {
    const replay = createAgentLabReplay(depsFor(definition()))
    const authored = { ...caseFor(record([])), hasSource: false, sourceRecord: undefined }
    const result = await replay({
      profileId: 'p',
      chatId: 'c',
      floor: 1,
      case: authored as AgentLabCase
    })
    expect(result).toEqual({ ok: false, code: 'LAB_NO_SOURCE' })
  })

  it('registers every Agent Lab channel in GATED_CHANNELS', () => {
    for (const channel of Object.values(AGENT_LAB_CHANNELS)) {
      expect(GATED_CHANNELS).toContain(channel)
    }
  })
})
