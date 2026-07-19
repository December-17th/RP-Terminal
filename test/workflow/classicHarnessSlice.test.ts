// Classic Narrator first execution plan — Milestone 1.
//
// Classic's ONE sampling call now executes through `AgentHarness.executePrepared`. The contract this
// file defends is that the seam is provider-invisible: the same ordered messages, the same shaped
// body bytes, the same streaming, the same abort/error classification — with and without a registered
// late dispatch transform — and that no OTHER runLlmCall consumer is routed through the Harness.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }))
vi.mock('../../src/main/services/generation/callModel', () => ({ callModel }))

import {
  createCompatibilityProviderDispatch,
  createScriptedProviderAdapter,
  ProviderDispatchError,
  type NormalizedProviderRequest,
  type ProviderCallRequest,
  type ProviderConnection,
  type ProviderMessage
} from '../../src/main/services/agentRuntime/provider'
import {
  buildOpenAiBody,
  buildAnthropicBody,
  buildGeminiBody
} from '../../src/main/services/agentRuntime/provider/shaping'
import {
  createAgentHarness,
  createToolRegistry,
  DEFAULT_HARNESS_POLICY
} from '../../src/main/services/agentRuntime/harness'
import { streamProvider, type ProviderDispatchVia } from '../../src/main/services/apiService'
import { harnessDispatchVia } from '../../src/main/services/generation/harnessDispatch'
import { llmSample, runLlmCall } from '../../src/main/services/nodes/builtin/generationNodes'
import { registerDispatchHook, clearDispatchHooks } from '../../src/main/services/nodes/dispatchHooks'
import type { DispatchTransform } from '../../src/main/services/nodes/promptArtifact'
import { RunContext } from '../../src/main/services/nodes/types'

const connection: ProviderConnection = {
  provider: 'openai',
  endpoint: 'https://provider.test/v1',
  apiKey: 'secret',
  model: 'fixed-model',
  rpmLimit: 0,
  maxConcurrent: 0
}

const params = { temperature: 0.7, max_tokens: 512 }

/** The kind of final, already-shaped, already-late-transformed array Classic hands to the seam. */
const finalMessages = (): ProviderMessage[] => [
  { role: 'system', content: 'You are Aria.' },
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' }
]

const textSteps = (chunks: string[]) => [
  {
    events: [
      ...chunks.map((delta) => ({ type: 'text-delta' as const, delta })),
      { type: 'finish' as const, reason: 'stop' as const }
    ]
  }
]

const dispatchWith = (
  steps: Parameters<typeof createScriptedProviderAdapter>[0],
  over: ProviderConnection = connection
) => {
  const adapter = createScriptedProviderAdapter(steps)
  const provider = createCompatibilityProviderDispatch(over, params, { adapter })
  return { adapter, provider }
}

const call = (
  messages: ProviderMessage[],
  onEvent?: ProviderCallRequest['onEvent'],
  signal?: AbortSignal
): ProviderCallRequest => ({ messages, ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) })

/** What each transport actually serializes for a captured request. */
const shapers: Record<string, (request: NormalizedProviderRequest) => string> = {
  openai: (request) => JSON.stringify(buildOpenAiBody(request)),
  anthropic: (request) => JSON.stringify(buildAnthropicBody(request)),
  gemini: (request) =>
    JSON.stringify(
      buildGeminiBody(request.messages, request.parameters, request.tools, request.toolChoice)
    )
}

