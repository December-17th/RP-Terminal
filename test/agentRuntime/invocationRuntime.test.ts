import { describe, expect, it, vi } from 'vitest'

import {
  InvocationRuntimeError,
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationHarnessPort,
  type InvocationSourceSnapshot
} from '../../src/main/services/agentRuntime/invocation'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import type { HarnessExecutionResult } from '../../src/main/services/agentRuntime/harness'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const agent = (name: string): CatalogAgent => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name,
    prompt: [{ role: 'system', content: 'Answer.' }],
    result: { mode: 'text' }
  })
  if (!parsed.ok) throw new Error('invalid fixture')
  return {
    id: name,
    name,
    source: { kind: 'user-created', key: name, version: '1' },
    sourcePresent: true,
    availableSource: null,
    baseline: parsed.value,
    effective: parsed.value,
    effectiveHash: `hash:${name}`,
    customized: false,
    enabled: true,
    createdAt: '',
    updatedAt: ''
  }
}

const success = (result: string): HarnessExecutionResult => ({
  ok: true,
  result,
  stagedOperations: [],
  evidence: { attempts: [] }
})

const setup = (names = ['A', 'B']) => {
  const agents = new Map(names.map((name) => [name, agent(name)]))
  let revision = 1
  const incorporated: Array<{ floor: number; result: unknown }> = []
  const floor: InvocationFloorPort = {
    async resolveSource(request): Promise<InvocationSourceSnapshot> {
      return {
        token: `${request.floor}:${revision}`,
        input: { revision },
        promptValues: {},
        history: null
      }
    },
    async isSourceCurrent(source) {
      return source.token.endsWith(`:${revision}`)
    },
    async incorporate(request) {
      if (!(await floor.isSourceCurrent(request.source))) return { status: 'stale' }
      incorporated.push({ floor: request.floor, result: request.execution.result })
      if (request.execution.result === 'first') revision = 2
      return { status: 'committed' }
    }
  }
  const execute = vi.fn<InvocationHarnessPort['execute']>(async (request) =>
    success(`${request.agent.definition.name}:${request.input.revision}`)
  )
  const runtime = createInvocationRuntime({
    catalog: { get: (_profileId, name) => agents.get(name) ?? null },
    harness: { execute, stop: () => false },
    floor,
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })()
  })
  return {
    runtime,
    execute,
    floor,
    incorporated,
    setRevision(value: number) {
      revision = value
    }
  }
}

