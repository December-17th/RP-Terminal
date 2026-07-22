import { describe, it, expect, vi, beforeEach } from 'vitest'

// Manual-pass issue 02: `reevaluateVariables` must REPLAY journaled card writes after each floor's
// model fold, so card/panel writes — not re-derivable from response text — survive an MVU
// re-evaluation (e.g. the 命定之诗 start-button choices on floor 0). See
// .scratch/manual-pass-2026-07-04/issues/02-reevaluate-wipes-card-writebacks.md.
//
// The journal is now the general FloorState `floor_operations` log; the legacy `vars_ops` TABLE is
// retained and imported non-destructively by FloorState (`pendingLegacy`), which the last case pins.
//
// This suite used to run against an in-memory `floorService` + `varsOpsService` pair of mocks, which
// forced `floorStateForChat` to null and so exercised a legacy fold that production could never reach
// (a null FloorState means the chat has no session store at all — `getAllFloors` returns [] for it).
// It now runs on a REAL per-chat session database: `test/mocks/betterSqlite3Node` (a
// better-sqlite3-shaped adapter over Node's `node:sqlite`) + the real `SESSION_SCHEMA`, injected by
// overriding `getSessionDbByChat`. `better-sqlite3` itself is deliberately NOT re-mocked so the
// CENTRAL `getDb()` stays on the default no-op stub and nothing touches disk.

let sessionDb: InstanceType<typeof Adapter> | null = null

vi.mock('../src/main/services/sessionDbService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/sessionDbService')>()
  return { ...actual, getSessionDbByChat: () => sessionDb }
})
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import Adapter from './mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../src/main/services/sessionDbService'
import { getAllFloors } from '../src/main/services/floorService'
import {
  applyVariableOps,
  replaceVariablesFromCard,
  reevaluateVariables,
  resetWriteLoopGuard
} from '../src/main/services/generationService'

const addFloor = (floor: number, resp: string, statData: Record<string, unknown> = {}): void => {
  sessionDb!
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES ('c', ?, '2026-07-22T00:00:00.000Z', '', ?, '[]', ?)`
    )
    .run(floor, resp, JSON.stringify({ stat_data: statData }))
}

/** What `chatService.createChat` / `persistFloor` do for a real session: pin the pre-floor-0 state. */
const setBaseline = (statData: Record<string, unknown>): void => {
  sessionDb!
    .prepare(
      'INSERT INTO floor_state_baselines (chat_id, variables, created_at) VALUES (?, ?, ?)'
    )
    .run('c', JSON.stringify({ stat_data: statData }), '2026-07-22T00:00:00.000Z')
}

const statAt = (floor: number): unknown =>
  (getAllFloors('p', 'c').find((f) => f.floor === floor)!.variables as any).stat_data

const deltaAt = (floor: number): unknown =>
  (getAllFloors('p', 'c').find((f) => f.floor === floor)!.variables as any).delta_data

const journal = (): Array<{ floor: number; seq: number; source: string; kind: string }> =>
  sessionDb!
    .prepare('SELECT floor, seq, source, kind FROM floor_operations WHERE chat_id = ? ORDER BY floor, seq')
    .all('c') as never

beforeEach(() => {
  sessionDb = new Adapter(':memory:')
  sessionDb.exec(SESSION_SCHEMA)
  resetWriteLoopGuard('c')
})

describe('reevaluateVariables replays journaled card writes', () => {
  it('a card patch write on floor 0 SURVIVES a re-evaluate (the user-visible bug)', () => {
    // floor 0 has NO <UpdateVariable> block — the model fold rebuilds {}; only the card write seeds it.
    addFloor(0, 'no model block here')
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/主角/choice', value: '剑士' } as any])
    expect(statAt(0)).toEqual({ 主角: { choice: '剑士' } })

    reevaluateVariables('p', 'c')
    // Without replay, re-evaluate would rebuild {} and wipe the choice.
    expect(statAt(0)).toEqual({ 主角: { choice: '剑士' } })
  })

  it('applies the model fold FIRST, then the journaled patch; delta_data = the patch deltas', () => {
    setBaseline({})
    addFloor(0, "<UpdateVariable>\n_.set('hp', 100, 80);\n</UpdateVariable>")
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/gold', value: 5 } as any])

    reevaluateVariables('p', 'c')
    // model fold set hp=80; the card patch then added gold=5 — both present.
    expect(statAt(0)).toEqual({ hp: 80, gold: 5 })
    // delta_data is OVERWRITTEN by the card write's deltas (mirrors live applyVariableOps behavior).
    expect(deltaAt(0)).toEqual([{ path: 'gold', old: undefined, new: 5 }])
  })

  it("a whole-replace write swaps stat_data; a later floor's model fold builds on it (cumulative)", () => {
    addFloor(0, 'no model block')
    addFloor(1, "<UpdateVariable>\n_.set('flag', true);\n</UpdateVariable>")
    // Floor 0: model gives {}, then the card replaces stat_data wholesale.
    replaceVariablesFromCard('p', 'c', 0, { world: '起始' })

    reevaluateVariables('p', 'c')
    expect(statAt(0)).toEqual({ world: '起始' })
    // Floor 1's model fold builds on the REPLACED floor-0 state — cumulative stat carries `world`.
    expect(statAt(1)).toEqual({ world: '起始', flag: true })
  })

  it('replays entries in seq order — two patches to the same path, last wins', () => {
    addFloor(0, 'no model block')
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/x', value: 1 } as any])
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/x', value: 2 } as any])
    expect(journal().map((r) => r.seq)).toEqual([0, 1])

    reevaluateVariables('p', 'c')
    expect(statAt(0)).toEqual({ x: 2 })
  })

  it('does NOT journal a write rejected by the no-op guard', () => {
    addFloor(0, 'no model block', { x: 1 })
    // Same value as already present → no-op guard drops it → nothing journaled.
    expect(applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/x', value: 1 } as any])).toBe(null)
    expect(journal()).toEqual([])
  })

  it('still imports and replays LEGACY vars_ops rows (the table outlived its service module)', () => {
    // varsOpsService.ts is gone, but pre-existing saves still carry vars_ops rows; FloorState
    // imports them lazily (`pendingLegacy`) rather than migrating them up front. A floor-0 replay
    // over an already-applied operation needs the pre-floor baseline (FloorState refuses to infer
    // one from a snapshot the operation already folded into).
    setBaseline({})
    addFloor(0, 'no model block')
    sessionDb!
      .prepare(
        `INSERT INTO vars_ops (chat_id, floor, seq, kind, payload, created_at)
         VALUES ('c', 0, 0, 'patch', ?, '2026-07-04T00:00:00.000Z')`
      )
      .run(JSON.stringify([{ op: 'add', path: '/legacy', value: true }]))

    reevaluateVariables('p', 'c')
    expect(statAt(0)).toEqual({ legacy: true })
    expect(journal()).toEqual([{ floor: 0, seq: 0, source: 'card', kind: 'legacy-patch' }])
  })
})