describe('Classic Harness slice — provider-visible request is unchanged', () => {
  // The milestone rests on provider-visible BYTES, so every shaper is compared, not just OpenAI's.
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    it(`sends the same ordered messages and the same ${provider} body bytes as a direct dispatch`, async () => {
      const over: ProviderConnection = { ...connection, provider }
      const direct = dispatchWith(textSteps(['Hello.']), over)
      const viaHarness = dispatchWith(textSteps(['Hello.']), over)

      await direct.provider.dispatch(call(finalMessages()))
      await harnessDispatchVia(viaHarness.provider, call(finalMessages()))

      expect(viaHarness.adapter.requests).toHaveLength(1)
      expect(viaHarness.adapter.requests[0].messages).toEqual(direct.adapter.requests[0].messages)
      // Byte-level: `toolChoice: 'none'` and the empty tool list the Harness passes cannot reach
      // the wire, because every shaper gates tool fields behind a non-empty tool list.
      expect(shapers[provider](viaHarness.adapter.requests[0])).toBe(
        shapers[provider](direct.adapter.requests[0])
      )
    })
  }

  it('forwards the array verbatim — no policy message, no serialized input, no tools', async () => {
    const { adapter, provider } = dispatchWith(textSteps(['Hello.']))
    const messages = finalMessages()

    await harnessDispatchVia(provider, call(messages))

    const seen = adapter.requests[0]
    expect(seen.messages).toEqual(messages)
    expect(seen.messages).toHaveLength(4)
    expect(seen.messages[0]).toEqual({ role: 'system', content: 'You are Aria.' })
    expect(seen.messages.at(-1)).toEqual({ role: 'user', content: 'u2' })
    // The `execute` path would prepend DEFAULT_HARNESS_POLICY at index 0 and append
    // JSON.stringify(input) as a trailing user turn. Assert against those exact artifacts, so this
    // fails loudly if the prepared path ever grows either of them.
    expect(seen.messages.some((m) => m.content === DEFAULT_HARNESS_POLICY)).toBe(false)
    expect(seen.messages.map((m) => m.content)).toEqual([
      'You are Aria.',
      'u1',
      'a1',
      'u2'
    ])
    expect(seen.tools).toEqual([])
  })

  it('makes exactly one provider call and owns no retry of its own', async () => {
    const { adapter, provider } = dispatchWith(textSteps(['Hello.']))
    await harnessDispatchVia(provider, call(finalMessages()))
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('Classic Harness slice — streaming, cancellation, and error parity', () => {
  it('streams the same deltas in the same order and returns the same final text', async () => {
    const chunks = ['He', 'llo', ' there.']
    const direct = dispatchWith(textSteps(chunks))
    const viaHarness = dispatchWith(textSteps(chunks))

    const directDeltas: string[] = []
    const harnessDeltas: string[] = []
    const sink = (into: string[]): ProviderCallRequest['onEvent'] => (event) => {
      if (event.type === 'text') into.push(event.delta)
    }

    const directResult = await direct.provider.dispatch(
      call(finalMessages(), sink(directDeltas))
    )
    const result = await harnessDispatchVia(
      viaHarness.provider,
      call(finalMessages(), sink(harnessDeltas))
    )

    expect(harnessDeltas).toEqual(chunks)
    expect(harnessDeltas).toEqual(directDeltas)
    expect(result.text).toBe(directResult.text)
    expect(result.finishReason).toBe(directResult.finishReason)
  })

  it('propagates a provider error unchanged (distinct from cancellation)', async () => {
    const failure = new ProviderDispatchError('upstream exploded', { retryClass: 'transient' })
    const { provider } = dispatchWith([{ error: failure }])

    await expect(harnessDispatchVia(provider, call(finalMessages()))).rejects.toBe(failure)
  })

  it('classifies a REAL mid-stream abort as cancelled, keeping the partial text', async () => {
    // Drive the abort path for real: the adapter streams a chunk, the caller aborts, and the
    // adapter then throws the way a torn-down transport does. `finishReason: 'cancelled'` must come
    // from the abort classification in ProviderDispatch, not from a scripted finish event.
    const controller = new AbortController()
    const adapter = {
      requests: [] as NormalizedProviderRequest[],
      async dispatch(request: NormalizedProviderRequest, emit: (e: never) => void): Promise<void> {
        adapter.requests.push(request)
        ;(emit as (e: { type: 'text-delta'; delta: string }) => void)({
          type: 'text-delta',
          delta: 'partial'
        })
        controller.abort()
        throw new Error('socket torn down')
      }
    }
    const provider = createCompatibilityProviderDispatch(connection, params, {
      adapter: adapter as never
    })

    const deltas: string[] = []
    const result = await harnessDispatchVia(
      provider,
      call(
        finalMessages(),
        (event) => {
          if (event.type === 'text') deltas.push(event.delta)
        },
        controller.signal
      )
    )

    expect(controller.signal.aborted).toBe(true)
    expect(result.finishReason).toBe('cancelled')
    expect(result.text).toBe('partial')
    expect(deltas).toEqual(['partial'])
  })

  it('an abort BEFORE any output surfaces as a cancelled ProviderDispatchError, not a transient one', async () => {
    const controller = new AbortController()
    const adapter = {
      async dispatch(): Promise<void> {
        controller.abort()
        throw new Error('aborted before first byte')
      }
    }
    const provider = createCompatibilityProviderDispatch(connection, params, {
      adapter: adapter as never
    })

    await expect(
      harnessDispatchVia(provider, call(finalMessages(), undefined, controller.signal))
    ).rejects.toMatchObject({ retryClass: 'cancelled' })
  })

  it('uses the caller-resolved connection and binds no tool', async () => {
    const resolve = vi.fn(() => {
      throw new Error('the prepared path must never re-resolve a provider')
    })
    const registry = createToolRegistry()
    const resolveTool = vi.spyOn(registry, 'resolve')
    const harness = createAgentHarness({
      providerDispatch: { resolve } as never,
      toolRegistry: registry
    })
    const { adapter, provider } = dispatchWith(textSteps(['Hi.']))

    const result = await harness.executePrepared({ provider, messages: finalMessages() })

    expect(result.text).toBe('Hi.')
    // Neither settings-derived provider selection nor tool binding is reachable from this path.
    expect(resolve).not.toHaveBeenCalled()
    expect(resolveTool).not.toHaveBeenCalled()
    expect(adapter.requests[0].connection.model).toBe(connection.model)
    expect(adapter.requests[0].connection.endpoint).toBe(connection.endpoint)
    expect(adapter.requests[0].tools).toEqual([])
  })
})

describe('Classic Harness slice — streamProvider honors the injected executor', () => {
  // Closes the callModel -> streamProvider hop that argument-identity assertions cannot reach:
  // this drives the REAL streamProvider and proves the executor actually performs the call.
  const settings = {
    api: {
      provider: connection.provider,
      endpoint: connection.endpoint,
      api_key: connection.apiKey,
      model: connection.model,
      rpm_limit: 0,
      max_concurrent: 0
    },
    cache: { mode: 'baseline' }
  } as never

  it('routes the call through dispatchVia and returns its text', async () => {
    const seen: ProviderCallRequest[] = []
    const deltas: string[] = []
    // A real adapter is unreachable here (streamProvider builds its own dispatch), so the executor
    // substitutes a scripted provider — proving streamProvider defers the call to it entirely.
    const scripted = dispatchWith(textSteps(['Hel', 'lo.']))
    const viaScripted: ProviderDispatchVia = (_provider, request) => {
      seen.push(request)
      return harnessDispatchVia(scripted.provider, request)
    }

    const text = await streamProvider(
      settings,
      finalMessages(),
      params as never,
      (d) => deltas.push(d),
      undefined,
      undefined,
      viaScripted
    )

    expect(text).toBe('Hello.')
    expect(deltas).toEqual(['Hel', 'lo.'])
    expect(seen).toHaveLength(1)
    // streamProvider handed the executor its own final message array, unmodified.
    expect(seen[0].messages).toEqual(finalMessages())
    expect(scripted.adapter.requests[0].messages).toEqual(finalMessages())
  })

  it('performs the call directly when no executor is injected', async () => {
    const scripted = dispatchWith(textSteps(['direct']))
    let executorCalls = 0
    const counting: ProviderDispatchVia = (_provider, request) => {
      executorCalls++
      return harnessDispatchVia(scripted.provider, request)
    }

    // With the executor: the scripted adapter sees the call.
    await streamProvider(
      settings,
      finalMessages(),
      params as never,
      () => {},
      undefined,
      undefined,
      counting
    )
    expect(executorCalls).toBe(1)
    expect(scripted.adapter.requests).toHaveLength(1)

    // Without it, streamProvider must NOT consult the executor at all.
    const untouched = dispatchWith(textSteps(['unused']))
    await expect(
      streamProvider(settings, finalMessages(), params as never, () => {}, undefined, undefined)
    ).rejects.toBeDefined() // real transport, no network in tests
    expect(untouched.adapter.requests).toHaveLength(0)
    expect(executorCalls).toBe(1)
  })
})

const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

describe('Classic Harness slice — opt-in wiring', () => {
  beforeEach(() => {
    callModel.mockReset().mockResolvedValue({ raw: 'ok', rawUsage: null, stopped: false })
  })
  afterEach(() => {
    clearDispatchHooks('chat-1')
  })

  const runSample = async (): Promise<void> => {
    await llmSample.run(
      ctx(),
      { gen: { chatId: 'chat-1', settings: {} }, sendMessages: finalMessages(), params },
      { id: 'n1', config: {} }
    )
  }

  it('routes llm.sample through the Harness executor with the post-transform array', async () => {
    await runSample()
    expect(callModel).toHaveBeenCalledTimes(1)
    expect(callModel.mock.calls[0][1]).toEqual(finalMessages())
    expect(callModel.mock.calls[0][5]).toBe(harnessDispatchVia)
  })

  it('keeps the same routing and ordering when a late dispatch transform is registered', async () => {
    const hook: DispatchTransform = {
      scriptId: 'th-1',
      hook: 'CHAT_COMPLETION_PROMPT_READY',
      apply: (m) => [...m, { role: 'system', content: 'INJECTED' }]
    }
    registerDispatchHook('chat-1', hook)

    await runSample()

    const sent = callModel.mock.calls[0][1]
    // The transform's output — in its exact position — is what reaches the seam.
    expect(sent).toEqual([...finalMessages(), { role: 'system', content: 'INJECTED' }])
    expect(callModel.mock.calls[0][5]).toBe(harnessDispatchVia)
  })

  it('leaves every other runLlmCall consumer on the direct provider call', async () => {
    // agent.llm, memory, notes, and recall all call runLlmCall WITHOUT an executor.
    await runLlmCall(ctx(), { settings: {} } as never, finalMessages(), params as never, {})
    expect(callModel.mock.calls[0][5]).toBeUndefined()
  })
})
