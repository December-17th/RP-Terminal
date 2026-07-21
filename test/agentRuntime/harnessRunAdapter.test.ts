import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import {
  ProviderDispatchError,
  createProviderDispatch,
  createScriptedProviderAdapter,
  type NormalizedProviderRequest,
  type ProviderAdapter,
  type ProviderAdapterEvent
} from '../../src/main/services/agentRuntime/provider'
import { createToolRegistry } from '../../src/main/services/agentRuntime/harness'
import {
  createAgentRunStore,
  createHarnessRunAdapter
} from '../../src/main/services/agentRuntime/runs'
import { parseAgentDefinition, type AgentRunEvent } from '../../src/shared/agentRuntime'

const definition = (() => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Observed Agent',
    prompt: [{ role: 'system', content: 'Return a short answer.' }],
    inputSchema: { type: 'object' },
    result: { mode: 'text' },
    tools: [],
    defaults: { maxRetryAttempts: 0, retryDelayMs: 0, notification: 'none' }
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
})()

const settings = {
  api: {
    provider: 'openai',
    endpoint: 'https://provider.test/v1',
    api_key: 'secret',
    model: 'fixed-model'
  },
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
} as Settings

const providerDispatch = (adapter: ProviderAdapter) =>
  createProviderDispatch({
    adapter,
    getSettings: () => settings,
    getActivePreset: () => ({ parameters: { temperature: 0 } }) as Preset
  })

interface ControlledCall {
  request: NormalizedProviderRequest
  succeed(text: string): void
}

const controlledAdapter = (): ProviderAdapter & { calls: ControlledCall[] } => {
  const calls: ControlledCall[] = []
  return {
    calls,
    dispatch(request, emit) {
      return new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          reject(
            new ProviderDispatchError('Provider request cancelled', {
              retryClass: 'cancelled'
            })
          )
        }
        if (request.signal?.aborted) {
          abort()
          return
        }
        request.signal?.addEventListener('abort', abort, { once: true })
        calls.push({
          request,
          succeed(text) {
            request.signal?.removeEventListener('abort', abort)
            emit({ type: 'text-delta', delta: text })
            emit({ type: 'finish', reason: 'stop' })
            resolve()
          }
        })
      })
    }
  }
}

