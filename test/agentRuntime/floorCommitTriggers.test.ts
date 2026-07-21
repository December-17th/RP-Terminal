import { describe, expect, it, vi } from 'vitest'

vi.mock('better-sqlite3', () => import('../mocks/betterSqlite3Node'))

import Adapter from '../mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../../src/main/services/sessionDbService'
import { createAgentRunStore } from '../../src/main/services/agentRuntime/runs'
import { createFloorCommitTriggerRuntime } from '../../src/main/services/agentRuntime/triggerRuntime'
import {
  createInvocationRuntime,
  type InvocationFloorPort,
  type InvocationHarnessPort,
  type InvocationSourceSnapshot
} from '../../src/main/services/agentRuntime/invocation'
import type { CatalogAgent } from '../../src/main/services/agentRuntime/catalog'
import type { HarnessExecutionResult } from '../../src/main/services/agentRuntime/harness'
import { parseAgentDefinition, type CardFloorCommit } from '../../src/shared/agentRuntime'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const commitEvent = (floor: number): CardFloorCommit => ({
  floor,
  variables: {},
  previousVariables: {}
})

// ── cadence decision over the real AgentRunStore (rewind-correct derived state) ─────────────────────
describe('floor-commit cadence trigger', () => {
  const setupStore = () => {
    const db = new Adapter(':memory:')
    db.exec(SESSION_SCHEMA)
    const store = createAgentRunStore({ getDb: () => db as never, now: () => 'now' })
    let seq = 0
    // Simulate what invocationRuntime().run() does: a Run Record exists at the dispatched floor the
    // moment the run is created. That row is the derived cadence baseline latestRunFloor reads.
    const recordRun = (floor: number, agentName: string): void => {
      db.prepare(
        `INSERT INTO agent_runs (invocation_id, chat_id, floor, status, started_at, record)
         VALUES (?, 'chat', ?, 'running', 'now', ?)`
      ).run(`inv-${++seq}`, floor, JSON.stringify({ agentName, floor }))
    }
    return { db, store, recordRun }
  }

  const fireEvery = (everyNFloors: number, store: ReturnType<typeof setupStore>['store'], recordRun: (floor: number, agent: string) => void) => {
    const dispatched: number[] = []
    const evaluate = createFloorCommitTriggerRuntime({
      catalogAgents: () => [
        { name: 'Cadence', enabled: true, trigger: { onFloorCommitted: { everyNFloors } } }
      ],
      latestRunFloor: (chatId, agentName) => store.latestRunFloor(chatId, agentName),
      dispatch: (request) => {
        dispatched.push(request.floor)
        recordRun(request.floor, request.agent)
      },
      isReady: () => true,
      whenReady: () => Promise.resolve()
    })
    return { dispatched, commit: (floor: number) => evaluate('p', 'chat', commitEvent(floor)) }
  }

  it('fires on the Nth new-floor commit, matching the workflow trigger.cadence baseline', () => {
    const { store, recordRun } = setupStore()
    const { dispatched, commit } = fireEvery(3, store, recordRun)

    for (let floor = 0; floor <= 5; floor += 1) commit(floor)

    // lastFire -1, N=3: first fires at floor index 2 (floors 0,1,2), then 3 floors later at floor 5 —
    // exactly headlessRunService's cadence (current - lastFire >= everyNFloors, lastFire advances to
    // the fired floor).
    expect(dispatched).toEqual([2, 5])
  })

  it('deleting the floors that held the last run makes the Agent due again (rewind-correct)', () => {
    const { store, recordRun } = setupStore()
    const { dispatched, commit } = fireEvery(3, store, recordRun)

    for (let floor = 0; floor <= 5; floor += 1) commit(floor)
    expect(dispatched).toEqual([2, 5])

    // Delete floors >= 5 — deletes the run recorded at floor 5, so the derived baseline recedes to 2.
    store.deleteFromFloor('chat', 5)
    expect(store.latestRunFloor('chat', 'Cadence')).toBe(2)

    // Re-committing floor 5 is due again (5 - 2 >= 3): no separate cadence table to rewind.
    commit(5)
    expect(dispatched).toEqual([2, 5, 5])
  })

  it('ignores disabled Agents and Agents without a trigger', () => {
    const { store, recordRun } = setupStore()
    const dispatched: string[] = []
    const evaluate = createFloorCommitTriggerRuntime({
      catalogAgents: () => [
        { name: 'Disabled', enabled: false, trigger: { onFloorCommitted: { everyNFloors: 1 } } },
        { name: 'NoTrigger', enabled: true },
        { name: 'Live', enabled: true, trigger: { onFloorCommitted: { everyNFloors: 1 } } }
      ],
      latestRunFloor: (chatId, agentName) => store.latestRunFloor(chatId, agentName),
      dispatch: (request) => {
        dispatched.push(request.agent)
        recordRun(request.floor, request.agent)
      },
      isReady: () => true,
      whenReady: () => Promise.resolve()
    })

    // Floor 1 (a real turn) — floor 0 is the greeting commit and is skipped entirely (Finding 6).
    evaluate('p', 'chat', commitEvent(1))
    expect(dispatched).toEqual(['Live'])
  })

  it('defers the first dispatch until the template engine is ready (startup race)', async () => {
    const gate = deferred<void>()
    const dispatched: number[] = []
    const evaluate = createFloorCommitTriggerRuntime({
      catalogAgents: () => [
        { name: 'Cadence', enabled: true, trigger: { onFloorCommitted: { everyNFloors: 1 } } }
      ],
      latestRunFloor: () => null,
      dispatch: (request) => dispatched.push(request.floor),
      isReady: () => false,
      whenReady: () => gate.promise
    })

    evaluate('p', 'chat', commitEvent(1))
    expect(dispatched).toEqual([]) // engine not ready — held, not fired open

    gate.resolve()
    await gate.promise
    await Promise.resolve()
    expect(dispatched).toEqual([1])
  })
})

// ── coalescing + exit-guard signal against the real InvocationRuntime ────────────────────────────────
describe('floor-commit trigger dispatch through the identity path', () => {
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
    const gate = deferred<HarnessExecutionResult>()
    const execute = vi.fn<InvocationHarnessPort['execute']>(() => gate.promise)
    const runtime = createInvocationRuntime({
      catalog: { get: (_p, name) => (name === 'Cadence' ? agent('Cadence') : null) },
      harness: { execute, stop: () => false },
      floor
    })
    return { runtime, execute, gate }
  }

  it('coalesces a trigger dispatch and a manual Run now on the same (chat, floor, Agent)', async () => {
    const { runtime, execute, gate } = setup()
    const evaluate = createFloorCommitTriggerRuntime({
      catalogAgents: () => [
        { name: 'Cadence', enabled: true, trigger: { onFloorCommitted: { everyNFloors: 1 } } }
      ],
      latestRunFloor: () => null,
      dispatch: (request) => void runtime.run(request),
      isReady: () => true,
      whenReady: () => Promise.resolve()
    })

    // Trigger dispatch at floor 7 …
    evaluate('p', 'chat', commitEvent(7))
    // A triggered run is live background work (the exit-guard signal reads this).
    expect(runtime.hasActiveWork()).toBe(true)
    // … and a manual Run now for the SAME floor coalesces onto it.
    const manual = runtime.run({ profileId: 'p', chatId: 'chat', floor: 7, agent: 'Cadence' })
    gate.resolve(success('done'))
    await expect(manual).resolves.toMatchObject({ status: 'succeeded' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(runtime.hasActiveWork()).toBe(false)
  })
})
