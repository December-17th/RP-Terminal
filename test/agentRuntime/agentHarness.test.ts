import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderDispatchError,
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderAdapter,
  type ProviderConnection
} from '../../src/main/services/agentRuntime/provider'
import {
  createAgentHarness,
  createToolRegistry,
  type ToolBinding
} from '../../src/main/services/agentRuntime/harness'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'

afterEach(() => {
  vi.useRealTimers()
})

const connection: ProviderConnection = {
  provider: 'openai',
  endpoint: 'https://provider.test/v1',
  apiKey: 'secret',
  model: 'fixed-model',
  rpmLimit: 0,
  maxConcurrent: 0
}

const dispatchFor = (adapter: ProviderAdapter) =>
  createProviderDispatch({
    adapter,
    getSettings: () =>
      ({
        api: {
          provider: connection.provider,
          endpoint: connection.endpoint,
          api_key: connection.apiKey,
          model: connection.model
        },
        api_presets: [
          {
            id: 'fixed-preset',
            name: 'Fixed preset',
            provider: connection.provider,
            endpoint: connection.endpoint,
            api_key: connection.apiKey,
            model: connection.model
          }
        ],
        active_api_preset_id: 'fixed-preset',
        cache: { mode: 'baseline' }
      }) as Settings,
    getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
  })

const dispatchForProvider = (adapter: ProviderAdapter, provider: string) =>
  createProviderDispatch({
    adapter,
    getSettings: () =>
      ({
        api: { ...connection, provider },
        api_presets: [
          {
            id: 'fixed-preset',
            name: 'Fixed preset',
            provider,
            endpoint: connection.endpoint,
            api_key: connection.apiKey,
            model: connection.model
          }
        ],
        active_api_preset_id: 'fixed-preset',
        cache: { mode: 'baseline' }
      }) as Settings,
    getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
  })

const definition = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Harness Test',
    prompt: [{ role: 'system', content: 'Return the requested result.' }],
    inputSchema: { type: 'object' },
    result: { mode: 'text' },
    tools: [],
    defaults: { retryDelayMs: 0 },
    ...overrides
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const lookupTool = {
  name: 'lookup',
  description: 'Look up one value.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'integer' } }
  },
  required: true,
  transactionMode: 'transactional',
  parallelSafe: false
} as const

const toolBinding = (
  execute: ToolBinding['execute'],
  overrides: Partial<ToolBinding> = {}
): ToolBinding => ({
  name: 'lookup',
  inputSchema: lookupTool.inputSchema,
  transactionMode: 'transactional',
  parallelSafe: false,
  execute,
  ...overrides
})