describe('HarnessRunAdapter', () => {
  let db: InstanceType<typeof Adapter>
  let runStore: ReturnType<typeof createAgentRunStore>
  let events: AgentRunEvent[]

  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    runStore = createAgentRunStore({
      getDb: () => db,
      now: () => '2026-07-18T12:00:00.000Z'
    })
    events = []
    runStore.subscribe((event) => events.push(event))
  })

  const request = (invocationId: string) => ({
    invocationId,
    profileId: 'profile-1',
    chatId: 'chat-1',
    floor: 7,
    agent: {
      definition,
      version: 'catalog-v3',
      hash: 'sha256:catalog-v3'
    },
    input: { request: invocationId },
    history: [{ floor: 6, response: 'Earlier.' }]
  })

  // ADR 0021: a preset Agent whose assembly failed still runs and still bills a provider call, so the
  // run MUST carry why — otherwise a degraded run is indistinguishable from a healthy one in the UI.
  it('records degradation warnings on the run and keeps them through evidence and finalize', async () => {
    const scripted = createScriptedProviderAdapter([
      { events: [{ type: 'text-delta', delta: 'Done.' }, { type: 'finish', reason: 'stop' }] }
    ])
    const adapter = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(scripted),
      toolRegistry: createToolRegistry()
    })
    const degraded = 'Preset assembly failed (boom) — its bundled preset did not run'

    const execution = await adapter.execute({
      ...request('degraded-1'),
      warnings: [degraded]
    })
    expect(execution.ok).toBe(true)
    // Present while running, i.e. survived the `update(evidence)` that defaults warnings to [].
    expect(runStore.get('chat-1', 'degraded-1')?.warnings).toEqual([degraded])

    adapter.commitSuccess(
      'degraded-1',
      execution as Extract<typeof execution, { ok: true }>,
      { status: 'committed', operations: 0 }
    )

    const record = runStore.get('chat-1', 'degraded-1')
    expect(record?.status).toBe('succeeded')
    // Still there on the FINAL record — a succeeded run that is nonetheless marked degraded.
    expect(record?.warnings).toEqual([degraded])
  })

  it('leaves a healthy run with no warnings at all', async () => {
    const scripted = createScriptedProviderAdapter([
      { events: [{ type: 'text-delta', delta: 'Done.' }, { type: 'finish', reason: 'stop' }] }
    ])
    const adapter = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(scripted),
      toolRegistry: createToolRegistry()
    })

    const execution = await adapter.execute(request('healthy-1'))
    adapter.commitSuccess(
      'healthy-1',
      execution as Extract<typeof execution, { ok: true }>,
      { status: 'committed', operations: 0 }
    )

    expect(runStore.get('chat-1', 'healthy-1')?.warnings).toEqual([])
  })

  it('keeps successful evidence running until incorporation commits the outcome', async () => {
    let observedRunning = false
    const scripted = createScriptedProviderAdapter([
      {
        events: [
          {
            type: 'usage',
            usage: { inputTokens: 11, outputTokens: 2 },
            cache: { readTokens: 3, writeTokens: 1 },
            raw: {}
          },
          { type: 'text-delta', delta: 'Done.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const observing: ProviderAdapter = {
      dispatch(providerRequest, emit) {
        observedRunning =
          runStore.get('chat-1', 'success')?.status === 'running' &&
          events.some((event) => event.type === 'started' && event.run.invocationId === 'success')
        return scripted.dispatch(providerRequest, emit)
      }
    }
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(observing),
      toolRegistry: createToolRegistry()
    })

    const result = await runtime.execute(request('success'))

    expect(result).toMatchObject({ ok: true, result: 'Done.' })
    expect(observedRunning).toBe(true)
    expect(runStore.get('chat-1', 'success')).toMatchObject({
      status: 'running',
      agentVersion: 'catalog-v3',
      agentHash: 'sha256:catalog-v3',
      attempts: [{ outcome: 'success', providerCalls: 1 }],
      metrics: {
        inputTokens: 11,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1
      }
    })
    expect(events.map((event) => event.type)).toEqual(['started', 'updated'])

    runtime.commitSuccess('success', result as Extract<typeof result, { ok: true }>, {
      status: 'committed',
      operations: 0
    })

    expect(runStore.get('chat-1', 'success')).toMatchObject({
      status: 'succeeded',
      result: 'Done.',
      replay: { status: 'committed', operations: 0 }
    })
    expect(events.map((event) => event.type)).toEqual(['started', 'updated', 'finished'])
  })

  it('reuses one open Run Record across a stale transactional source restart', async () => {
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(
        createScriptedProviderAdapter([
          {
            events: [
              { type: 'text-delta', delta: 'Stale.' },
              { type: 'finish', reason: 'stop' }
            ]
          },
          {
            events: [
              { type: 'text-delta', delta: 'Current.' },
              { type: 'finish', reason: 'stop' }
            ]
          }
        ])
      ),
      toolRegistry: createToolRegistry()
    })

    const first = await runtime.execute(request('restart'))
    const second = await runtime.execute({
      ...request('restart'),
      input: { request: 'current-source' }
    })

    expect(first).toMatchObject({ ok: true, result: 'Stale.' })
    expect(second).toMatchObject({ ok: true, result: 'Current.' })
    expect(events.filter((event) => event.type === 'started')).toHaveLength(1)
    expect(runStore.get('chat-1', 'restart')).toMatchObject({
      status: 'running',
      input: { request: 'current-source' }
    })
    runtime.commitSuccess('restart', second as Extract<typeof second, { ok: true }>, {
      status: 'committed',
      operations: 0
    })
    expect(runStore.get('chat-1', 'restart')).toMatchObject({
      status: 'succeeded',
      result: 'Current.'
    })
  })

  it('persists a scripted provider failure', async () => {
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(
        createScriptedProviderAdapter([
          {
            error: new ProviderDispatchError('Access denied', {
              retryClass: 'non-retryable'
            })
          }
        ])
      ),
      toolRegistry: createToolRegistry()
    })

    const result = await runtime.execute(request('failure'))

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'PROVIDER_NON_RETRYABLE' }
    })
    expect(runStore.get('chat-1', 'failure')).toMatchObject({
      status: 'failed',
      attempts: [{ outcome: 'failure' }],
      failure: { code: 'PROVIDER_NON_RETRYABLE' }
    })
  })

  it('Stop aborts the real provider call and leaves overlapping invocations independent', async () => {
    const provider = controlledAdapter()
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(provider),
      toolRegistry: createToolRegistry()
    })
    const first = runtime.execute(request('first'))
    const second = runtime.execute(request('second'))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))

    expect(runtime.stop('first')).toBe(true)
    expect(runtime.stop('first')).toBe(true)
    expect(provider.calls[0].request.signal?.aborted).toBe(true)
    expect(provider.calls[1].request.signal?.aborted).toBe(false)
    provider.calls[1].succeed('Second completed.')

    await expect(first).resolves.toMatchObject({
      ok: false,
      failure: { code: 'CANCELLED' }
    })
    const secondResult = await second
    expect(secondResult).toMatchObject({ ok: true, result: 'Second completed.' })
    const cancelled = runStore.get('chat-1', 'first')
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.attempts).toMatchObject([{ outcome: 'cancelled', providerCalls: 1 }])
    expect(cancelled?.contextBudget).toBeDefined()
    expect(cancelled?.attempts[0].contextBudget).toEqual(cancelled?.contextBudget)
    expect(runStore.get('chat-1', 'second')?.status).toBe('running')
    if (!secondResult.ok) throw new Error('expected successful fixture')
    runtime.commitSuccess('second', secondResult, { status: 'committed', operations: 0 })
    expect(runStore.get('chat-1', 'second')?.status).toBe('succeeded')
  })

  it('combines caller cancellation with the invocation signal', async () => {
    const provider = controlledAdapter()
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(provider),
      toolRegistry: createToolRegistry()
    })
    const caller = new AbortController()
    const pending = runtime.execute({ ...request('caller-cancel'), signal: caller.signal })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))

    caller.abort('caller')

    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { code: 'CANCELLED' }
    })
    expect(provider.calls[0].request.signal?.aborted).toBe(true)
    expect(runStore.get('chat-1', 'caller-cancel')?.status).toBe('cancelled')
  })

  /**
   * ADR 0021 follow-up: prompt templates read MUTABLE state, so rendering twice — once for the run
   * record, once for dispatch — can record a prompt that only resembles what was sent. The renderer
   * below returns a different string on every call, which is exactly what a variable changing
   * between two render points looks like. It fails on any structure that renders more than once.
   */
  it('records the exact bytes dispatched, even when rendering is not idempotent', async () => {
    let renders = 0
    const scripted = createScriptedProviderAdapter([
      {
        events: [
          { type: 'text-delta', delta: 'Done.' },
          { type: 'finish', reason: 'stop' }
        ]
      }
    ])
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(scripted),
      toolRegistry: createToolRegistry()
    })

    const result = await runtime.execute({
      ...request('single-render'),
      render: (text) => `${text} [render#${++renders}]`
    })

    expect(result.ok).toBe(true)
    // Rendering happened once, and the record is the dispatched message list verbatim.
    expect(renders).toBe(1)
    const dispatched = scripted.requests[0].messages.map(({ role, content }) => ({ role, content }))
    const recorded = runStore.get('chat-1', 'single-render')?.renderedPrompt
    // Bytes are the dispatched message list verbatim; each carries its coarse origin (D3).
    expect(recorded?.map(({ role, content }) => ({ role, content }))).toEqual(dispatched)
    expect(recorded?.map((message) => message.origin)).toEqual([
      'harness-policy',
      'agent-prompt',
      'input'
    ])
    expect(dispatched.some((message) => message.content.includes('[render#1]'))).toBe(true)
  })

  it('shutdown aborts and finalizes every active provider call', async () => {
    const provider = controlledAdapter()
    const runtime = createHarnessRunAdapter({
      runStore,
      providerDispatch: providerDispatch(provider),
      toolRegistry: createToolRegistry()
    })
    const first = runtime.execute(request('shutdown-1'))
    const second = runtime.execute(request('shutdown-2'))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))

    runtime.shutdown()

    expect(provider.calls.every((call) => call.request.signal?.aborted)).toBe(true)
    await Promise.all([first, second])
    expect(runStore.get('chat-1', 'shutdown-1')).toMatchObject({
      status: 'cancelled',
      failure: { code: 'APP_SHUTDOWN' }
    })
    expect(runStore.get('chat-1', 'shutdown-2')).toMatchObject({
      status: 'cancelled',
      failure: { code: 'APP_SHUTDOWN' }
    })
  })
})
