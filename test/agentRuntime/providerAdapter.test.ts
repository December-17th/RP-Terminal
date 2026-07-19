import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderDispatchError,
  createProviderDispatch,
  createScriptedProviderAdapter,
  type ProviderCallRequest,
  type ProviderConnection,
  type ProviderDispatch,
  type ProviderEvent
} from '../../src/main/services/agentRuntime/provider'
import { streamProvider } from '../../src/main/services/apiService'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'
import { SCRIPTED_FRAGMENTED_TOOL_CALL, SCRIPTED_TEXT } from './fixtures/providerEvents'

const connection = (
  provider: string,
  overrides: Partial<ProviderConnection> = {}
): ProviderConnection => ({
  provider,
  endpoint: `https://${provider}.provider.test/v1`,
  apiKey: 'secret',
  model: `${provider}-model`,
  rpmLimit: 0,
  maxConcurrent: 0,
  cacheMode: 'baseline',
  ...overrides
})

const settingsForConnection = (value: ProviderConnection): Settings =>
  ({
    api: {
      provider: value.provider,
      endpoint: value.endpoint,
      api_key: value.apiKey,
      model: value.model,
      rpm_limit: value.rpmLimit,
      max_concurrent: value.maxConcurrent
    },
    api_presets: [
      {
        id: `${value.provider}-preset`,
        name: `${value.provider} preset`,
        provider: value.provider,
        endpoint: value.endpoint,
        api_key: value.apiKey,
        model: value.model,
        rpm_limit: value.rpmLimit,
        max_concurrent: value.maxConcurrent
      }
    ],
    active_api_preset_id: `${value.provider}-preset`,
    cache: { mode: value.cacheMode ?? 'baseline' }
  }) as Settings

const testDispatch = (
  options: Parameters<typeof createProviderDispatch>[0] = {},
  connections: Record<string, ProviderConnection> = {}
): ProviderDispatch =>
  createProviderDispatch({
    ...options,
    getSettings: (profileId) =>
      settingsForConnection(connections[profileId] ?? connection(profileId)),
    getActivePreset: () => ({ parameters: {} }) as Preset
  })

const request = (overrides: Partial<ProviderCallRequest> = {}): ProviderCallRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides
})