describe('InvocationRuntime', () => {
  it('coalesces the immutable chat/floor/Agent identity', async () => {
    const { runtime, execute } = setup()
    const request = { profileId: 'p', chatId: 'c', floor: 12, agent: 'A' }

    const first = runtime.run(request)
    const duplicate = runtime.run({ ...request, options: { required: false } })

    expect(duplicate).toBe(first)
    await expect(first).resolves.toMatchObject({ status: 'succeeded', result: 'A:1' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('prunes a completed identity so the same floor is retryable with a fresh provider call', async () => {
    const { runtime, execute } = setup(['A'])
    execute
      .mockResolvedValueOnce({
        ok: false,
        failure: { code: 'NO', message: 'no', retryable: false },
        stagedOperations: [],
        evidence: { attempts: [] }
      })
      .mockResolvedValueOnce(success('second'))
    const request = { profileId: 'p', chatId: 'c', floor: 12, agent: 'A' }

    // A FAILED run at floor 12 must not leave a stale resolved outcome in the identity ledger.
    const first = runtime.run(request)
    expect(first.invocationId).toBe('id-1')
    await expect(first).resolves.toMatchObject({ status: 'failed', failure: { code: 'NO' } })

    // Running the SAME identity again gets a fresh invocation (id-2) and a new provider call — not the
    // coalesced id-1 failure.
    const second = runtime.run(request)
    expect(second.invocationId).toBe('id-2')
    await expect(second).resolves.toMatchObject({ status: 'succeeded', result: 'second' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not retain a succeeded identity in the dedupe ledger', async () => {
    const { runtime, execute } = setup(['A'])
    const request = { profileId: 'p', chatId: 'c', floor: 7, agent: 'A' }

    await expect(runtime.run(request)).resolves.toMatchObject({ status: 'succeeded' })
    // The first run completed and its identity was pruned; a second call re-executes rather than
    // returning the earlier resolved outcome (no unbounded ledger growth).
    await expect(runtime.run(request)).resolves.toMatchObject({ status: 'succeeded' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(runtime.hasActiveWork()).toBe(false)
  })

  it('serializes the same Agent lane through incorporation before resolving later input', async () => {
    const first = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup(['A'])
    execute
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (request) => success(`second:${request.input.revision}`))

    const floor12 = runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    const floor13 = runtime.run({ profileId: 'p', chatId: 'c', floor: 13, agent: 'A' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    first.resolve(success('first'))

    await expect(floor12).resolves.toMatchObject({ status: 'succeeded' })
    await expect(floor13).resolves.toMatchObject({ status: 'succeeded', result: 'second:2' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('orders queued same-Agent invocations by floor rather than call arrival', async () => {
    const active = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup(['A'])
    execute
      .mockImplementationOnce(() => active.promise)
      .mockImplementation(async (request) => success(`floor:${request.floor}`))

    const floor12 = runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    const floor14 = runtime.run({ profileId: 'p', chatId: 'c', floor: 14, agent: 'A' })
    const floor13 = runtime.run({ profileId: 'p', chatId: 'c', floor: 13, agent: 'A' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    active.resolve(success('floor:12'))

    await Promise.all([floor12, floor13, floor14])
    expect(execute.mock.calls.map(([request]) => request.floor)).toEqual([12, 13, 14])
  })

  it('rejects an older floor arriving after a newer floor is already executing', async () => {
    const active = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup(['A'])
    execute.mockImplementation(() => active.promise)

    runtime.run({ profileId: 'p', chatId: 'c', floor: 14, agent: 'A' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    await expect(
      runtime.run({ profileId: 'p', chatId: 'c', floor: 13, agent: 'A' })
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'OLDER_FLOOR_ALREADY_EXECUTING' }
    })
    active.resolve(success('floor:14'))
  })

  it('runs author-declared parallel Agents together', async () => {
    const a = deferred<HarnessExecutionResult>()
    const b = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup()
    execute.mockImplementation((request) =>
      request.agent.definition.name === 'A' ? a.promise : b.promise
    )

    const plan = runtime.runPlan({
      profileId: 'p',
      chatId: 'c',
      floor: 12,
      plan: { steps: [{ parallel: [{ agent: 'A' }, { agent: 'B' }] }] }
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    a.resolve(success('a'))
    b.resolve(success('b'))

    await expect(plan).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('incorporates a late result through its originating-floor port', async () => {
    const late = deferred<HarnessExecutionResult>()
    const { runtime, execute, incorporated } = setup()
    execute.mockImplementation((request) =>
      request.agent.definition.name === 'A' ? late.promise : Promise.resolve(success('newer'))
    )

    const floor12 = runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    await runtime.run({ profileId: 'p', chatId: 'c', floor: 13, agent: 'B' })
    expect(incorporated).toEqual([{ floor: 13, result: 'newer' }])
    late.resolve(success('late'))
    await floor12

    expect(incorporated).toEqual([
      { floor: 13, result: 'newer' },
      { floor: 12, result: 'late' }
    ])
  })

  it('aborts and erases an originating floor without retaining a late result', async () => {
    const late = deferred<HarnessExecutionResult>()
    const { runtime, execute, incorporated } = setup(['A'])
    execute.mockImplementation(() => late.promise)

    const invocation = runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    runtime.deleteFloors('c', 12)
    expect(execute.mock.calls[0][0].signal?.aborted).toBe(true)
    late.resolve(success('too late'))

    await expect(invocation).resolves.toMatchObject({ status: 'cancelled' })
    expect(incorporated).toEqual([])
  })

  it('rebinds a stale transactional source without consuming Harness retries', async () => {
    const { runtime, execute, setRevision } = setup(['A'])
    execute.mockImplementationOnce(async () => {
      setRevision(2)
      runtime.invalidateSources('c', 12)
      return success('stale')
    })

    await expect(
      runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    ).resolves.toMatchObject({ status: 'succeeded', result: 'A:2', sourceRestarts: 1 })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0].input).toEqual({ revision: 2 })
  })

  it('rejects stale restart after a non-transactional boundary', async () => {
    const { runtime, execute, setRevision } = setup(['A'])
    execute.mockImplementationOnce(async () => {
      setRevision(2)
      runtime.invalidateSources('c', 12)
      return {
        ...success('external'),
        evidence: {
          attempts: [
            {
              attempt: 1,
              outcome: 'success',
              providerCalls: 1,
              immutablePrefix: [],
              toolSchemas: [],
              appendOnlyLog: [],
              tools: [],
              usage: [],
              cache: [],
              latencyMs: [],
              rateLimits: [],
              irreversibleBoundary: true
            }
          ]
        }
      }
    })

    await expect(
      runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'STALE_NON_TRANSACTIONAL_SOURCE' }
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stops a required sequence and continues after an optional failure', async () => {
    const { runtime, execute } = setup(['A', 'B', 'C'])
    execute.mockImplementation(async (request) =>
      request.agent.definition.name === 'A'
        ? {
            ok: false,
            failure: { code: 'NO', message: 'no', retryable: false },
            stagedOperations: [],
            evidence: { attempts: [] }
          }
        : success(request.agent.definition.name)
    )

    const stopped = await runtime.runPlan({
      profileId: 'p',
      chatId: 'required',
      floor: 12,
      plan: { steps: [{ agent: 'A' }, { agent: 'B' }] }
    })
    const continued = await runtime.runPlan({
      profileId: 'p',
      chatId: 'optional',
      floor: 12,
      plan: { steps: [{ agent: 'A', required: false }, { agent: 'C' }] }
    })

    expect(stopped).toMatchObject({ status: 'failed', outcomes: [{ status: 'failed' }] })
    expect(continued).toMatchObject({
      status: 'succeeded',
      outcomes: [{ status: 'failed' }, { status: 'succeeded' }]
    })
  })

  it('cancels active and queued plan members by plan identity', async () => {
    const pending = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup()
    execute.mockImplementation(() => pending.promise)
    const plan = runtime.runPlan({
      profileId: 'p',
      chatId: 'c',
      floor: 12,
      plan: { steps: [{ agent: 'A' }, { agent: 'B' }] }
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    expect(runtime.cancelPlan(plan.planId)).toBe(true)
    pending.resolve(success('discarded'))

    await expect(plan).resolves.toMatchObject({ status: 'cancelled' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('exposes pending and failed required next-turn barriers', async () => {
    const pending = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup(['A'])
    execute.mockImplementation(() => pending.promise)
    const invocation = runtime.run({
      profileId: 'p',
      chatId: 'c',
      floor: 12,
      agent: 'A',
      options: { blocksNextTurn: true }
    })
    await vi.waitFor(() =>
      expect(runtime.getNextTurnBarrier('c')).toMatchObject({ status: 'pending' })
    )
    pending.resolve({
      ok: false,
      failure: { code: 'NO', message: 'no', retryable: false },
      stagedOperations: [],
      evidence: { attempts: [] }
    })
    await invocation

    expect(runtime.getNextTurnBarrier('c')).toMatchObject({
      status: 'failed',
      failures: [{ code: 'NO' }]
    })
  })

  it('releases an optional next-turn barrier after final failure', async () => {
    const { runtime, execute } = setup(['A'])
    execute.mockResolvedValue({
      ok: false,
      failure: { code: 'NO', message: 'no', retryable: false },
      stagedOperations: [],
      evidence: { attempts: [] }
    })

    await runtime.run({
      profileId: 'p',
      chatId: 'c',
      floor: 12,
      agent: 'A',
      options: { blocksNextTurn: true, required: false }
    })

    expect(runtime.getNextTurnBarrier('c')).toEqual({
      status: 'clear',
      pending: 0,
      failures: []
    })
  })

  it('rejects invalid plans and disabled or missing Agents before launch', async () => {
    const { runtime } = setup(['A'])
    expect(() =>
      runtime.runPlan({
        profileId: 'p',
        chatId: 'c',
        floor: 12,
        plan: { steps: [{ parallel: [{ agent: 'A' }, { parallel: [{ agent: 'B' }] }] }] }
      })
    ).toThrow(InvocationRuntimeError)
    expect(() =>
      runtime.runPlan({
        profileId: 'p',
        chatId: 'c',
        floor: 12,
        plan: { steps: [{ agent: 'A' }, { agent: 'a' }] }
      })
    ).toThrow(InvocationRuntimeError)
    await expect(
      runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'missing' })
    ).resolves.toMatchObject({ status: 'failed', failure: { code: 'AGENT_NOT_FOUND' } })
  })

  it('reports input resolution and incorporation failures without stranding a lane', async () => {
    const first = setup(['A'])
    vi.spyOn(first.floor, 'resolveSource').mockRejectedValueOnce(new Error('missing binding'))
    await expect(
      first.runtime.run({ profileId: 'p', chatId: 'c', floor: 12, agent: 'A' })
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'INPUT_RESOLUTION_FAILED', message: 'missing binding' }
    })

    const second = setup(['A'])
    vi.spyOn(second.floor, 'incorporate').mockRejectedValueOnce(new Error('replay rejected'))
    await expect(
      second.runtime.run({
        profileId: 'p',
        chatId: 'c',
        floor: 12,
        agent: 'A',
        options: { maxRetryAttempts: 0, retryDelayMs: 0 }
      })
    ).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'RESULT_INCORPORATION_FAILED', message: 'replay rejected' }
    })
  })

  it('correctively retries retryable incorporation failure with the same source snapshot', async () => {
    const { runtime, execute, floor } = setup(['A'])
    vi.spyOn(floor, 'incorporate')
      .mockResolvedValueOnce({
        status: 'failed',
        failure: { code: 'REPLAY_FAILED', message: 'floor 13 rejected', retryable: true }
      })
      .mockResolvedValueOnce({ status: 'committed' })
    execute.mockResolvedValueOnce(success('rejected')).mockResolvedValueOnce(success('corrected'))

    await expect(
      runtime.run({
        profileId: 'p',
        chatId: 'c',
        floor: 12,
        agent: 'A',
        options: { maxRetryAttempts: 2, retryDelayMs: 0 }
      })
    ).resolves.toMatchObject({
      status: 'succeeded',
      result: 'corrected',
      sourceRestarts: 0
    })

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0]).toMatchObject({
      invocationId: 'id-1',
      input: { revision: 1 },
      corrective: {
        rejectedOutput: '"rejected"',
        failure: { code: 'REPLAY_FAILED', message: 'floor 13 rejected' }
      }
    })
  })

  it('releases an incorporation retry reserved before a stale retry delay', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, execute, floor, setRevision } = setup(['A'])
      vi.spyOn(floor, 'incorporate')
        .mockResolvedValueOnce({
          status: 'failed',
          failure: { code: 'REPLAY_FAILED', message: 'first rejection', retryable: true }
        })
        .mockResolvedValueOnce({
          status: 'failed',
          failure: { code: 'REPLAY_FAILED', message: 'fresh rejection', retryable: true }
        })
        .mockResolvedValueOnce({ status: 'committed' })
      execute
        .mockResolvedValueOnce(success('stale correction source'))
        .mockResolvedValueOnce(success('fresh rejection'))
        .mockResolvedValueOnce(success('fresh correction'))

      const invocation = runtime.run({
        profileId: 'p',
        chatId: 'c',
        floor: 12,
        agent: 'A',
        options: { maxRetryAttempts: 1, retryDelayMs: 100 }
      })
      await vi.waitFor(() => expect(floor.incorporate).toHaveBeenCalledTimes(1))

      setRevision(2)
      runtime.invalidateSources('c', 12)
      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(() => expect(floor.incorporate).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(100)

      await expect(invocation).resolves.toMatchObject({
        status: 'succeeded',
        result: 'fresh correction',
        sourceRestarts: 1
      })
      expect(execute).toHaveBeenCalledTimes(3)
      expect(execute.mock.calls[1][0]).toMatchObject({ input: { revision: 2 } })
      expect(execute.mock.calls[1][0]).not.toHaveProperty('corrective')
      expect(execute.mock.calls[2][0]).toMatchObject({
        input: { revision: 2 },
        corrective: {
          rejectedOutput: '"fresh rejection"',
          failure: { code: 'REPLAY_FAILED' }
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('shuts the Harness down once without ordinary cancellation finalization', async () => {
    const pending = deferred<HarnessExecutionResult>()
    const agents = new Map([['A', agent('A')]])
    const stop = vi.fn(() => true)
    const shutdown = vi.fn()
    const runtime = createInvocationRuntime({
      catalog: { get: (_profileId, name) => agents.get(name) ?? null },
      harness: { execute: () => pending.promise, stop, shutdown },
      floor: {
        resolveSource: async () => ({ token: 'same', input: {} }),
        isSourceCurrent: () => true,
        incorporate: async () => ({ status: 'committed' })
      }
    })
    runtime.run({ profileId: 'p', chatId: 'c', floor: 1, agent: 'A' })
    await vi.waitFor(() => expect(stop).not.toHaveBeenCalled())

    runtime.shutdown()
    runtime.shutdown()

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    pending.resolve(success('discarded'))
  })

  // Classic Narrator plan, Milestone 4 — the Agent-side input to the ONE `hasActiveBackgroundWork`
  // signal. Must cover QUEUED as well as RUNNING work, and must go false once the lane drains (the
  // `invocations` map is the identity ledger and is NOT pruned on success, so a size check would
  // latch true forever).
  it('reports active work while an invocation is running or queued, and idle once it drains', async () => {
    const first = deferred<HarnessExecutionResult>()
    const second = deferred<HarnessExecutionResult>()
    const { runtime, execute } = setup(['A'])
    execute
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    expect(runtime.hasActiveWork()).toBe(false)

    const running = runtime.run({ profileId: 'p', chatId: 'c', floor: 1, agent: 'A' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(runtime.hasActiveWork()).toBe(true)

    // Same lane, later floor: queued behind the running one — still active work.
    const queued = runtime.run({ profileId: 'p', chatId: 'c', floor: 2, agent: 'A' })
    expect(runtime.hasActiveWork()).toBe(true)

    first.resolve(success('first'))
    await running
    expect(runtime.hasActiveWork()).toBe(true)

    second.resolve(success('second'))
    await queued
    await vi.waitFor(() => expect(runtime.hasActiveWork()).toBe(false))
  })
})
