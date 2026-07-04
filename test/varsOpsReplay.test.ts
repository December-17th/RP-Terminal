import { describe, it, expect, vi, beforeEach } from 'vitest'

// Manual-pass issue 02: reevaluateVariables must REPLAY journaled card writes (vars_ops) after each
// floor's model fold, so card/panel writes — not re-derivable from response text — survive an MVU
// re-evaluation (e.g. the 命定之诗 start-button choices on floor 0). See
// .scratch/manual-pass-2026-07-04/issues/02-reevaluate-wipes-card-writebacks.md.

// In-memory floor store so the REAL reevaluateVariables / applyVariableOps run against it.
const floors: any[] = []
vi.mock('../src/main/services/floorService', () => ({
  getAllFloors: vi.fn(() => floors),
  getFloor: vi.fn((_p: string, _c: string, n: number) => floors.find((f) => f.floor === n)),
  saveFloor: vi.fn((_p: string, _c: string, f: any) => {
    const i = floors.findIndex((x) => x.floor === f.floor)
    if (i >= 0) floors[i] = f
  })
}))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

// In-memory vars_ops journal implementing the varsOpsService contract (appendVarsOp / listVarsOps /
// deleteVarsOpsFrom). Payload is round-tripped through JSON to mirror the real SQLite blob.
type Row = { floor: number; seq: number; kind: 'patch' | 'replace'; payload: unknown }
const opsStore: Row[] = []
const appendVarsOpMock = vi.fn((_chatId: string, floor: number, kind: 'patch' | 'replace', payload: unknown) => {
  const seq = opsStore.filter((r) => r.floor === floor).reduce((m, r) => Math.max(m, r.seq + 1), 0)
  opsStore.push({ floor, seq, kind, payload: JSON.parse(JSON.stringify(payload)) })
})
vi.mock('../src/main/services/varsOpsService', () => ({
  appendVarsOp: (...a: [string, number, 'patch' | 'replace', unknown]) => appendVarsOpMock(...a),
  listVarsOps: vi.fn(() =>
    [...opsStore].sort((a, b) => a.floor - b.floor || a.seq - b.seq).map((r) => ({ ...r }))
  ),
  deleteVarsOpsFrom: vi.fn()
}))

import {
  applyVariableOps,
  replaceVariablesFromCard,
  reevaluateVariables,
  resetWriteLoopGuard
} from '../src/main/services/generationService'

const mkFloor = (floor: number, resp: string): any => ({
  floor,
  user_message: { content: '' },
  response: { content: resp },
  swipes: [resp],
  swipe_id: 0,
  variables: { stat_data: {} }
})

beforeEach(() => {
  floors.length = 0
  opsStore.length = 0
  appendVarsOpMock.mockClear()
  resetWriteLoopGuard('c')
})

describe('reevaluateVariables replays journaled card writes (vars_ops)', () => {
  it('a card patch write on floor 0 SURVIVES a re-evaluate (the user-visible bug)', () => {
    // floor 0 has NO <UpdateVariable> block — the model fold rebuilds {}; only the card write seeds it.
    floors.push(mkFloor(0, 'no model block here'))
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/主角/choice', value: '剑士' } as any])
    expect(floors[0].variables.stat_data).toEqual({ 主角: { choice: '剑士' } })

    reevaluateVariables('p', 'c')
    // Without replay, re-evaluate would rebuild {} and wipe the choice.
    expect(floors[0].variables.stat_data).toEqual({ 主角: { choice: '剑士' } })
  })

  it('applies the model fold FIRST, then the journaled patch; delta_data = the patch deltas', () => {
    floors.push(mkFloor(0, "<UpdateVariable>\n_.set('hp', 100, 80);\n</UpdateVariable>"))
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/gold', value: 5 } as any])

    reevaluateVariables('p', 'c')
    // model fold set hp=80; the card patch then added gold=5 — both present.
    expect(floors[0].variables.stat_data).toEqual({ hp: 80, gold: 5 })
    // delta_data is OVERWRITTEN by the card write's deltas (mirrors live applyVariableOps behavior).
    expect(floors[0].variables.delta_data).toEqual([{ path: 'gold', old: undefined, new: 5 }])
  })

  it("a 'replace' entry swaps stat_data whole; a later floor's model fold builds on it (cumulative)", () => {
    floors.push(mkFloor(0, 'no model block'))
    floors.push(mkFloor(1, "<UpdateVariable>\n_.set('flag', true);\n</UpdateVariable>"))
    // Floor 0: model gives {}, then card replaces stat_data wholesale.
    replaceVariablesFromCard('p', 'c', 0, { world: '起始' })

    reevaluateVariables('p', 'c')
    expect(floors[0].variables.stat_data).toEqual({ world: '起始' })
    // Floor 1's model fold builds on the REPLACED floor-0 state — cumulative stat carries `world`.
    expect(floors[1].variables.stat_data).toEqual({ world: '起始', flag: true })
  })

  it('replays entries in seq order — two patches to the same path, last wins', () => {
    floors.push(mkFloor(0, 'no model block'))
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/x', value: 1 } as any])
    applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/x', value: 2 } as any])

    reevaluateVariables('p', 'c')
    expect(floors[0].variables.stat_data).toEqual({ x: 2 })
  })

  it('does NOT journal a write rejected by the no-op guard', () => {
    floors.push(mkFloor(0, 'no model block'))
    floors[0].variables.stat_data = { x: 1 }
    // Same value as already present → no-op guard drops it → nothing journaled.
    const res = applyVariableOps('p', 'c', 0, [{ op: 'add', path: '/x', value: 1 } as any])
    expect(res).toBe(null)
    expect(appendVarsOpMock).not.toHaveBeenCalled()
  })
})
