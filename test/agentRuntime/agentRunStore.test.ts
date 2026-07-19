import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import {
  createAgentRunStore,
  type AgentRunStart
} from '../../src/main/services/agentRuntime/runs/AgentRunStore'
import { AgentCatalog } from '../../src/main/services/agentRuntime/catalog/AgentCatalog'
import type { AgentDefinition, AgentRunEvent } from '../../src/shared/agentRuntime'

const definition: AgentDefinition = {
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'memory.curator',
  prompt: [{ role: 'system', content: [{ type: 'text', text: 'Curate memory.' }] }],
  inputSchema: { type: 'object' },
  result: { mode: 'json', schema: { type: 'object' } },
  tools: [],
  defaults: {
    required: false,
    maxSteps: 3,
    maxRetryAttempts: 1,
    retryDelayMs: 0,
    blocksNextTurn: false,
    toolResultMaxTokens: 100,
    notification: 'none',
    history: { includeUserMessages: true, includePlayerResults: true }
  }
}

const start = (invocationId: string, floor = 4): AgentRunStart => ({
  invocationId,
  profileId: 'p1',
  chatId: 'c1',
  floor,
  agentVersion: 'release/2026.07',
  agentHash: 'sha256:definition-v7',
  definition: structuredClone(definition),
  config: { ...definition.defaults, floor },
  input: { topic: 'harbor' },
  renderedPrompt: [
    { role: 'system', content: 'Curate memory.' },
    { role: 'user', content: 'The harbor is closed.' }
  ],
  history: [{ floor: 3, user: 'Where are we?' }]
})

const CATALOG_SCHEMA = `
CREATE TABLE agent_catalog (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  name_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_present INTEGER NOT NULL DEFAULT 1,
  available_source_version TEXT,
  available_definition TEXT,
  baseline_definition TEXT NOT NULL,
  customization_ops TEXT NOT NULL DEFAULT '[]',
  effective_definition TEXT NOT NULL,
  effective_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, id),
  UNIQUE (profile_id, name_key)
);
CREATE UNIQUE INDEX idx_agent_catalog_source
  ON agent_catalog(profile_id, source_kind, source_key, name);
CREATE TABLE agent_role_bindings (
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, role)
);`