const invoke = (
  dispatch: ProviderDispatch,
  provider: string,
  overrides: Partial<ProviderCallRequest> = {}
) => dispatch.resolve({ profileId: provider }).dispatch(request(overrides))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProviderDispatch', () => {
  it('defers resolver lookup until selection resolution', () => {
    const settings = settingsForConnection(connection('openai'))
    const generationPreset = {
      parameters: { temperature: 0.35, max_tokens: 700 }
    } as Preset
    let resolutionStarted = false
    const options = {
      adapter: createScriptedProviderAdapter([]),
      get getSettings() {
        if (!resolutionStarted) throw new Error('settings resolver was read before resolve')
        return () => settings
      },
      get getActivePreset() {
        if (!resolutionStarted) throw new Error('preset resolver was read before resolve')
        return () => generationPreset
      }
    }

    const dispatch = createProviderDispatch(options)
    resolutionStarted = true
    const resolved = dispatch.resolve({ profileId: 'profile-1' })

    expect(resolved.preset.parameters).toEqual({ temperature: 0.35, max_tokens: 700 })
    expect(Object.isFrozen(resolved.preset)).toBe(true)
    expect(Object.isFrozen(resolved.preset.parameters)).toBe(true)
  })

  it('resolves and freezes the selected API preset and effective generation parameters', async () => {
    const apiPreset = {
      id: 'api-fast',
      name: 'Fast API',
      provider: 'openai',
      endpoint: 'https://frozen.provider.test/v1',
      api_key: 'do-not-record',
      model: 'base-model',
      rpm_limit: 12,
      max_concurrent: 3
    }
    const settings = {
      api: {
        provider: 'openai',
        endpoint: 'https://active.provider.test/v1',
        api_key: 'active-secret',
        model: 'active-model'
      },
      api_presets: [apiPreset],
      active_api_preset_id: apiPreset.id,
      generation: { max_context_tokens: 32_768 },
      cache: { mode: 'provider' }
    } as Settings
    const generationPreset = {
      parameters: {
        temperature: 0.8,
        max_tokens: 1200,
        top_p: 0.95
      }
    } as Preset
    const scripted = createScriptedProviderAdapter([SCRIPTED_TEXT])
    const dispatch = createProviderDispatch({
      adapter: scripted,
      getSettings: () => settings,
      getActivePreset: () => generationPreset
    })

    const resolved = dispatch.resolve({
      profileId: 'profile-1',
      apiPresetId: 'api-fast',
      model: 'invocation-model',
      generationParameters: { temperature: 0.2, min_p: 0.05 }
    })
    apiPreset.model = 'mutated-after-resolution'
    generationPreset.parameters.temperature = 1

    const result = await resolved.dispatch({
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(result.text).toBe('Done.')
    expect(resolved.preset).toEqual({
      id: 'api-fast',
      name: 'Fast API',
      provider: 'openai',
      endpoint: 'https://frozen.provider.test/v1',
      model: 'invocation-model',
      rpmLimit: 12,
      maxConcurrent: 3,
      cacheMode: 'provider',
      contextWindowTokens: 32_768,
      parameters: {
        temperature: 0.2,
        max_tokens: 1200,
        top_p: 0.95,
        min_p: 0.05
      }
    })
    expect(resolved.preset).not.toHaveProperty('apiKey')
    expect(JSON.stringify(resolved.preset)).not.toContain('do-not-record')
    expect(Object.isFrozen(resolved.preset)).toBe(true)
    expect(Object.isFrozen(resolved.preset.parameters)).toBe(true)
    expect(scripted.requests[0]).toMatchObject({
      connection: { apiKey: 'do-not-record', model: 'invocation-model' },
      parameters: { temperature: 0.2, max_tokens: 1200, top_p: 0.95, min_p: 0.05 }
    })
  })

  it.each([
    ['openai', 'openai-compatible', 'openai-compatible'],
    ['openrouter', 'openai-compatible', 'openai-compatible'],
    ['custom', 'openai-compatible', 'openai-compatible'],
    ['deepseek', 'openai-compatible', 'deepseek-compatible'],
    ['anthropic', 'anthropic', 'anthropic'],
    ['google', 'gemini', 'gemini'],
    ['gemini', 'gemini', 'gemini']
  ] as const)(
    'selects the transport and capability profile for %s',
    (provider, transport, profile) => {
      const dispatch = testDispatch()

      expect(dispatch.resolve({ profileId: provider }).capability).toMatchObject({
        transport,
        id: profile
      })
    }
  )

  it('assembles fragmented tool arguments in provider order and excludes reasoning from the result', async () => {
    const scripted = createScriptedProviderAdapter([SCRIPTED_FRAGMENTED_TOOL_CALL])
    const dispatch = testDispatch({ adapter: scripted })
    const events: ProviderEvent[] = []

    const result = await invoke(dispatch, 'openai', {
      onEvent: (event) => events.push(event)
    })

    expect(result).toMatchObject({
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        {
          id: 'call_weather',
          name: 'weather',
          argumentsText: '{"city":"Toronto"}',
          input: { city: 'Toronto' }
        },
        {
          id: 'call_time',
          name: 'time',
          argumentsText: '{"zone":"UTC"}',
          input: { zone: 'UTC' }
        }
      ]
    })
    expect(result).not.toHaveProperty('reasoning')
    expect(events).toContainEqual({
      type: 'reasoning',
      delta: 'private chain',
      volatile: true
    })
    expect(events.filter((event) => event.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCall: expect.objectContaining({ id: 'call_weather', name: 'weather' })
      },
      {
        type: 'tool-call',
        toolCall: expect.objectContaining({ id: 'call_time', name: 'time' })
      }
    ])
  })

  it('normalizes tool schemas according to the selected capability profile', async () => {
    const scripted = createScriptedProviderAdapter([
      { events: [{ type: 'finish', reason: 'stop' }] },
      { events: [{ type: 'finish', reason: 'stop' }] }
    ])
    const dispatch = testDispatch({ adapter: scripted })
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { const: 'safe' },
        count: { type: 'integer' }
      }
    }

    await invoke(dispatch, 'gemini', {
      tools: [{ name: 'configure', description: 'Configure it.', inputSchema: schema }]
    })
    await invoke(dispatch, 'anthropic', {
      tools: [{ name: 'configure', description: 'Configure it.', inputSchema: schema }]
    })

    expect(scripted.requests[0].tools[0].inputSchema).toEqual({
      type: 'object',
      properties: {
        mode: { enum: ['safe'] },
        count: { type: 'integer' }
      }
    })
    expect(scripted.requests[1].tools[0].inputSchema).toEqual(schema)
    expect(Object.isFrozen(scripted.requests[0].connection)).toBe(true)
    expect(Object.isFrozen(scripted.requests[0].parameters)).toBe(true)
  })

  it('emits normalized usage, cache, rate-limit, and completion events', async () => {
    const scripted = createScriptedProviderAdapter([
      {
        events: [
          { type: 'text-delta', delta: 'Done.' },
          {
            type: 'usage',
            usage: { inputTokens: 20, outputTokens: 5 },
            cache: { readTokens: 12, writeTokens: 3 },
            raw: { provider: 'shape' }
          },
          {
            type: 'rate-limit',
            rateLimit: {
              requestsLimit: 100,
              requestsRemaining: 42,
              resetAfterMs: 1500
            }
          },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const dispatch = testDispatch({ adapter: scripted })
    const events: ProviderEvent[] = []

    const result = await invoke(dispatch, 'anthropic', {
      onEvent: (event) => events.push(event)
    })

    expect(result).toMatchObject({
      text: 'Done.',
      usage: { inputTokens: 20, outputTokens: 5 },
      cache: { readTokens: 12, writeTokens: 3 },
      rateLimit: { requestsLimit: 100, requestsRemaining: 42, resetAfterMs: 1500 },
      finishReason: 'stop'
    })
    expect(events.map((event) => event.type)).toEqual([
      'text',
      'usage',
      'cache',
      'rate-limit',
      'completion'
    ])
  })

  it('exposes retry class and Retry-After on provider errors', async () => {
    const scripted = createScriptedProviderAdapter([
      {
        error: new ProviderDispatchError('busy', {
          retryClass: 'rate-limit',
          status: 429,
          retryAfterMs: 2500
        })
      }
    ])
    const dispatch = testDispatch({ adapter: scripted })

    await expect(invoke(dispatch, 'openai')).rejects.toMatchObject({
      name: 'ProviderDispatchError',
      retryClass: 'rate-limit',
      status: 429,
      retryAfterMs: 2500
    })
  })

  it('normalizes OpenAI-compatible streamed reasoning, fragmented tools, usage, and completion', async () => {
    const frames = [
      {
        choices: [
          {
            delta: {
              reasoning_content: 'hidden',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'lookup', arguments: '{"id":' }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '7}' } }] },
            finish_reason: 'tool_calls'
          }
        ]
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 20 }
        }
      }
    ]
    const providerFetch = vi.fn(async () => {
      const body = [
        ...frames.map((frame) => `data: ${JSON.stringify(frame)}`),
        'data: [DONE]',
        ''
      ].join('\n')
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const dispatch = testDispatch({ fetch: providerFetch as typeof fetch })
    const events: ProviderEvent[] = []

    const result = await invoke(dispatch, 'openrouter', {
      onEvent: (event) => events.push(event)
    })

    expect(result).toMatchObject({
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'lookup',
          argumentsText: '{"id":7}',
          input: { id: 7 }
        }
      ],
      usage: { inputTokens: 10, outputTokens: 4 },
      cache: { readTokens: 20, writeTokens: 0 },
      finishReason: 'tool-calls'
    })
    expect(events).toContainEqual({ type: 'reasoning', delta: 'hidden', volatile: true })
  })

  it('normalizes Anthropic streamed tool JSON and split usage accounting', async () => {
    const frames = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 8,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 5
          }
        }
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"id":' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '9}' }
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 6 }
      }
    ]
    const providerFetch = vi.fn(async () => {
      const body = [...frames.map((frame) => `data: ${JSON.stringify(frame)}`), ''].join('\n')
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const dispatch = testDispatch({ fetch: providerFetch as typeof fetch })

    const result = await invoke(dispatch, 'anthropic')

    expect(result).toMatchObject({
      toolCalls: [
        {
          id: 'toolu_1',
          name: 'lookup',
          argumentsText: '{"id":9}',
          input: { id: 9 }
        }
      ],
      usage: { inputTokens: 8, outputTokens: 6 },
      cache: { readTokens: 40, writeTokens: 5 },
      finishReason: 'tool-calls'
    })
  })

  it('preserves explicit empty Anthropic tool arguments without input deltas', async () => {
    const frames = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_empty', name: 'lookup', input: {} }
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' }
      }
    ]
    const dispatch = testDispatch({
      fetch: vi.fn(async () => {
        return new Response(
          [...frames.map((frame) => `data: ${JSON.stringify(frame)}`), ''].join('\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      }) as typeof fetch
    })

    const result = await invoke(dispatch, 'anthropic')

    expect(result.toolCalls).toEqual([
      {
        id: 'toolu_empty',
        name: 'lookup',
        argumentsText: '{}',
        input: {}
      }
    ])
  })

  it('normalizes Gemini thought parts, function calls, cache usage, and completion', async () => {
    const frame = {
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              { thought: true, text: 'hidden' },
              { functionCall: { name: 'lookup', args: { id: 11 } } }
            ]
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata: {
        promptTokenCount: 50,
        candidatesTokenCount: 7,
        cachedContentTokenCount: 30
      }
    }
    const providerFetch = vi.fn(async () => {
      return new Response(`data: ${JSON.stringify(frame)}\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const dispatch = testDispatch({ fetch: providerFetch as typeof fetch })
    const events: ProviderEvent[] = []

    const result = await invoke(dispatch, 'google', {
      onEvent: (event) => events.push(event)
    })

    expect(result).toMatchObject({
      toolCalls: [
        {
          id: 'gemini:0:1',
          name: 'lookup',
          argumentsText: '{"id":11}',
          input: { id: 11 }
        }
      ],
      usage: { inputTokens: 20, outputTokens: 7 },
      cache: { readTokens: 30, writeTokens: 0 },
      finishReason: 'stop'
    })
    expect(events).toContainEqual({ type: 'reasoning', delta: 'hidden', volatile: true })
  })

  it('classifies HTTP rate limits and parses Retry-After from production responses', async () => {
    const dispatch = testDispatch({
      fetch: vi.fn(async () => {
        return new Response('slow down', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '2.5' }
        })
      }) as typeof fetch
    })

    await expect(invoke(dispatch, 'anthropic')).rejects.toMatchObject({
      retryClass: 'rate-limit',
      status: 429,
      retryAfterMs: 2500
    })
  })

  it.each([
    ['openai', 'API'],
    ['anthropic', 'Anthropic API'],
    ['gemini', 'Gemini API']
  ])(
    'preserves bounded legacy HTTP error details for ordinary %s generation',
    async (provider, label) => {
      const responseBody = `provider detail: ${'x'.repeat(900)}NEVER_INCLUDE_MARKER`
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return new Response(responseBody, {
            status: 422,
            statusText: 'Unprocessable Content'
          })
        })
      )
      const settings = {
        api: {
          provider,
          endpoint: 'https://legacy.provider.test/v1',
          api_key: 'secret',
          model: 'ordinary-model'
        },
        cache: { mode: 'baseline' }
      } as Settings

      const error = await streamProvider(
        settings,
        [{ role: 'user', content: 'hello' }],
        {},
        () => {}
      ).catch((cause) => cause)

      expect(error).toEqual(
        new Error(`${label} Error: 422 Unprocessable Content - ${responseBody.slice(0, 800)}`)
      )
      expect(error.message).not.toContain('NEVER_INCLUDE_MARKER')
    }
  )

  it('reports only sanitized frame diagnostics when an OpenAI stream has no model events', async () => {
    const rawFrameSecret = 'private-chain-from-provider'
    const dispatch = testDispatch({
      fetch: vi.fn(async () => {
        return new Response(`data: ${JSON.stringify({ internal_reasoning: rawFrameSecret })}\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      }) as typeof fetch
    })

    const error = await invoke(dispatch, 'openai').catch((cause) => cause)

    expect(error).toMatchObject({
      name: 'ProviderDispatchError',
      diagnostics: {
        category: 'empty-stream',
        frameCount: 1,
        parsedFrameCount: 1
      }
    })
    expect(JSON.stringify(error)).not.toContain(rawFrameSecret)
    expect(error.message).not.toContain(rawFrameSecret)
    expect(error.message).not.toContain('Raw frames')
  })

  it.each([
    [
      'openai',
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_unsolicited',
                  function: { name: 'lookup', arguments: '{}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      'Stream produced no text'
    ],
    [
      'gemini',
      {
        candidates: [
          {
            index: 0,
            content: {
              parts: [{ functionCall: { name: 'lookup', args: {} } }]
            },
            finishReason: 'STOP'
          }
        ]
      },
      'Gemini stream produced no text'
    ]
  ])(
    'rejects unsolicited %s tool-only output through the ordinary generation seam',
    async (provider, frame, expectedMessage) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return new Response(`data: ${JSON.stringify(frame)}\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
        })
      )
      const settings = {
        api: {
          provider,
          endpoint: 'https://legacy.provider.test/v1',
          api_key: 'secret',
          model: 'ordinary-model'
        },
        cache: { mode: 'baseline' }
      } as Settings

      await expect(
        streamProvider(settings, [{ role: 'user', content: 'hello' }], {}, () => {})
      ).rejects.toEqual(new Error(expectedMessage))
    }
  )

  it.each([
    ['openai', { choices: [{ delta: {}, finish_reason: 'stop' }] }, 'Stream produced no text'],
    [
      'gemini',
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
      'Gemini stream produced no text'
    ]
  ])('preserves the ordinary %s empty-stream error', async (provider, frame, expectedMessage) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(`data: ${JSON.stringify(frame)}\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      })
    )
    const settings = {
      api: {
        provider,
        endpoint: 'https://legacy.provider.test/v1',
        api_key: 'secret',
        model: 'ordinary-model'
      },
      cache: { mode: 'baseline' }
    } as Settings

    await expect(
      streamProvider(settings, [{ role: 'user', content: 'hello' }], {}, () => {})
    ).rejects.toEqual(new Error(expectedMessage))
  })

  it('keeps the legacy wrapper byte-compatible by explicitly presenting reasoning as a think block', async () => {
    const frames = [
      {
        choices: [
          {
            delta: { reasoning_content: 'consider this' }
          }
        ]
      },
      {
        choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }]
      },
      {
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2 }
      }
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = [
          ...frames.map((frame) => `data: ${JSON.stringify(frame)}`),
          'data: [DONE]',
          ''
        ].join('\n')
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      })
    )
    const deltas: string[] = []
    const rawUsage: unknown[] = []
    const settings = {
      api: {
        provider: 'openai',
        endpoint: 'https://legacy.provider.test/v1',
        api_key: 'secret',
        model: 'reasoning-model'
      },
      cache: { mode: 'baseline' }
    } as Settings

    const result = await streamProvider(
      settings,
      [{ role: 'user', content: 'hello' }],
      {},
      (delta) => deltas.push(delta),
      undefined,
      (usage) => rawUsage.push(usage)
    )

    expect(result).toBe('<think>consider this</think>\n\nAnswer.')
    expect(deltas.join('')).toBe(result)
    expect(rawUsage).toEqual([{ prompt_tokens: 3, completion_tokens: 2 }])
  })

  it('keeps legacy non-streaming reasoning-only output byte-compatible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { reasoning_content: 'consider this', content: '' },
                finish_reason: 'stop'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const deltas: string[] = []
    const settings = {
      api: {
        provider: 'openai',
        endpoint: 'https://legacy.provider.test/v1',
        api_key: 'secret',
        model: 'reasoning-model'
      },
      cache: { mode: 'baseline' }
    } as Settings

    const result = await streamProvider(
      settings,
      [{ role: 'user', content: 'hello' }],
      {},
      (delta) => deltas.push(delta)
    )

    expect(result).toBe('<think>consider this</think>\n\n')
    expect(deltas.join('')).toBe(result)
  })

  it('returns empty output when ordinary generation is aborted before its first delta', async () => {
    const controller = new AbortController()
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            requestStarted()
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            )
          })
      )
    )
    const settings = {
      api: {
        provider: 'openai',
        endpoint: 'https://legacy.provider.test/v1',
        api_key: 'secret',
        model: 'ordinary-model'
      },
      cache: { mode: 'baseline' }
    } as Settings

    const execution = streamProvider(
      settings,
      [{ role: 'user', content: 'hello' }],
      {},
      () => {},
      controller.signal
    )
    await started
    controller.abort()

    await expect(execution).resolves.toBe('')
  })

  it('returns partial output when ordinary generation is aborted after a delta', async () => {
    const controller = new AbortController()
    let deltaReceived!: () => void
    const received = new Promise<void>((resolve) => {
      deltaReceived = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial."}}]}\n')
            )
            controller.signal.addEventListener(
              'abort',
              () => stream.error(new DOMException('aborted', 'AbortError')),
              { once: true }
            )
          }
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      })
    )
    const settings = {
      api: {
        provider: 'openai',
        endpoint: 'https://legacy.provider.test/v1',
        api_key: 'secret',
        model: 'ordinary-model'
      },
      cache: { mode: 'baseline' }
    } as Settings

    const execution = streamProvider(
      settings,
      [{ role: 'user', content: 'hello' }],
      {},
      (delta) => {
        if (delta === 'Partial.') deltaReceived()
      },
      controller.signal
    )
    await received
    controller.abort()

    await expect(execution).resolves.toBe('Partial.')
  })

  it('shares endpoint-keyed concurrency with the ordinary generation compatibility wrapper', async () => {
    const endpoint = 'https://shared-limit.provider.test/v1'
    let releaseFirst!: () => void
    const firstBody = new Promise<string>((resolve) => {
      releaseFirst = () =>
        resolve(
          [
            'data: {"choices":[{"delta":{"content":"first"},"finish_reason":"stop"}]}',
            'data: [DONE]',
            ''
          ].join('\n')
        )
    })
    let fetchCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCount++
        const body =
          fetchCount === 1
            ? await firstBody
            : [
                'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}',
                'data: [DONE]',
                ''
              ].join('\n')
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      })
    )

    const dispatch = testDispatch(
      {},
      {
        openai: connection('openai', {
          endpoint,
          model: 'same-model',
          maxConcurrent: 1
        })
      }
    )
    const direct = invoke(dispatch, 'openai')
    await vi.waitFor(() => expect(fetchCount).toBe(1))

    const settings = {
      api: {
        provider: 'openai',
        endpoint,
        api_key: 'secret',
        model: 'same-model',
        max_concurrent: 1
      }
    } as Settings
    const legacy = streamProvider(settings, [{ role: 'user', content: 'hello' }], {}, () => {})
    await Promise.resolve()
    expect(fetchCount).toBe(1)

    releaseFirst()
    await expect(direct).resolves.toMatchObject({ text: 'first' })
    await expect(legacy).resolves.toBe('second')
    expect(fetchCount).toBe(2)
  })
})
