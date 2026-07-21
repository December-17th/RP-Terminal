import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import type { Settings } from '../../src/main/types/models'
import type { Preset } from '../../src/main/types/preset'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import { createSessionInvocationFloorPort } from '../../src/main/services/agentRuntime/InvocationRuntimeService'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import {
  createInvocationRuntime,
  type InvocationFloorPort
} from '../../src/main/services/agentRuntime/invocation'
import {
  ProviderDispatchError,
  createProviderDispatch,
  type NormalizedProviderRequest,
  type ProviderAdapter
} from '../../src/main/services/agentRuntime/provider'
import {
  createAgentRunStore,
  createHarnessRunAdapter
} from '../../src/main/services/agentRuntime/runs'
import { createToolRegistry } from '../../src/main/services/agentRuntime/tools'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'

interface ProviderCall {
  request: NormalizedProviderRequest
  succeed(text: string): void
  failTransient(message?: string): void
}

const controlledProvider = (): ProviderAdapter & { calls: ProviderCall[] } => {
  const calls: ProviderCall[] = []
  return {
    calls,
    dispatch(request, emit) {
      return new Promise<void>((resolve, reject) => {
        const abort = (): void =>
          reject(new ProviderDispatchError('cancelled', { retryClass: 'cancelled' }))
        if (request.signal?.aborted) return abort()
        request.signal?.addEventListener('abort', abort, { once: true })
        calls.push({
          request,
          succeed(text) {
            request.signal?.removeEventListener('abort', abort)
            emit({ type: 'text-delta', delta: text })
            emit({ type: 'finish', reason: 'stop' })
            resolve()
          },
          failTransient(message = 'temporary provider failure') {
            request.signal?.removeEventListener('abort', abort)
            reject(new ProviderDispatchError(message, { retryClass: 'transient' }))
          }
        })
      })
    }
  }
}

const parsed = parseAgentDefinition({
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'World Progression',
  prompt: [{ role: 'system', content: 'Progress the world.' }],
  result: {
    mode: 'text',
    saveAs: 'variables.__rpt.agent_results.world.progression'
  },
  defaults: { maxRetryAttempts: 0, retryDelayMs: 0, notification: 'none' }
})
if (!parsed.ok) throw new Error('invalid fixture')
const catalogAgent: CatalogAgent = {
  id: 'world-progression',
  name: parsed.value.name,
  source: { kind: 'user-created', key: 'world-progression', version: '1' },
  sourcePresent: true,
  availableSource: null,
  baseline: parsed.value,
  effective: parsed.value,
  effectiveHash: 'hash:world-progression',
  customized: false,
  enabled: true,
  createdAt: '',
  updatedAt: ''
}

const directorParsed = parseAgentDefinition({
  format: 'rpt-agent',
  formatVersion: 1,
  name: 'Yuzu Director',
  prompt: [{ role: 'system', content: 'Write legacy YSS.' }],
  result: {
    mode: 'text',
    validator: 'yss',
    saveAs: 'variables.__rpt.agent_results.yuzu.director'
  },
  defaults: { maxRetryAttempts: 0, retryDelayMs: 0, notification: 'none' }
})
if (!directorParsed.ok) throw new Error('invalid director fixture')
const directorAgent: CatalogAgent = {
  ...catalogAgent,
  id: 'yuzu-director',
  name: directorParsed.value.name,
  baseline: directorParsed.value,
  effective: directorParsed.value,
  effectiveHash: 'hash:yuzu-director'
}

const settings = {
  api: {
    provider: 'openai',
    endpoint: 'https://provider.test/v1',
    api_key: 'secret',
    model: 'fixed'
  },
  api_presets: [
    {
      id: 'fixed',
      name: 'Fixed',
      provider: 'openai',
      endpoint: 'https://provider.test/v1',
      api_key: 'secret',
      model: 'fixed'
    }
  ],
  active_api_preset_id: 'fixed',
  cache: { mode: 'baseline' }
} as Settings