describe('AgentRunStore', () => {
  let db: InstanceType<typeof Adapter>
  let store: ReturnType<typeof createAgentRunStore>

  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    store = createAgentRunStore({ getDb: () => db, now: () => '2026-07-18T12:00:00.000Z' })
  })

  it('keeps an interpretable immutable snapshot after the live Agent changes', () => {
    const invocation = start('run-1')
    const { record } = store.create(invocation)
    invocation.definition.prompt[0].content[0] = { type: 'text', text: 'Edited later.' }
    const finalized = store.finalize('run-1', {
      status: 'succeeded',
      result: { summary: 'Harbor closed' },
      replay: { status: 'committed', operations: 2 },
      evidence: {
        preset: {
          id: 'preset-1',
          name: 'Primary',
          provider: 'openai',
          endpoint: 'https://provider.invalid',
          model: 'model-a',
          cacheMode: 'baseline',
          contextWindowTokens: 8192,
          parameters: { temperature: 0.2 }
        },
        attempts: []
      }
    })

    const stored = store.get('c1', 'run-1')!
    expect(stored.definition.prompt[0].content[0]).toEqual({
      type: 'text',
      text: 'Curate memory.'
    })
    expect(stored.agentVersion).toBe('release/2026.07')
    expect(stored.agentHash).toBe('sha256:definition-v7')
    expect(stored.result).toEqual({ summary: 'Harbor closed' })
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.definition.prompt[0].content)).toBe(true)
    expect(Object.isFrozen(finalized?.result)).toBe(true)
    expect(Object.isFrozen(store.list('c1')[0].contracts)).toBe(true)
    expect(() => Object.assign(stored, { status: 'failed' })).toThrow()
    expect(record.status).toBe('running')
  })

  it('remains interpretable after its Catalog snapshot is edited and deleted', () => {
    const catalogDb = new Adapter(':memory:')
    catalogDb.exec(CATALOG_SCHEMA)
    const catalog = new AgentCatalog('p1', catalogDb as never)
    const [agent] = catalog.installPackage({
      source: {
        kind: 'user-imported',
        key: 'snapshot-agent',
        version: 'release/2026.07'
      },
      agents: [
        {
          format: 'rpt-agent',
          formatVersion: 1,
          name: 'Snapshot Agent',
          prompt: [{ role: 'system', content: 'Catalog original.' }],
          result: { mode: 'text' }
        }
      ]
    }).installed
    const handle = store.create({
      ...start('catalog-snapshot'),
      agentVersion: agent.source.version,
      agentHash: agent.effectiveHash,
      definition: agent.effective
    })

    catalog.edit(agent.id, {
      ...agent.effective,
      prompt: [{ role: 'system', content: 'Edited later.' }]
    })
    catalog.delete(agent.id)

    const stored = store.get('c1', handle.record.invocationId)!
    expect(stored.agentVersion).toBe(agent.source.version)
    expect(stored.agentHash).toBe(agent.effectiveHash)
    expect(stored.definition).toEqual(agent.effective)
    expect(stored.definition.prompt[0].content[0]).toEqual({
      type: 'text',
      text: 'Catalog original.'
    })
    catalogDb.close()
  })

  it('persists complete Harness evidence and aggregate metrics without reasoning or credentials', () => {
    store.create({
      ...start('run-evidence'),
      input: {
        topic: 'harbor',
        note: 'I thought the harbor was open.',
        reasoning: 'input must not retain hidden reasoning',
        nested: [
          {
            password: 'password-value',
            access_token: 'access-token-value',
            'x-api-key': 'api-key-value',
            cookie: 'cookie-value'
          },
          { type: 'reasoning', content: 'discriminator reasoning value' }
        ]
      }
    })
    store.finalize('run-evidence', {
      status: 'failed',
      failure: {
        code: 'CONTEXT_BUDGET_EXCEEDED',
        message: 'bad result',
        retryable: false,
        contextBudget: {
          limit: 100,
          total: 110,
          regions: [{ region: 'append-only-log', tokens: 110 }]
        }
      },
      replay: { status: 'discarded', operations: 1 },
      evidence: {
        preset: {
          id: 'preset-1',
          name: 'Primary',
          provider: 'openai',
          endpoint: 'https://provider.invalid',
          model: 'model-a',
          cacheMode: 'provider',
          contextWindowTokens: 8192,
          parameters: { temperature: 0.2, apiKey: 'must-not-persist' }
        },
        attempts: [
          {
            attempt: 1,
            outcome: 'failure',
            providerCalls: 1,
            immutablePrefix: [{ role: 'system', content: 'policy' }],
            toolSchemas: [],
            appendOnlyLog: [{ role: 'user', content: 'request' }],
            tools: [
              {
                call: { id: 'tool-1', name: 'lookup', argumentsText: '{}' },
                result: {
                  answer: 42,
                  rawReasoning: 'secret chain',
                  reasoning_content: 'reasoning content value',
                  nested: [{ thinking: 'thinking value' }, { thought: 'thought value' }]
                }
              },
              {
                call: { id: 'tool-2', name: 'write', argumentsText: '{}' },
                status: 'failure',
                error: { code: 'WRITE_FAILED', message: 'write failed' },
                result: { secret: 'tool-secret-value' }
              }
            ],
            usage: [{ inputTokens: 11, outputTokens: 4 }],
            cache: [{ readTokens: 7, writeTokens: 2 }],
            latencyMs: [25],
            rateLimits: [{ requestsRemaining: 3 }],
            error: {
              code: 'TOOL_FAILED',
              message: 'lookup failed',
              retryable: false
            },
            repairs: ['truncated-json'],
            rejectedOutput: '{',
            discardedOperations: 1,
            irreversibleBoundary: true,
            irreversibleBoundaries: [
              {
                step: 1,
                toolCall: { id: 'tool-1', name: 'lookup', index: 0 }
              }
            ],
            reasoning: 'provider chain of thought'
          } as never
        ],
        contextBudget: {
          limit: 100,
          total: 110,
          regions: [{ region: 'append-only-log', tokens: 110 }]
        }
      }
    })

    const run = store.get('c1', 'run-evidence')!
    expect(run.input.note).toBe('I thought the harbor was open.')
    expect(run.input.nested).toEqual([{}])
    expect(run.attempts[0].repairs).toEqual(['truncated-json'])
    expect(run.attempts[0].tools).toHaveLength(2)
    expect(run.attempts[0].tools).toEqual([
      {
        call: { id: 'tool-1', name: 'lookup', argumentsText: '{}' },
        result: { answer: 42, nested: [{}, {}] }
      },
      {
        call: { id: 'tool-2', name: 'write', argumentsText: '{}' },
        status: 'failure',
        error: { code: 'WRITE_FAILED', message: 'write failed' },
        result: {}
      }
    ])
    expect(run.attempts[0]).toMatchObject({
      error: { code: 'TOOL_FAILED', message: 'lookup failed', retryable: false },
      usage: [{ inputTokens: 11, outputTokens: 4 }],
      cache: [{ readTokens: 7, writeTokens: 2 }],
      latencyMs: [25],
      irreversibleBoundary: true,
      irreversibleBoundaries: [{ step: 1, toolCall: { id: 'tool-1', name: 'lookup', index: 0 } }]
    })
    expect(run.contextBudget).toEqual({
      limit: 100,
      total: 110,
      regions: [{ region: 'append-only-log', tokens: 110 }]
    })
    expect(run.evidence).toMatchObject({
      attempts: [
        {
          error: { code: 'TOOL_FAILED' },
          usage: [{ inputTokens: 11, outputTokens: 4 }],
          cache: [{ readTokens: 7, writeTokens: 2 }],
          latencyMs: [25],
          tools: [
            { result: { answer: 42 } },
            { status: 'failure', error: { code: 'WRITE_FAILED' } }
          ],
          irreversibleBoundaries: [
            { step: 1, toolCall: { id: 'tool-1', name: 'lookup', index: 0 } }
          ]
        }
      ],
      contextBudget: { limit: 100, total: 110 }
    })
    expect(run.failure?.contextBudget).toEqual(run.contextBudget)
    expect(run.provider?.model).toBe('model-a')
    expect(run.metrics).toMatchObject({
      inputTokens: 11,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      latencyMs: 25,
      retries: 0
    })
    const raw = db
      .prepare('SELECT record FROM agent_runs WHERE invocation_id = ?')
      .get('run-evidence') as { record: string }
    expect(raw.record).not.toContain('provider chain of thought')
    expect(raw.record).not.toContain('secret chain')
    expect(raw.record).not.toContain('must-not-persist')
    expect(raw.record).not.toContain('password-value')
    expect(raw.record).not.toContain('access-token-value')
    expect(raw.record).not.toContain('api-key-value')
    expect(raw.record).not.toContain('cookie-value')
    expect(raw.record).not.toContain('discriminator reasoning value')
    expect(raw.record).not.toContain('reasoning content value')
    expect(raw.record).not.toContain('thinking value')
    expect(raw.record).not.toContain('thought value')
    expect(raw.record).not.toContain('tool-secret-value')
    expect(raw.record).not.toMatch(/"reasoning"/i)
  })

  it('redacts credentials and structured reasoning embedded inside strings', () => {
    const ordinaryStory =
      'The bearer of bad news thought the secret door needed a key before supper.'
    store.create({
      ...start('run-string-redaction'),
      renderedPrompt: [
        { role: 'user', content: ordinaryStory },
        {
          role: 'user',
          content:
            'Authorization: Bearer prompt-token\nx-api-key: prompt-api-key\n' +
            '<thinking>private prompt reasoning</thinking><answer>Safe answer.</answer>'
        }
      ]
    })
    store.finalize('run-string-redaction', {
      status: 'succeeded',
      result: 'Safe result.',
      replay: { status: 'not-applicable', operations: 0 },
      evidence: {
        preset: {
          id: 'preset-1',
          name: 'Primary',
          provider: 'openai',
          endpoint:
            'https://endpoint-user:endpoint-password@provider.invalid/v1?token=endpoint-token&mode=fast',
          model: 'model-a',
          cacheMode: 'provider',
          contextWindowTokens: 8192,
          parameters: {}
        },
        attempts: [
          {
            attempt: 1,
            outcome: 'success',
            providerCalls: 1,
            immutablePrefix: [],
            toolSchemas: [],
            appendOnlyLog: [],
            tools: [
              {
                call: {
                  id: 'tool-1',
                  name: 'lookup',
                  argumentsText: JSON.stringify({
                    nested: [
                      {
                        access_token: 'tool-access-token',
                        note: 'safe nested value'
                      }
                    ],
                    endpoint:
                      'https://tool-user:tool-password@tools.invalid/search?api_key=tool-query-key&q=harbor',
                    headers: {
                      Authorization: 'Bearer tool-bearer-token',
                      'x-api-key': 'tool-header-key'
                    },
                    reasoning_content: 'private tool reasoning'
                  })
                },
                result:
                  '{"items":[{"name":"safe item","password":"result-password"}],"thought":"private full-result reasoning"}',
                projectedContent:
                  '[{"answer":"safe projection"},{"thinking":"private projected reasoning"}]'
              }
            ],
            usage: [],
            cache: [],
            latencyMs: [],
            rateLimits: []
          }
        ]
      }
    })

    const run = store.get('c1', 'run-string-redaction')!
    expect(run.renderedPrompt[0].content).toBe(ordinaryStory)
    expect(run.renderedPrompt[1].content).toBe(
      'Authorization: Bearer [redacted]\nx-api-key: [redacted]\n' +
        '<thinking>[redacted]</thinking><answer>Safe answer.</answer>'
    )
    expect(run.provider?.endpoint).toBe(
      'https://provider.invalid/v1?token=[redacted]&mode=fast'
    )

    const tool = run.attempts[0].tools[0]
    expect(JSON.parse(tool.call.argumentsText)).toEqual({
      nested: [{ access_token: '[redacted]', note: 'safe nested value' }],
      endpoint: 'https://tools.invalid/search?api_key=[redacted]&q=harbor',
      headers: {
        Authorization: 'Bearer [redacted]',
        'x-api-key': '[redacted]'
      },
      reasoning_content: '[redacted]'
    })
    expect(JSON.parse(tool.result as string)).toEqual({
      items: [{ name: 'safe item', password: '[redacted]' }],
      thought: '[redacted]'
    })
    expect(JSON.parse(tool.projectedContent!)).toEqual([
      { answer: 'safe projection' },
      { thinking: '[redacted]' }
    ])

    const raw = db
      .prepare('SELECT record FROM agent_runs WHERE invocation_id = ?')
      .get('run-string-redaction') as { record: string }
    for (const secret of [
      'prompt-token',
      'prompt-api-key',
      'private prompt reasoning',
      'endpoint-user',
      'endpoint-password',
      'endpoint-token',
      'tool-access-token',
      'tool-user',
      'tool-password',
      'tool-query-key',
      'tool-bearer-token',
      'tool-header-key',
      'private tool reasoning',
      'result-password',
      'private full-result reasoning',
      'private projected reasoning'
    ]) {
      expect(raw.record).not.toContain(secret)
    }
  })

  it('publishes an immutable in-flight evidence update before finalization', () => {
    const events: AgentRunEvent[] = []
    store.subscribe((event) => events.push(event))
    store.create(start('updating'))
    const updated = store.update(
      'updating',
      {
        preset: {
          id: 'preset-1',
          name: 'Primary',
          provider: 'openai',
          endpoint: 'https://provider.invalid',
          model: 'frozen-model',
          cacheMode: 'provider',
          contextWindowTokens: 8192,
          parameters: {}
        },
        attempts: [
          {
            attempt: 1,
            outcome: 'retry',
            providerCalls: 1,
            immutablePrefix: [],
            toolSchemas: [],
            appendOnlyLog: [],
            tools: [],
            usage: [{ inputTokens: 3, outputTokens: 1 }],
            cache: [],
            latencyMs: [8],
            rateLimits: []
          }
        ]
      },
      ['degraded projection']
    )

    expect(updated).toMatchObject({
      status: 'running',
      attempts: [{ outcome: 'retry' }],
      metrics: { inputTokens: 3, outputTokens: 1, latencyMs: 8 },
      warnings: ['degraded projection']
    })
    expect(Object.isFrozen(updated?.attempts[0])).toBe(true)
    expect(() => updated?.attempts[0].latencyMs.push(99)).toThrow()
    expect(events.at(-1)).toMatchObject({
      type: 'updated',
      run: {
        model: 'frozen-model',
        metrics: { inputTokens: 3, outputTokens: 1, latencyMs: 8 }
      }
    })
  })

  it('deletes completed and in-flight records with their owning floor', () => {
    store.create(start('retained', 3))
    store.finalize('retained', {
      status: 'succeeded',
      result: 'kept',
      evidence: { attempts: [] },
      replay: { status: 'not-applicable', operations: 0 }
    })
    store.create(start('completed', 4))
    store.finalize('completed', {
      status: 'succeeded',
      result: 'done',
      evidence: { attempts: [] },
      replay: { status: 'not-applicable', operations: 0 }
    })
    const active = store.create(start('active', 5))

    store.deleteFromFloor('c1', 4)

    expect(active.signal.aborted).toBe(true)
    expect(store.list('c1').map((record) => record.invocationId)).toEqual(['retained'])
  })

  it('cancels every invocation and erases every record when the owning chat is deleted', () => {
    store.create(start('chat-completed', 1))
    store.finalize('chat-completed', {
      status: 'succeeded',
      result: 'done',
      evidence: { attempts: [] },
      replay: { status: 'not-applicable', operations: 0 }
    })
    const first = store.create(start('chat-first', 2))
    const second = store.create(start('chat-second', 9))

    store.deleteChat('c1')

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(store.list('c1')).toEqual([])
  })

  it('stops only the requested invocation when calls overlap in one chat', () => {
    const first = store.create(start('first'))
    const second = store.create(start('second'))
    const events: string[] = []
    store.subscribe((event) => events.push(event.type))

    expect(store.cancel('first')).toEqual({ invocationId: 'first', cancelled: true })
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(store.get('c1', 'first')?.status).toBe('cancelled')
    expect(store.get('c1', 'second')?.status).toBe('running')
    expect(events).toContain('finished')
  })

  it('emits running activity even when notification is none and shutdown finalizes unfinished runs', () => {
    const events: Array<{ type: string; notification?: string }> = []
    store.subscribe((event) =>
      events.push({
        type: event.type,
        notification: event.type === 'deleted' ? undefined : event.run.notification
      })
    )
    const handle = store.create(start('quiet'))

    expect(events).toContainEqual({ type: 'started', notification: 'none' })
    store.shutdown()
    expect(handle.signal.aborted).toBe(true)
    expect(store.get('c1', 'quiet')).toMatchObject({
      status: 'cancelled',
      failure: { code: 'APP_SHUTDOWN' }
    })
  })
})
