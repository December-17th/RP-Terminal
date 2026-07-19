import { describe, expect, it, vi } from 'vitest'

import {
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationHarnessPort,
  type InvocationSourceSnapshot
} from '../../src/main/services/agentRuntime/invocation'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import type { HarnessExecutionResult } from '../../src/main/services/agentRuntime/harness'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'

// The blocksNextTurn barrier as the Classic direct path (generationService.generate) consumes it:
// `waitForNextTurnBarriers(chatId)` must block while a required blocksNextTurn Agent runs, then release
// on success, on fail-open failure (surfacing the failure), and on a Stop mid-barrier (execution-plan
// M3, decision D5 = fail-open, warned).

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
    prompt: [{ role: 'system', content: 'Go.' }],
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

const failure = (): HarnessExecutionResult => ({
  ok: false,
  failure: { code: 'AGENT_FAILED', message: 'boom', retryable: false },
  stagedOperations: [],
  evidence: { attempts: [] }
})

const setup = () => {
  const floor: InvocationFloorPort = {
    async resolveSource(): Promise<InvocationSourceSnapshot> {
      return { token: 't', input: {}, promptValues: {}, history: null }
    },
    async isSourceCurrent() {
      return true
    },
    async incorporate() {
      return { status: 'committed' }
    }
  }
  const execute = vi.fn<InvocationHarnessPort['execute']>()
  const runtime = createInvocationRuntime({
    catalog: { get: (_p, name) => agent(name) },
    harness: { execute, stop: () => false },
    floor
  })
  const run = (blocksNextTurn: boolean, required = true) =>
    runtime.run({
      profileId: 'p',
      chatId: 'c',
      floor: 12,
      agent: 'A',
      options: { blocksNextTurn, required }
    })
  return { runtime, execute, run }
}

describe('next-turn barrier (blocksNextTurn wiring)', () => {
  it('holds the next-turn wait while a blocksNextTurn Agent runs, then releases on success', async () => {
    const gate = deferred<HarnessExecutionResult>()
    const { runtime, execute, run } = setup()
    execute.mockImplementation(() => gate.promise)

    const invocation = run(true)
    await vi.waitFor(() =>
      expect(runtime.getNextTurnBarrier('c')).toMatchObject({ status: 'pending' })
    )

    let released = false
    const wait = runtime.waitForNextTurnBarriers('c').then((state) => {
      released = true
      return state
    })
    await Promise.resolve()
    expect(released).toBe(false) // the turn is still blocked

    gate.resolve(success('ok'))
    await expect(wait).resolves.toMatchObject({ status: 'clear' })
    await invocation
  })

  it('releases fail-open and surfaces the failure when a required Agent fails (D5)', async () => {
    const { runtime, execute, run } = setup()
    execute.mockResolvedValue(failure())

    const invocation = run(true)
    const state = await runtime.waitForNextTurnBarriers('c')

    // Fail-open: the wait RESOLVES (never rejects), and the failure is visible so the caller can warn.
    expect(state).toMatchObject({ status: 'failed', failures: [{ code: 'AGENT_FAILED' }] })
    await expect(invocation).resolves.toMatchObject({ status: 'failed' })
  })

  it('releases an optional blocksNextTurn Agent failure as clear (no turn gate)', async () => {
    const { runtime, execute, run } = setup()
    execute.mockResolvedValue(failure())

    await run(true, false)
    await expect(runtime.waitForNextTurnBarriers('c')).resolves.toMatchObject({ status: 'clear' })
  })

  it('releases the barrier when the Agent is Stopped mid-run', async () => {
    const gate = deferred<HarnessExecutionResult>()
    const { runtime, execute, run } = setup()
    execute.mockImplementation(() => gate.promise)

    const invocation = run(true)
    await vi.waitFor(() =>
      expect(runtime.getNextTurnBarrier('c')).toMatchObject({ status: 'pending' })
    )

    const wait = runtime.waitForNextTurnBarriers('c')
    runtime.cancelInvocation(invocation.invocationId)
    gate.resolve(success('ignored')) // let the aborted attempt unwind

    await expect(wait).resolves.toMatchObject({ status: 'clear' })
    await expect(invocation).resolves.toMatchObject({ status: 'cancelled' })
  })
})