describe('InvocationRuntime session integration', () => {
  let db: InstanceType<typeof Adapter>
  let provider: ReturnType<typeof controlledProvider>

  beforeEach(() => {
    db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    provider = controlledProvider()
  })

  const insertFloor = (floor: number, variables: Record<string, unknown> = {}) => {
    db.prepare(
      `INSERT INTO floors
       (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES ('chat', ?, 'now', '', '', '[]', ?)`
    ).run(floor, JSON.stringify(variables))
  }

  const setup = (
    floorPort = createSessionInvocationFloorPort({
      getDb: () => db as never,
      profileForChat: () => 'profile'
    }),
    agent = catalogAgent
  ) => {
    const store = createAgentRunStore({ getDb: () => db as never, now: () => 'now' })
    const harness = createHarnessRunAdapter({
      runStore: store,
      providerDispatch: createProviderDispatch({
        adapter: provider,
        getSettings: () => settings,
        getActivePreset: () => ({ parameters: {} }) as Preset
      }),
      toolRegistry: createToolRegistry()
    })
    const runtime = createInvocationRuntime({
      catalog: { get: () => agent },
      harness,
      floor: floorPort,
      runStore: store,
      createId: (() => {
        let next = 0
        return () => `invocation-${++next}`
      })()
    })
    store.onBeforeDeleteFromFloor((chatId, fromFloor) => runtime.cancelFloors(chatId, fromFloor))
    return { runtime, store }
  }

  it('deleting floor 12 aborts immediately and erases its Run Record', async () => {
    insertFloor(12)
    const { runtime, store } = setup()
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))

    store.deleteFromFloor('chat', 12)
    db.prepare('DELETE FROM floors WHERE chat_id = ? AND floor >= ?').run('chat', 12)

    expect(provider.calls[0].request.signal?.aborted).toBe(true)
    await expect(invocation).resolves.toMatchObject({ status: 'cancelled' })
    expect(store.list('chat')).toEqual([])
  })

  it('late floor-12 incorporation replays its Result Slot through floor 13', async () => {
    insertFloor(12, { marker: 12 })
    const { runtime, store } = setup()
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    insertFloor(13, { marker: 13 })

    provider.calls[0].succeed('late result')
    await expect(invocation).resolves.toMatchObject({ status: 'succeeded' })

    const floor13 = db
      .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
      .get('chat', 13) as { variables: string }
    expect(JSON.parse(floor13.variables)).toMatchObject({
      __rpt: { agent_results: { world: { progression: 'late result' } } }
    })
    expect(store.list('chat')).toMatchObject([
      { status: 'succeeded', replay: { status: 'committed' } }
    ])
  })

  it('folds an Agent UpdateVariable result onto the current latest floor before storing the run', async () => {
    insertFloor(12, { stat_data: { hp: 1 } })
    const agent = {
      ...catalogAgent,
      effective: { ...catalogAgent.effective, result: { mode: 'text' as const } }
    }
    const { runtime, store } = setup(undefined, agent)
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: agent.name
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    insertFloor(13, { stat_data: { hp: 10 } })

    const result = "Done.\n<UpdateVariable>\n_.add('hp', 2);//agent update\n</UpdateVariable>"
    provider.calls[0].succeed(result)
    await expect(invocation).resolves.toMatchObject({ status: 'succeeded', result })

    const floor12 = db
      .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
      .get('chat', 12) as { variables: string }
    const floor13 = db
      .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
      .get('chat', 13) as { variables: string }
    expect(JSON.parse(floor12.variables)).toMatchObject({ stat_data: { hp: 1 } })
    expect(JSON.parse(floor13.variables)).toMatchObject({
      stat_data: { hp: 12 },
      delta_data: [{ path: 'hp', old: 10, new: 12, reason: 'agent update' }]
    })
    expect(store.list('chat')).toMatchObject([{ status: 'succeeded', result }])
  })

  it('runs a read-only raw-text presentation pass without legacy YSS validation or incorporation', async () => {
    insertFloor(12, { stat_data: { hp: 10 } })
    const { runtime, store } = setup(undefined, directorAgent)
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: directorAgent.name,
      acceptRawTextResult: true,
      restartOnSourceChange: false,
      skipResultIncorporation: true,
      options: { maxSteps: 1, maxRetryAttempts: 0 }
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))

    const result =
      '<|block|>\n<UpdateVariable>_.set("hp", 1)</UpdateVariable>\n<|bg classroom|>\n<|end|>'
    provider.calls[0].succeed(result)
    await expect(invocation).resolves.toMatchObject({ status: 'succeeded', result })

    const row = db
      .prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
      .get('chat', 12) as { variables: string }
    expect(JSON.parse(row.variables)).toEqual({ stat_data: { hp: 10 } })
    expect(store.list('chat')).toMatchObject([
      {
        status: 'succeeded',
        result,
        replay: { status: 'discarded', operations: 0 }
      }
    ])
  })

  it('does not issue a second provider call when a presentation source becomes stale', async () => {
    insertFloor(12, { revision: 1 })
    const { runtime } = setup(undefined, directorAgent)
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: directorAgent.name,
      acceptRawTextResult: true,
      restartOnSourceChange: false,
      skipResultIncorporation: true,
      options: { maxSteps: 1, maxRetryAttempts: 0 }
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))

    db.prepare('UPDATE floors SET variables = ? WHERE chat_id = ? AND floor = ?').run(
      JSON.stringify({ revision: 2 }),
      'chat',
      12
    )
    runtime.invalidateSources('chat', 12)

    await expect(invocation).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'SOURCE_CHANGED' },
      sourceRestarts: 0
    })
    expect(provider.calls).toHaveLength(1)
  })

  it('floor 13 waits for floor-12 incorporation before resolving same-Agent input', async () => {
    insertFloor(12)
    insertFloor(13)
    const { runtime } = setup()
    const floor12 = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name
    })
    const floor13 = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 13,
      agent: catalogAgent.name,
      options: {
        inputBindings: {
          prior: {
            source: {
              type: 'result',
              path: 'variables.__rpt.agent_results.world.progression'
            }
          }
        }
      }
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    provider.calls[0].succeed('floor 12')
    await floor12
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))

    expect(provider.calls[1].request.messages.at(-1)?.content).toContain('"prior":"floor 12"')
    provider.calls[1].succeed('floor 13')
    await expect(floor13).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('restarts one transactional invocation after staleness without a Harness retry', async () => {
    insertFloor(12, { revision: 1 })
    const { runtime, store } = setup()
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name,
      options: {
        inputBindings: {
          revision: { source: { type: 'variables', path: 'variables.revision' } }
        }
      }
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    db.prepare('UPDATE floors SET variables = ? WHERE chat_id = ? AND floor = ?').run(
      JSON.stringify({ revision: 2 }),
      'chat',
      12
    )
    runtime.invalidateSources('chat', 12)
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls[1].succeed('current')

    await expect(invocation).resolves.toMatchObject({
      status: 'succeeded',
      sourceRestarts: 1
    })
    expect(store.list('chat')).toMatchObject([
      {
        invocationId: 'invocation-1',
        status: 'succeeded',
        input: { revision: 2 },
        metrics: { retries: 0 }
      }
    ])
  })

  it('failed incorporation never exposes a succeeded Run Record', async () => {
    insertFloor(12)
    const base = createSessionInvocationFloorPort({
      getDb: () => db as never,
      profileForChat: () => 'profile'
    })
    const { runtime, store } = setup({
      ...base,
      async incorporate() {
        return {
          status: 'failed',
          failure: { code: 'REPLAY_FAILED', message: 'floor 13 rejected', retryable: true }
        }
      }
    })
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name,
      options: { maxRetryAttempts: 0, retryDelayMs: 0 }
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    provider.calls[0].succeed('uncommitted')

    await expect(invocation).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'REPLAY_FAILED' }
    })
    expect(store.list('chat')).toMatchObject([
      { status: 'failed', failure: { code: 'REPLAY_FAILED' } }
    ])
  })

  it('exhausts bounded incorporation Corrective Retries without transport retry metrics', async () => {
    insertFloor(12)
    const base = createSessionInvocationFloorPort({
      getDb: () => db as never,
      profileForChat: () => 'profile'
    })
    const incorporate = vi.fn(async () => ({
      status: 'failed' as const,
      failure: { code: 'REPLAY_FAILED', message: 'replay rejected', retryable: true }
    }))
    const { runtime, store } = setup({ ...base, incorporate })
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name,
      options: { maxRetryAttempts: 2, retryDelayMs: 0 }
    })

    for (let index = 0; index < 3; index++) {
      await vi.waitFor(() => expect(provider.calls).toHaveLength(index + 1))
      provider.calls[index].succeed(`rejected-${index}`)
    }

    await expect(invocation).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'REPLAY_FAILED' },
      sourceRestarts: 0
    })
    expect(incorporate).toHaveBeenCalledTimes(3)
    expect(store.list('chat')).toMatchObject([{ metrics: { retries: 0 } }])
    expect(provider.calls[1].request.messages.at(-1)?.content).toContain(
      'Rejected output: "rejected-0"'
    )
    expect(provider.calls[1].request.messages.at(-1)?.content).toContain(
      'Validation error: replay rejected'
    )
  })

  it('shares retry exhaustion across one transport retry and incorporation correction', async () => {
    insertFloor(12)
    const base = createSessionInvocationFloorPort({
      getDb: () => db as never,
      profileForChat: () => 'profile'
    })
    const incorporate = vi.fn(async () => ({
      status: 'failed' as const,
      failure: { code: 'REPLAY_FAILED', message: 'replay rejected', retryable: true }
    }))
    const { runtime, store } = setup({ ...base, incorporate })
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name,
      options: { maxRetryAttempts: 2, retryDelayMs: 0 }
    })

    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    provider.calls[0].failTransient()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls[1].succeed('first usable output')
    await vi.waitFor(() => expect(provider.calls).toHaveLength(3))
    provider.calls[2].succeed('corrected output')

    await expect(invocation).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'REPLAY_FAILED' }
    })
    expect(provider.calls).toHaveLength(3)
    expect(incorporate).toHaveBeenCalledTimes(2)
    expect(store.list('chat')).toMatchObject([{ metrics: { retries: 1 } }])
  })

  it('succeeds within the shared budget after one transport and one incorporation retry', async () => {
    insertFloor(12)
    const base = createSessionInvocationFloorPort({
      getDb: () => db as never,
      profileForChat: () => 'profile'
    })
    const incorporate = vi
      .fn<InvocationFloorPort['incorporate']>()
      .mockResolvedValueOnce({
        status: 'failed',
        failure: { code: 'REPLAY_FAILED', message: 'replay rejected', retryable: true }
      })
      .mockImplementation((request) => base.incorporate(request))
    const { runtime, store } = setup({ ...base, incorporate })
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name,
      options: { maxRetryAttempts: 2, retryDelayMs: 0 }
    })

    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    provider.calls[0].failTransient()
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
    provider.calls[1].succeed('first usable output')
    await vi.waitFor(() => expect(provider.calls).toHaveLength(3))
    provider.calls[2].succeed('corrected output')

    await expect(invocation).resolves.toMatchObject({
      status: 'succeeded',
      result: 'corrected output'
    })
    expect(provider.calls).toHaveLength(3)
    expect(incorporate).toHaveBeenCalledTimes(2)
    expect(store.list('chat')).toMatchObject([{ metrics: { retries: 1 } }])
  })

  it('production-composed shutdown records APP_SHUTDOWN exactly once', async () => {
    insertFloor(12)
    const { runtime, store } = setup()
    const invocation = runtime.run({
      profileId: 'profile',
      chatId: 'chat',
      floor: 12,
      agent: catalogAgent.name
    })
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))

    runtime.shutdown()
    runtime.shutdown()

    expect(provider.calls[0].request.signal?.aborted).toBe(true)
    await expect(invocation).resolves.toMatchObject({ status: 'cancelled' })
    expect(store.list('chat')).toMatchObject([
      {
        status: 'cancelled',
        failure: { code: 'APP_SHUTDOWN' }
      }
    ])
  })
})
