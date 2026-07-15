import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * PM-G4 write-path SPIKE (docs/design/poem-status-parity-design-2026-07-07.md §6): the owner-decided
 * full edit mode lets a card SURFACE write message-floor `stat_data` back. This test PROVES the seam a
 * surface uses — the bare `updateVariablesWith(updater)` runtime global with NO options (default =
 * stat_data scope) — round-trips end to end AND lands as a journaled vars_op that survives an MVU
 * re-evaluate/replay. If a surface edit did NOT journal, a later chat edit/truncate would silently
 * discard it (the manual-pass issue 02 divergence). It does not, so editors can be built on this seam.
 *
 * Faithfulness note: this mirrors the original 状态栏's mvu-data.store.ts (updateField / deleteField),
 * which reads `Mvu.getMvuData()`, `_.set`/`_.unset`s a stat_data path, then writes the WHOLE object
 * back via `Mvu.replaceMvuData`. In our runtime `updateVariablesWith(fn)` (default scope) is the
 * awaitable equivalent: it diffs old→new via replaceStatDataOps and forwards to host.applyVariableOps.
 *
 * Wiring: the runtime's Host.applyVariableOps is bound to the REAL main-side applyVariableOps so the
 * journal + no-op guard + reevaluate replay all run (mocks mirror varsOpsReplay.test.ts).
 */

// In-memory floor store — the REAL applyVariableOps / reevaluateVariables mutate it.
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

// In-memory vars_ops journal (varsOpsService contract), payload JSON-round-tripped like the SQLite blob.
type Row = { floor: number; seq: number; kind: 'patch' | 'replace'; payload: unknown }
const opsStore: Row[] = []
const appendVarsOpMock = vi.fn(
  (_chatId: string, floor: number, kind: 'patch' | 'replace', payload: unknown) => {
    const seq = opsStore.filter((r) => r.floor === floor).reduce((m, r) => Math.max(m, r.seq + 1), 0)
    opsStore.push({ floor, seq, kind, payload: JSON.parse(JSON.stringify(payload)) })
  }
)
vi.mock('../src/main/services/varsOpsService', () => ({
  appendVarsOp: (...a: [string, number, 'patch' | 'replace', unknown]) => appendVarsOpMock(...a),
  listVarsOps: vi.fn(() =>
    [...opsStore].sort((a, b) => a.floor - b.floor || a.seq - b.seq).map((r) => ({ ...r }))
  ),
  deleteVarsOpsFrom: vi.fn()
}))

import { createThRuntime } from '../src/shared/thRuntime'
import type { Host } from '../src/shared/thRuntime/types'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import {
  applyVariableOps as mainApplyVariableOps,
  reevaluateVariables,
  resetWriteLoopGuard
} from '../src/main/services/generationService'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const latest = (): any => floors[floors.length - 1]

// A Host whose stat cache reads floor 0 and whose applyVariableOps drives the REAL main path.
// Everything else is an inert null-host neutral — only statData + the applyVariableOps seam matter here.
function surfaceHost(): Host {
  return {
    ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
    statData: () => clone(latest().variables.stat_data || {}),
    floors: () => floors,
    // THE SEAM under test: forward runtime write ops to the real main applier (journal + guard + persist).
    applyVariableOps: async (ops) => {
      mainApplyVariableOps('p', 'c', latest().floor, ops as any)
    }
  }
}

const mkFloor = (floor: number, resp: string, statData: any): any => ({
  floor,
  user_message: { content: '' },
  response: { content: resp },
  swipes: [resp],
  swipe_id: 0,
  variables: { stat_data: statData }
})

beforeEach(() => {
  floors.length = 0
  opsStore.length = 0
  appendVarsOpMock.mockClear()
  resetWriteLoopGuard('c')
})

describe('PM-G4 surface stat_data write seam (updateVariablesWith, default scope)', () => {
  it('edits a nested leaf → floor stat_data updated AND a vars_op is journaled', async () => {
    floors.push(mkFloor(0, 'no model block', { 主角: { 属性: { 力量: 16 }, 金钱: 100 } }))
    const g = createThRuntime(surfaceHost())

    // writeStat('主角.属性.力量', 18) — exactly what an editor commit does.
    await g.updateVariablesWith((sd: any) => {
      sd.主角.属性.力量 = 18
      return sd
    })

    expect(floors[0].variables.stat_data.主角.属性.力量).toBe(18)
    // sibling untouched
    expect(floors[0].variables.stat_data.主角.金钱).toBe(100)
    // the write was journaled (survives replay); nothing dropped as a no-op
    expect(appendVarsOpMock).toHaveBeenCalledTimes(1)
  })

  it('the edit SURVIVES an MVU re-evaluate (journaled replay, not a phantom)', async () => {
    // floor 0 has no model block; only the card edit seeds 力量=18.
    floors.push(mkFloor(0, 'no model block', { 主角: { 属性: { 力量: 16 } } }))
    const g = createThRuntime(surfaceHost())
    await g.updateVariablesWith((sd: any) => {
      sd.主角.属性.力量 = 18
      return sd
    })

    reevaluateVariables('p', 'c')
    // Without journaled replay, re-evaluate rebuilds from response text and 力量 reverts to 16.
    expect(floors[0].variables.stat_data.主角.属性.力量).toBe(18)
  })

  it('deletes a record entry (背包 item) via the same seam and it round-trips', async () => {
    floors.push(
      mkFloor(0, 'no model block', {
        主角: { 背包: { 治疗药水: { 数量: 3 }, 徽章: { 数量: 1 } } }
      })
    )
    const g = createThRuntime(surfaceHost())

    // deleteStat('主角.背包.治疗药水') — the delete-confirm commit: unset the leaf, write the object back.
    await g.updateVariablesWith((sd: any) => {
      delete sd.主角.背包.治疗药水
      return sd
    })

    expect(floors[0].variables.stat_data.主角.背包.治疗药水).toBeUndefined()
    expect(floors[0].variables.stat_data.主角.背包.徽章).toEqual({ 数量: 1 })

    reevaluateVariables('p', 'c')
    // the deletion is journaled too — it must not resurrect on replay
    expect(floors[0].variables.stat_data.主角.背包.治疗药水).toBeUndefined()
  })

  it('a no-op edit (same value) is NOT journaled (matches the source-side guard)', async () => {
    floors.push(mkFloor(0, 'no model block', { 命运点数: 500 }))
    const g = createThRuntime(surfaceHost())
    await g.updateVariablesWith((sd: any) => {
      sd.命运点数 = 500
      return sd
    })
    expect(appendVarsOpMock).not.toHaveBeenCalled()
  })
})