describe('AgentHarness.execute', () => {
  it('executes a one-call text Agent through the provider-neutral Interface', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'text-delta', delta: 'Complete.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition(),
      input: { request: 'answer' },
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Complete.',
      stagedOperations: [],
      evidence: {
        attempts: [{ outcome: 'success', providerCalls: 1 }]
      }
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0].messages.map((message) => message.content)).toEqual([
      expect.stringContaining('RP Terminal Agent Harness'),
      'Return the requested result.',
      '{"request":"answer"}'
    ])
  })

  it('runs bounded Agent Steps and returns staged operations only after result validation', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'call-1',
            name: 'lookup',
            argumentsDelta: '{"id":7}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Found seven.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((input, context) => {
          context.stage({ type: 'set', payload: { id: input.id, found: true } })
          return { label: 'seven' }
        })
      ])
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool], defaults: { retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Found seven.',
      stagedOperations: [{ type: 'set', payload: { id: 7, found: true } }],
      evidence: {
        attempts: [
          {
            outcome: 'success',
            providerCalls: 2,
            tools: [
              {
                call: { name: 'lookup', input: { id: 7 } },
                result: { label: 'seven' }
              }
            ]
          }
        ]
      }
    })
    expect(adapter.requests[1].messages.slice(-2)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [expect.objectContaining({ name: 'lookup' })]
      }),
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        content: '{"label":"seven"}'
      })
    ])
  })

  it.each([
    [
      'json',
      {
        mode: 'json',
        schema: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } }
      },
      '{"value":3',
      { value: 3 }
    ],
    [
      'yss',
      { mode: 'text', validator: 'yss' },
      '<| bg room |>\n<| yuzu neutral center enter |>\nyuzu: Quiet.\n<| end |>',
      '<| bg room |>\n<| yuzu neutral center enter |>\nyuzu: Quiet.\n<| end |>'
    ]
  ])('validates %s results before success', async (_mode, contract, text, expected) => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'text-delta', delta: text },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition({ result: contract }),
      input: {},
      profileId: 'test-profile',
      yssVocabulary: {
        actors: new Set(['yuzu']),
        expressions: new Set(['neutral']),
        locations: new Set(['room']),
        cgs: new Set(),
        audio: new Set()
      }
    })

    expect(result).toMatchObject({ ok: true, result: expected })
  })

  it('accepts tools-only success only after a bound tool executes', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      { events: [{ type: 'finish', reason: 'stop' }] }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(() => ({ ok: true }))])
    })

    const result = await harness.execute({
      definition: definition({
        result: { mode: 'tools-only' },
        tools: [lookupTool],
        defaults: { retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({ ok: true, result: undefined })
  })

  it('uses a fresh transaction and corrective context when retrying a rejected result', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: '{"wrong":true}' },
          { type: 'finish', reason: 'stop' }
        ]
      },
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: '{"value":2}' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((input, context) => {
          context.stage({ type: 'set', payload: { id: input.id } })
          return { id: input.id }
        })
      ])
    })

    const result = await harness.execute({
      definition: definition({
        result: {
          mode: 'json',
          schema: {
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'integer' } }
          }
        },
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 1, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: { value: 2 },
      stagedOperations: [{ type: 'set', payload: { id: 2 } }],
      evidence: {
        attempts: [{ outcome: 'retry', discardedOperations: 1 }, { outcome: 'success' }]
      }
    })
    expect(adapter.requests[2].messages).toEqual([
      ...adapter.requests[0].messages,
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('{"wrong":true}')
      })
    ])
    expect(adapter.requests[2].messages.some((message) => message.role === 'tool')).toBe(false)
    expect(adapter.requests.every((request) => request.connection.model === 'fixed-model')).toBe(
      true
    )
  })

  it('honors Retry-After as the retry-delay lower bound for transport retries', async () => {
    vi.useFakeTimers()
    const adapter = createScriptedProviderAdapter([
      {
        error: new ProviderDispatchError('busy', {
          retryClass: 'rate-limit',
          retryAfterMs: 250
        })
      },
      {
        events: [
          { type: 'text-delta', delta: 'Recovered.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })
    const execution = harness.execute({
      definition: definition({ defaults: { maxRetryAttempts: 1, retryDelayMs: 100 } }),
      input: {},
      profileId: 'test-profile'
    })

    await vi.advanceTimersByTimeAsync(249)
    expect(adapter.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(execution).resolves.toMatchObject({
      ok: true,
      result: 'Recovered.',
      evidence: { attempts: [{ outcome: 'retry' }, { outcome: 'success' }] }
    })
    expect(adapter.requests[1].messages).toEqual(adapter.requests[0].messages)
  })

  it('uses the contract default of five retries after the initial attempt', async () => {
    const adapter = createScriptedProviderAdapter(
      Array.from({ length: 6 }, () => ({
        error: new ProviderDispatchError('temporary', { retryClass: 'transient' as const })
      }))
    )
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition(),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'PROVIDER_TRANSIENT' },
      evidence: {
        attempts: expect.arrayContaining([
          expect.objectContaining({ attempt: 6, outcome: 'failure' })
        ])
      }
    })
    expect(adapter.requests).toHaveLength(6)
  })

  it('keeps sanitized provider diagnostics out of failed Harness evidence', async () => {
    const rawFrameSecret = 'private-chain-from-provider'
    const dispatch = createProviderDispatch({
      fetch: vi.fn(async () => {
        return new Response(`data: ${JSON.stringify({ internal_reasoning: rawFrameSecret })}\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      }) as typeof fetch,
      getSettings: () =>
        ({
          api: {
            provider: connection.provider,
            endpoint: connection.endpoint,
            api_key: connection.apiKey,
            model: connection.model
          },
          api_presets: [
            {
              id: 'fixed-preset',
              name: 'Fixed preset',
              provider: connection.provider,
              endpoint: connection.endpoint,
              api_key: connection.apiKey,
              model: connection.model
            }
          ],
          active_api_preset_id: 'fixed-preset',
          generation: { max_context_tokens: 4096 },
          cache: { mode: 'baseline' }
        }) as Settings,
      getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
    })
    const harness = createAgentHarness({
      providerDispatch: dispatch,
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition({ defaults: { maxRetryAttempts: 0, retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'PROVIDER_TRANSIENT',
        message: expect.not.stringContaining(rawFrameSecret)
      }
    })
    expect(JSON.stringify(result)).not.toContain(rawFrameSecret)
    expect(JSON.stringify(result)).not.toContain('Raw frames')
  })

  it.each([
    {
      provider: 'anthropic',
      fallbackModel: 'claude-opus-4-8',
      response:
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Visible."}}\n',
      sentModel: (input: RequestInfo | URL, init?: RequestInit) =>
        (JSON.parse(String(init?.body)) as { model?: string }).model
    },
    {
      provider: 'gemini',
      fallbackModel: 'gemini-2.5-flash',
      response:
        'data: {"candidates":[{"content":{"parts":[{"text":"Visible."}]},"finishReason":"STOP"}]}\n',
      sentModel: (input: RequestInfo | URL) =>
        decodeURIComponent(String(input)).match(/\/models\/([^/:]+):/)?.[1]
    }
  ])(
    'records the exact provider fallback model dispatched for an empty $provider preset',
    async ({ provider, fallbackModel, response, sentModel }) => {
      const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
      const dispatch = createProviderDispatch({
        fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ input, init })
          return new Response(response, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
        }) as typeof fetch,
        getSettings: () =>
          ({
            api: {
              provider,
              endpoint: connection.endpoint,
              api_key: connection.apiKey,
              model: ''
            },
            api_presets: [
              {
                id: 'empty-model-preset',
                name: 'Empty model preset',
                provider,
                endpoint: connection.endpoint,
                api_key: connection.apiKey,
                model: ''
              }
            ],
            active_api_preset_id: 'empty-model-preset',
            generation: { max_context_tokens: 4096 },
            cache: { mode: 'baseline' }
          }) as Settings,
        getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
      })
      const harness = createAgentHarness({
        providerDispatch: dispatch,
        toolRegistry: createToolRegistry()
      })

      const result = await harness.execute({
        definition: definition({ defaults: { maxRetryAttempts: 0, retryDelayMs: 0 } }),
        input: {},
        profileId: 'test-profile'
      })

      expect(result).toMatchObject({
        ok: true,
        result: 'Visible.',
        evidence: { preset: { model: fallbackModel } }
      })
      expect(requests).toHaveLength(1)
      expect(sentModel(requests[0].input, requests[0].init)).toBe(fallbackModel)
    }
  )

  it('keeps private HTTP compatibility details out of failed Harness evidence', async () => {
    const responseSecret = 'private-reasoning-from-provider'
    const dispatch = createProviderDispatch({
      fetch: vi.fn(async () => {
        return new Response(responseSecret, {
          status: 401,
          statusText: 'Secret Authorization Detail'
        })
      }) as typeof fetch,
      getSettings: () =>
        ({
          api: {
            provider: connection.provider,
            endpoint: connection.endpoint,
            api_key: connection.apiKey,
            model: connection.model
          },
          api_presets: [
            {
              id: 'fixed-preset',
              name: 'Fixed preset',
              provider: connection.provider,
              endpoint: connection.endpoint,
              api_key: connection.apiKey,
              model: connection.model
            }
          ],
          active_api_preset_id: 'fixed-preset',
          generation: { max_context_tokens: 4096 },
          cache: { mode: 'baseline' }
        }) as Settings,
      getActivePreset: () => ({ parameters: { temperature: 0, max_tokens: 100 } }) as Preset
    })
    const harness = createAgentHarness({
      providerDispatch: dispatch,
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition({ defaults: { maxRetryAttempts: 0, retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'PROVIDER_NON_RETRYABLE',
        message: 'Provider request failed (http; status=401)'
      }
    })
    expect(JSON.stringify(result)).not.toContain(responseSecret)
    expect(JSON.stringify(result)).not.toContain('Secret Authorization Detail')
  })

  it('resends a failed provider request without re-executing successful tools', async () => {
    const readTool = {
      ...lookupTool,
      name: 'read',
      transactionMode: 'read-only'
    } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'read',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        error: new ProviderDispatchError('connection reset', { retryClass: 'transient' })
      },
      {
        events: [
          { type: 'text-delta', delta: 'Recovered after replay.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const read = vi.fn((input) => ({ read: input.id }))
    const write = vi.fn((input, context) => {
      context.stage({ type: 'set', payload: { id: input.id } })
      return { wrote: input.id }
    })
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(read, { name: 'read', transactionMode: 'read-only' }),
        toolBinding(write)
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [readTool, lookupTool],
        defaults: { maxSteps: 2, maxRetryAttempts: 1, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Recovered after replay.',
      stagedOperations: [{ type: 'set', payload: { id: 1 } }],
      evidence: {
        attempts: [
          { outcome: 'retry', providerCalls: 2, discardedOperations: 1 },
          { outcome: 'success', providerCalls: 1 }
        ]
      }
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(adapter.requests[2])).toBe(JSON.stringify(adapter.requests[1]))
  })

  it('records structured Tool Evidence when a transactional tool execution fails', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'transactional-failure',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((_input, context) => {
          context.stage({ type: 'set', payload: { id: 1 } })
          throw new Error('transactional write failed')
        })
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'TOOL_EXECUTION_FAILED' },
      stagedOperations: [],
      evidence: {
        attempts: [
          {
            tools: [
              {
                step: 1,
                call: { id: 'transactional-failure', name: 'lookup' },
                index: 0,
                arguments: { id: 1 },
                status: 'failure',
                error: {
                  code: 'TOOL_EXECUTION_FAILED',
                  message: 'Tool execution failed'
                },
                durationMs: expect.any(Number),
                transactionMode: 'transactional',
                irreversibleBoundaryCrossed: false
              }
            ],
            discardedOperations: 1
          }
        ]
      }
    })
    if (result.ok) throw new Error('Expected tool execution failure')
    const failedTool = result.evidence.attempts[0].tools[0]
    expect(failedTool).not.toHaveProperty('result')
    expect(failedTool).not.toHaveProperty('projectedContent')
  })

  it('retains an earlier sequential success when a later tool fails and discards its operation', async () => {
    const secondTool = { ...lookupTool, name: 'lookup-second' }
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'sequential-success',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            id: 'sequential-failure',
            name: 'lookup-second',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((_input, context) => {
          context.stage({ type: 'set', payload: { retainedOnlyAsEvidence: true } })
          return { nested: { value: 'first-success' } }
        }),
        {
          ...toolBinding(() => {
            throw new Error('second failed')
          }),
          name: 'lookup-second'
        }
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [lookupTool, secondTool],
        defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'TOOL_EXECUTION_FAILED' },
      stagedOperations: [],
      evidence: {
        attempts: [
          {
            tools: [
              {
                call: { id: 'sequential-success', name: 'lookup' },
                result: { nested: { value: 'first-success' } },
                projectedContent: '{"nested":{"value":"first-success"}}'
              },
              {
                call: { id: 'sequential-failure', name: 'lookup-second' },
                status: 'failure',
                error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' }
              }
            ],
            appendOnlyLog: [
              expect.any(Object),
              expect.any(Object),
              expect.objectContaining({
                role: 'tool',
                toolCallId: 'sequential-success',
                content: '{"nested":{"value":"first-success"}}'
              }),
              expect.objectContaining({
                role: 'tool',
                toolCallId: 'sequential-failure',
                content:
                  '{"error":{"code":"TOOL_EXECUTION_FAILED","message":"Tool execution failed"}}'
              })
            ],
            discardedOperations: 1
          }
        ]
      }
    })
  })

  it('records parallel tool failures in model order without raw failure payloads', async () => {
    const secondTool = { ...lookupTool, name: 'lookup-second', parallelSafe: true }
    const firstTool = { ...lookupTool, parallelSafe: true }
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'parallel-first',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            id: 'parallel-second',
            name: 'lookup-second',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    let releaseFirst!: () => void
    const firstCanFail = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const completionOrder: string[] = []
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          async () => {
            await firstCanFail
            completionOrder.push('first')
            throw Object.assign(new Error('first failed: raw-tool-secret'), {
              reasoning: 'private-chain',
              nonJson: 1n
            })
          },
          { parallelSafe: true }
        ),
        {
          ...toolBinding(
            () => {
              completionOrder.push('second')
              releaseFirst()
              throw new Error('second failed')
            },
            { parallelSafe: true }
          ),
          name: 'lookup-second'
        }
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [firstTool, secondTool],
        defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(completionOrder).toEqual(['second', 'first'])
    expect(result).toMatchObject({
      ok: false,
      evidence: {
        attempts: [
          {
            tools: [
              {
                step: 1,
                call: { id: 'parallel-first', name: 'lookup' },
                index: 0,
                arguments: { id: 1 },
                status: 'failure',
                error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' },
                durationMs: expect.any(Number),
                transactionMode: 'transactional',
                irreversibleBoundaryCrossed: false
              },
              {
                step: 1,
                call: { id: 'parallel-second', name: 'lookup-second' },
                index: 1,
                arguments: { id: 2 },
                status: 'failure',
                error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' },
                durationMs: expect.any(Number),
                transactionMode: 'transactional',
                irreversibleBoundaryCrossed: false
              }
            ]
          }
        ]
      }
    })
    if (result.ok) throw new Error('Expected parallel tool execution failure')
    const serializedAttempt = JSON.stringify(result.evidence.attempts[0])
    expect(serializedAttempt).not.toContain('raw-tool-secret')
    expect(serializedAttempt).not.toContain('private-chain')
    for (const failedTool of result.evidence.attempts[0].tools) {
      expect(failedTool).not.toHaveProperty('result')
      expect(failedTool).not.toHaveProperty('projectedContent')
    }
  })

  it('retains parallel mixed outcomes in model order without committing a successful sibling', async () => {
    const failingTool = { ...lookupTool, parallelSafe: true }
    const externalTool = {
      ...lookupTool,
      name: 'send-external',
      transactionMode: 'non-transactional',
      parallelSafe: true
    } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'parallel-failure',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            id: 'parallel-external-success',
            name: 'send-external',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          (_input, context) => {
            context.stage({ type: 'set', payload: { mustBeDiscarded: true } })
            throw new Error('transactional sibling failed')
          },
          { parallelSafe: true }
        ),
        {
          ...toolBinding(
            (_input, context) => {
              context.beginExternalEffect()
              return { sent: { id: 2, accepted: true } }
            },
            { transactionMode: 'non-transactional', parallelSafe: true }
          ),
          name: 'send-external'
        }
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [failingTool, externalTool],
        defaults: { maxRetryAttempts: 2, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'TOOL_EXECUTION_FAILED', retryable: false },
      stagedOperations: [],
      evidence: {
        attempts: [
          {
            outcome: 'failure',
            tools: [
              {
                call: { id: 'parallel-failure', name: 'lookup' },
                status: 'failure',
                error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' }
              },
              {
                call: { id: 'parallel-external-success', name: 'send-external' },
                result: { sent: { id: 2, accepted: true } },
                projectedContent: '{"sent":{"id":2,"accepted":true}}'
              }
            ],
            appendOnlyLog: [
              expect.any(Object),
              expect.any(Object),
              expect.objectContaining({
                role: 'tool',
                toolCallId: 'parallel-failure',
                content:
                  '{"error":{"code":"TOOL_EXECUTION_FAILED","message":"Tool execution failed"}}'
              }),
              expect.objectContaining({
                role: 'tool',
                toolCallId: 'parallel-external-success',
                content: '{"sent":{"id":2,"accepted":true}}'
              })
            ],
            discardedOperations: 1,
            irreversibleBoundary: true,
            irreversibleBoundaries: [
              {
                step: 1,
                toolCall: {
                  id: 'parallel-external-success',
                  name: 'send-external',
                  index: 1
                }
              }
            ]
          }
        ]
      }
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('records the irreversible boundary on a successful attempt', async () => {
    const externalTool = { ...lookupTool, transactionMode: 'non-transactional' } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'external-success',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Sent.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          (_input, context) => {
            context.beginExternalEffect()
            return { sent: true }
          },
          { transactionMode: 'non-transactional' }
        )
      ])
    })

    const result = await harness.execute({
      definition: definition({ tools: [externalTool] }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Sent.',
      evidence: {
        attempts: [
          {
            outcome: 'success',
            irreversibleBoundary: true,
            irreversibleBoundaries: [
              {
                step: 1,
                toolCall: { id: 'external-success', name: 'lookup', index: 0 }
              }
            ]
          }
        ]
      }
    })
  })

  it('records failed Tool Evidence after an irreversible boundary and does not retry', async () => {
    const externalTool = { ...lookupTool, transactionMode: 'non-transactional' } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'external-failure',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          (_input, context) => {
            context.beginExternalEffect()
            throw new Error('external send failed after dispatch')
          },
          { transactionMode: 'non-transactional' }
        )
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [externalTool],
        defaults: { maxRetryAttempts: 2, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'TOOL_EXECUTION_FAILED', retryable: false },
      evidence: {
        attempts: [
          {
            outcome: 'failure',
            tools: [
              {
                step: 1,
                call: { id: 'external-failure', name: 'lookup' },
                index: 0,
                arguments: { id: 1 },
                status: 'failure',
                error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' },
                durationMs: expect.any(Number),
                transactionMode: 'non-transactional',
                irreversibleBoundaryCrossed: true
              }
            ],
            irreversibleBoundary: true,
            irreversibleBoundaries: [
              {
                step: 1,
                toolCall: { id: 'external-failure', name: 'lookup', index: 0 }
              }
            ]
          }
        ]
      }
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('attributes multiple irreversible boundaries in model-declared order', async () => {
    const firstTool = {
      ...lookupTool,
      name: 'send-first',
      transactionMode: 'non-transactional'
    } as const
    const secondTool = {
      ...lookupTool,
      name: 'send-second',
      transactionMode: 'non-transactional'
    } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'external-first',
            name: 'send-first',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            id: 'external-second',
            name: 'send-second',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Both sent.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const externalBinding = (name: string): ToolBinding => ({
      ...toolBinding((_input, context) => {
        context.beginExternalEffect()
        return { sent: true }
      }),
      name,
      transactionMode: 'non-transactional'
    })
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        externalBinding('send-first'),
        externalBinding('send-second')
      ])
    })

    const result = await harness.execute({
      definition: definition({ tools: [firstTool, secondTool] }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Both sent.',
      evidence: {
        attempts: [
          {
            irreversibleBoundaries: [
              {
                step: 1,
                toolCall: { id: 'external-first', name: 'send-first', index: 0 }
              },
              {
                step: 1,
                toolCall: { id: 'external-second', name: 'send-second', index: 1 }
              }
            ]
          }
        ]
      }
    })
  })

  it.each([
    ['BigInt', () => ({ nested: { value: 1n } })],
    [
      'a cycle',
      () => {
        const value: Record<string, unknown> = {}
        value.self = value
        return value
      }
    ],
    ['a nested function', () => ({ nested: { value: () => undefined } })],
    ['a nested symbol', () => ({ nested: { value: Symbol('invalid') } })]
  ])(
    'returns a retryable tool failure for a result containing %s',
    async (_label, invalidResult) => {
      const toolCall = {
        events: [
          {
            type: 'tool-call-delta' as const,
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish' as const, reason: 'tool-calls' as const }
        ]
      }
      const adapter = createScriptedProviderAdapter([toolCall, toolCall])
      const execute = vi.fn(() => invalidResult() as never)
      const harness = createAgentHarness({
        providerDispatch: dispatchFor(adapter),
        toolRegistry: createToolRegistry([toolBinding(execute)])
      })

      await expect(
        harness.execute({
          definition: definition({
            tools: [lookupTool],
            defaults: { maxRetryAttempts: 1, retryDelayMs: 0 }
          }),
          input: {},
          profileId: 'test-profile'
        })
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: 'INVALID_TOOL_RESULT', retryable: true },
        stagedOperations: [],
        evidence: {
          attempts: [
            { outcome: 'retry', error: { code: 'INVALID_TOOL_RESULT', retryable: true } },
            { outcome: 'failure', error: { code: 'INVALID_TOOL_RESULT', retryable: true } }
          ]
        }
      })
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )

  it('repairs wrong-channel and unambiguously truncated tool calls without a provider retry', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'reasoning-delta',
            delta: '{"name":"lookup","arguments":{"id":4}}'
          },
          { type: 'finish', reason: 'stop' }
        ]
      },
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":5'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Done.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const seen: number[] = []
    const harness = createAgentHarness({
      providerDispatch: dispatchForProvider(adapter, 'deepseek'),
      toolRegistry: createToolRegistry([
        toolBinding((input) => {
          seen.push(input.id as number)
          return { id: input.id }
        })
      ])
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool], defaults: { retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        attempts: [
          {
            providerCalls: 3,
            repairs: ['wrong-channel-tool-call', 'truncated-json'],
            tools: [
              { repaired: 'wrong-channel', call: { input: { id: 4 } } },
              { repaired: 'truncated-json', call: { input: { id: 5 } } }
            ]
          }
        ]
      }
    })
    expect(seen).toEqual([4, 5])
  })

  it('does not reinterpret a valid JSON result named like a tool or invent its arguments', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'text-delta', delta: '{"name":"lookup"}' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const execute = vi.fn(() => ({ shouldNotRun: true }))
    const harness = createAgentHarness({
      providerDispatch: dispatchForProvider(adapter, 'deepseek'),
      toolRegistry: createToolRegistry([toolBinding(execute)])
    })

    const result = await harness.execute({
      definition: definition({
        result: {
          mode: 'json',
          schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { const: 'lookup' } },
            additionalProperties: false
          }
        },
        tools: [lookupTool]
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({ ok: true, result: { name: 'lookup' } })
    expect(execute).not.toHaveBeenCalled()
    expect(adapter.requests).toHaveLength(1)
  })

  it('requires capability permission and explicit arguments before wrong-channel repair', async () => {
    const wrongChannel = {
      events: [
        {
          type: 'reasoning-delta' as const,
          delta: '{"name":"lookup","arguments":{"id":9}}'
        },
        { type: 'finish' as const, reason: 'stop' as const }
      ]
    }
    const deniedAdapter = createScriptedProviderAdapter([wrongChannel])
    const deniedExecute = vi.fn(() => ({ ok: true }))
    const deniedHarness = createAgentHarness({
      providerDispatch: dispatchForProvider(deniedAdapter, 'openai'),
      toolRegistry: createToolRegistry([toolBinding(deniedExecute)])
    })

    const denied = await deniedHarness.execute({
      definition: definition({
        result: { mode: 'tools-only' },
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(denied).toMatchObject({
      ok: false,
      failure: { code: 'TOOLS_ONLY_NO_EFFECT' }
    })
    expect(deniedExecute).not.toHaveBeenCalled()

    const missingAdapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'reasoning-delta', delta: '{"name":"lookup"}' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const missingExecute = vi.fn(() => ({ ok: true }))
    const missingHarness = createAgentHarness({
      providerDispatch: dispatchForProvider(missingAdapter, 'deepseek'),
      toolRegistry: createToolRegistry([toolBinding(missingExecute)])
    })
    const missing = await missingHarness.execute({
      definition: definition({
        result: { mode: 'tools-only' },
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(missing).toMatchObject({
      ok: false,
      failure: { code: 'TOOLS_ONLY_NO_EFFECT' }
    })
    expect(missingExecute).not.toHaveBeenCalled()
  })

  it('starts Corrective Retry for unrecoverable tool arguments', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Corrected.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const execute = vi.fn(() => ({ ok: true }))
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(execute)])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 1, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Corrected.',
      evidence: {
        attempts: [
          { outcome: 'retry', error: { code: 'INVALID_TOOL_ARGUMENTS' } },
          { outcome: 'success' }
        ]
      }
    })
    expect(execute).not.toHaveBeenCalled()
    expect(adapter.requests[1].messages.at(-1)?.content).toContain('Malformed arguments')
  })

  it('retries provider-truncated text when no deterministic repair exists', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'text-delta', delta: 'Cut off' },
          { type: 'finish', reason: 'length' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Complete.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition({ defaults: { maxRetryAttempts: 1, retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Complete.',
      evidence: {
        attempts: [
          { outcome: 'retry', error: { code: 'TRUNCATED_RESULT' } },
          { outcome: 'success' }
        ]
      }
    })
  })

  it('executes parallel-safe calls concurrently but appends evidence in model order', async () => {
    const secondTool = { ...lookupTool, name: 'lookup-second', parallelSafe: true }
    const firstTool = { ...lookupTool, parallelSafe: true }
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'first',
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            id: 'second',
            name: 'lookup-second',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Done.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const completionOrder: string[] = []
    let releaseFirst!: () => void
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          async () => {
            await firstDone
            completionOrder.push('first')
            return { order: 1 }
          },
          { parallelSafe: true }
        ),
        {
          ...toolBinding(
            () => {
              completionOrder.push('second')
              releaseFirst()
              return { order: 2 }
            },
            { parallelSafe: true }
          ),
          name: 'lookup-second'
        }
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [firstTool, secondTool],
        defaults: { retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(completionOrder).toEqual(['second', 'first'])
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        attempts: [{ tools: [{ call: { id: 'first' } }, { call: { id: 'second' } }] }]
      }
    })
    expect(adapter.requests[1].messages.filter((message) => message.role === 'tool')).toEqual([
      expect.objectContaining({ toolCallId: 'first' }),
      expect.objectContaining({ toolCallId: 'second' })
    ])
  })

  it('retains complete tool evidence while applying the default 10,000-token projection', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Done.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const full = 'x'.repeat(50_000)
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(() => ({ full }))])
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool], defaults: { retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        attempts: [
          {
            tools: [
              {
                result: { full },
                projectionLimit: 10_000,
                projectedTokens: 10_000,
                truncated: true
              }
            ]
          }
        ]
      }
    })
    expect(adapter.requests[1].messages.at(-1)?.content.length).toBe(40_000)
  })

  it('applies the default 10,000-token projection with the repository CJK estimator', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Done.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const full = '界'.repeat(15_000)
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(() => ({ full }))])
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool] }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        attempts: [
          {
            tools: [
              {
                result: { full },
                projectionLimit: 10_000,
                projectedTokens: 10_000,
                truncated: true
              }
            ]
          }
        ]
      }
    })
    if (!result.ok) throw new Error(result.failure.message)
    expect(result.evidence.attempts[0].tools[0].projectedContent?.length).toBeLessThan(10_020)
  })

  it('suppresses repeated calls and discards the unsuccessful transaction', async () => {
    const repeated = {
      events: [
        {
          type: 'tool-call-delta' as const,
          index: 0,
          name: 'lookup',
          argumentsDelta: '{"id":1}'
        },
        { type: 'finish' as const, reason: 'tool-calls' as const }
      ]
    }
    const adapter = createScriptedProviderAdapter([repeated, repeated])
    const execute = vi.fn((_input, context) => {
      context.stage({ type: 'set', payload: { id: 1 } })
      return { ok: true }
    })
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(execute)])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'REPEATED_TOOL_CALL' },
      stagedOperations: [],
      evidence: {
        attempts: [
          {
            discardedOperations: 1,
            tools: [{ result: { ok: true } }, { suppressed: true }]
          }
        ]
      }
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('cuts off retry after a non-transactional external effect begins', async () => {
    const externalTool = {
      ...lookupTool,
      transactionMode: 'non-transactional'
    } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: '{"wrong":true}' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          (_input, context) => {
            context.beginExternalEffect()
            return { sent: true }
          },
          { transactionMode: 'non-transactional' }
        )
      ])
    })

    const result = await harness.execute({
      definition: definition({
        result: {
          mode: 'json',
          schema: {
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'integer' } }
          }
        },
        tools: [externalTool],
        defaults: { maxRetryAttempts: 2, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'INVALID_JSON_RESULT', retryable: false },
      evidence: { attempts: [{ irreversibleBoundary: true }] }
    })
    expect(adapter.requests).toHaveLength(2)
  })

  it('attributes context-budget failure without dispatching or retrying', async () => {
    const adapter = createScriptedProviderAdapter([])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry(),
      contextWindowTokensForTest: 1
    })

    const result = await harness.execute({
      definition: definition(),
      input: { large: 'x'.repeat(100) },
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'CONTEXT_BUDGET',
        retryable: false,
        contextBudget: {
          limit: 1,
          total: expect.any(Number),
          regions: expect.arrayContaining([
            expect.objectContaining({ region: 'harness-policy' }),
            expect.objectContaining({ region: 'attempt-log:0' })
          ])
        }
      }
    })
    expect(adapter.requests).toHaveLength(0)
  })

  it('budgets CJK, message and tool overhead, and requested output before dispatch', async () => {
    const adapter = createScriptedProviderAdapter([])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(() => ({ ok: true }))]),
      contextWindowTokensForTest: 250
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool] }),
      input: { text: '界'.repeat(120) },
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'CONTEXT_BUDGET',
        contextBudget: {
          regions: expect.arrayContaining([
            { region: 'output-reserve', tokens: 100 },
            expect.objectContaining({ region: 'message-overhead' }),
            expect.objectContaining({ region: 'tool-name:lookup' }),
            expect.objectContaining({ region: 'tool-description:lookup' }),
            expect.objectContaining({ region: 'tool-schema:lookup' })
          ])
        }
      }
    })
    expect(adapter.requests).toHaveLength(0)
  })

  it('waits for every parallel tool to settle before rolling back a sibling failure', async () => {
    const secondTool = { ...lookupTool, name: 'lookup-second', parallelSafe: true }
    const firstTool = { ...lookupTool, parallelSafe: true }
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            name: 'lookup-second',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    let releaseSibling!: () => void
    const siblingCanFinish = new Promise<void>((resolve) => {
      releaseSibling = resolve
    })
    let siblingSettled = false
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          async () => {
            throw new Error('first failed')
          },
          { parallelSafe: true }
        ),
        {
          ...toolBinding(
            async (_input, context) => {
              await siblingCanFinish
              context.stage({ type: 'late', payload: { id: 2 } })
              siblingSettled = true
              return { ok: true }
            },
            { parallelSafe: true }
          ),
          name: 'lookup-second'
        }
      ])
    })

    let executionSettled = false
    const execution = harness
      .execute({
        definition: definition({
          tools: [firstTool, secondTool],
          defaults: { maxRetryAttempts: 0, retryDelayMs: 0 }
        }),
        input: {},
        profileId: 'test-profile'
      })
      .finally(() => {
        executionSettled = true
      })

    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    await Promise.resolve()
    expect(executionSettled).toBe(false)
    releaseSibling()

    await expect(execution).resolves.toMatchObject({
      ok: false,
      failure: { code: 'TOOL_EXECUTION_FAILED' },
      stagedOperations: [],
      evidence: { attempts: [{ discardedOperations: 1 }] }
    })
    expect(siblingSettled).toBe(true)
  })

  it('settles parallel siblings and cuts off retry after one begins an external effect', async () => {
    const externalTool = {
      ...lookupTool,
      name: 'lookup-external',
      transactionMode: 'non-transactional',
      parallelSafe: true
    } as const
    const failingTool = { ...lookupTool, parallelSafe: true }
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          {
            type: 'tool-call-delta',
            index: 1,
            name: 'lookup-external',
            argumentsDelta: '{"id":2}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    let externalEffectBegan!: () => void
    const boundary = new Promise<void>((resolve) => {
      externalEffectBegan = resolve
    })
    let externalSiblingSettled = false
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(
          async () => {
            await boundary
            throw new Error('parallel sibling failed')
          },
          { parallelSafe: true }
        ),
        {
          ...toolBinding(
            async (_input, context) => {
              context.beginExternalEffect()
              externalEffectBegan()
              await new Promise<void>((_resolve, reject) => {
                context.signal?.addEventListener(
                  'abort',
                  () => reject(new Error('external sibling aborted')),
                  { once: true }
                )
              }).finally(() => {
                externalSiblingSettled = true
              })
              return { sent: true }
            },
            { transactionMode: 'non-transactional', parallelSafe: true }
          ),
          name: 'lookup-external'
        }
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [failingTool, externalTool],
        defaults: { maxRetryAttempts: 2, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'TOOL_EXECUTION_FAILED', retryable: false },
      evidence: { attempts: [{ outcome: 'failure', irreversibleBoundary: true }] }
    })
    expect(externalSiblingSettled).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('retries a non-transactional tool when setup fails before its external effect begins', async () => {
    const externalTool = { ...lookupTool, transactionMode: 'non-transactional' } as const
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      },
      {
        events: [
          { type: 'text-delta', delta: 'Sent after setup recovered.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const execute = vi
      .fn<ToolBinding['execute']>()
      .mockImplementationOnce(() => {
        throw new Error('setup failed before external send')
      })
      .mockImplementationOnce((_input, context) => {
        context.beginExternalEffect()
        return { sent: true }
      })
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding(execute, { transactionMode: 'non-transactional' })
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [externalTool],
        defaults: { maxRetryAttempts: 2, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      result: 'Sent after setup recovered.',
      evidence: {
        attempts: [
          {
            outcome: 'retry',
            error: { code: 'TOOL_EXECUTION_FAILED', retryable: true },
            irreversibleBoundary: false
          },
          { outcome: 'success' }
        ]
      }
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(adapter.requests).toHaveLength(3)
  })

  it('attributes individual Tool Result Projections when the next step exceeds budget', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((_input, context) => {
          context.stage({ type: 'set', payload: { id: 1 } })
          return { large: 'x'.repeat(500) }
        })
      ]),
      estimateTokens: (content) => content.length,
      contextWindowTokensForTest: 500
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool], defaults: { retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'CONTEXT_BUDGET',
        contextBudget: {
          regions: expect.arrayContaining([
            expect.objectContaining({ region: expect.stringMatching(/^tool-result:/) })
          ])
        }
      },
      stagedOperations: []
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails Tool Binding availability and compatibility preflight before dispatch', async () => {
    const adapter = createScriptedProviderAdapter([])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([toolBinding(() => ({ ok: true }), { parallelSafe: true })])
    })

    const result = await harness.execute({
      definition: definition({ tools: [lookupTool], defaults: { retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'TOOL_UNAVAILABLE', retryable: false }
    })
    expect(adapter.requests).toHaveLength(0)
  })

  it('terminates at maxSteps and rolls back staged operations', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((_input, context) => {
          context.stage({ type: 'set', payload: { id: 1 } })
          return { ok: true }
        })
      ])
    })

    const result = await harness.execute({
      definition: definition({
        tools: [lookupTool],
        defaults: { maxSteps: 1, maxRetryAttempts: 0, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'MAX_STEPS', retryable: false },
      stagedOperations: [],
      evidence: { attempts: [{ discardedOperations: 1 }] }
    })
  })

  it('cancels active work and discards staged operations without retry', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'tool-call-delta',
            index: 0,
            name: 'lookup',
            argumentsDelta: '{"id":1}'
          },
          { type: 'finish', reason: 'tool-calls' }
        ]
      }
    ])
    const controller = new AbortController()
    let toolStarted!: () => void
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve
    })
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry([
        toolBinding((_input, context) => {
          context.stage({ type: 'set', payload: { id: 1 } })
          toolStarted()
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          })
        })
      ])
    })
    const execution = harness.execute({
      definition: definition({
        tools: [lookupTool],
        defaults: { maxRetryAttempts: 2, retryDelayMs: 0 }
      }),
      input: {},
      profileId: 'test-profile',
      signal: controller.signal
    })

    await started
    controller.abort()

    await expect(execution).resolves.toMatchObject({
      ok: false,
      failure: { code: 'CANCELLED', retryable: false },
      stagedOperations: [],
      evidence: {
        attempts: [{ outcome: 'cancelled', discardedOperations: 1 }]
      }
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('reports provider cancellation before the first delta as Agent cancellation', async () => {
    const controller = new AbortController()
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const adapter: ProviderAdapter = {
      dispatch: async (request) =>
        await new Promise<void>((_resolve, reject) => {
          requestStarted()
          request.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new ProviderDispatchError('Provider request cancelled', {
                  retryClass: 'cancelled'
                })
              ),
            { once: true }
          )
        })
    }
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })
    const execution = harness.execute({
      definition: definition({ defaults: { maxRetryAttempts: 2, retryDelayMs: 0 } }),
      input: {},
      profileId: 'test-profile',
      signal: controller.signal
    })

    await started
    controller.abort()

    await expect(execution).resolves.toMatchObject({
      ok: false,
      failure: { code: 'CANCELLED', retryable: false },
      stagedOperations: [],
      evidence: { attempts: [{ outcome: 'cancelled', providerCalls: 1 }] }
    })
  })

  it('cancels during retry delay without starting another attempt', async () => {
    vi.useFakeTimers()
    const adapter = createScriptedProviderAdapter([
      {
        error: new ProviderDispatchError('temporary', { retryClass: 'transient' })
      }
    ])
    const controller = new AbortController()
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })
    const execution = harness.execute({
      definition: definition({ defaults: { maxRetryAttempts: 2, retryDelayMs: 500 } }),
      input: {},
      profileId: 'test-profile',
      signal: controller.signal
    })

    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    controller.abort()
    await vi.runAllTimersAsync()

    await expect(execution).resolves.toMatchObject({
      ok: false,
      failure: { code: 'CANCELLED', retryable: false },
      stagedOperations: [],
      evidence: { attempts: [{ outcome: 'retry' }] }
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('excludes raw provider reasoning from run evidence', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'reasoning-delta', delta: 'private-chain' },
          { type: 'text-delta', delta: 'Visible.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition(),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({ ok: true, result: 'Visible.' })
    expect(JSON.stringify(result)).not.toContain('private-chain')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('records normalized cache and latency metrics without reasoning or secrets', async () => {
    const adapter = createScriptedProviderAdapter([
      {
        events: [
          { type: 'reasoning-delta', delta: 'private-chain-secret' },
          { type: 'text-delta', delta: 'Visible.' },
          {
            type: 'usage',
            usage: { inputTokens: 20, outputTokens: 5 },
            cache: { readTokens: 12, writeTokens: 3 },
            raw: { secret: 'raw-secret' }
          },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const harness = createAgentHarness({
      providerDispatch: dispatchFor(adapter),
      toolRegistry: createToolRegistry()
    })

    const result = await harness.execute({
      definition: definition(),
      input: {},
      profileId: 'test-profile'
    })

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        attempts: [
          {
            cache: [{ readTokens: 12, writeTokens: 3 }],
            latencyMs: [expect.any(Number)]
          }
        ]
      }
    })
    expect(JSON.stringify(result)).not.toContain('private-chain-secret')
    expect(JSON.stringify(result)).not.toContain('raw-secret')
    if (!result.ok) throw new Error(result.failure.message)
    expect(result.evidence.attempts[0].latencyMs[0]).toBeGreaterThanOrEqual(0)
  })
})
