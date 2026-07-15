import { describe, it, expect, vi, beforeEach } from 'vitest'

// Suffix replay for reevaluateVariables (perf audit P1-4): a mutation at floor K only invalidates
// K and later — the replay seeds from K-1's STORED stat_data (which is by construction the replay
// of floors 0..K-1) and must not rewrite the untouched prefix.

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
vi.mock('../src/main/services/varsOpsService', () => ({
  appendVarsOp: vi.fn(),
  listVarsOps: vi.fn(() => []),
  deleteVarsOpsFrom: vi.fn()
}))

import * as floorService from '../src/main/services/floorService'
import { reevaluateVariables } from '../src/main/services/generationService'

const mkFloor = (floor: number, resp: string, stat: Record<string, unknown>): any => ({
  floor,
  chat_id: 'c',
  user_message: { content: `u${floor}` },
  response: { content: resp },
  variables: { stat_data: stat, delta_data: [] }
})

beforeEach(() => {
  vi.clearAllMocks()
  floors.length = 0
  // Floors whose stored stat_data is exactly what a full replay of their MVU commands yields.
  floors.push(
    mkFloor(0, "_.set('hp', 0, 10); // init", { hp: 10 }),
    mkFloor(1, "<UpdateVariable>_.set('hp', 10, 20);</UpdateVariable>", { hp: 20 }),
    mkFloor(2, "<UpdateVariable>_.set('hp', 20, 30);</UpdateVariable>", { hp: 30 })
  )
})

describe('reevaluateVariables — suffix replay (perf audit P1-4)', () => {
  it('fromFloor seeds from the previous floor and rewrites ONLY the suffix', () => {
    const out = reevaluateVariables('p', 'c', 2)
    // Only floor 2 was written back.
    expect(vi.mocked(floorService.saveFloor)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(floorService.saveFloor).mock.calls[0][2].floor).toBe(2)
    // The suffix replay seeded hp=20 from floor 1's STORED stat, then applied floor 2's command.
    expect(out[2].variables.stat_data).toEqual({ hp: 30 })
    // The untouched prefix keeps its stored state.
    expect(out[0].variables.stat_data).toEqual({ hp: 10 })
    expect(out[1].variables.stat_data).toEqual({ hp: 20 })
  })

  it('default (fromFloor 0) is the full from-scratch replay writing every floor', () => {
    reevaluateVariables('p', 'c')
    expect(vi.mocked(floorService.saveFloor)).toHaveBeenCalledTimes(3)
  })

  it('an out-of-range fromFloor replays nothing', () => {
    const out = reevaluateVariables('p', 'c', 99)
    expect(vi.mocked(floorService.saveFloor)).not.toHaveBeenCalled()
    expect(out).toHaveLength(3)
  })

  it('INTENDED divergence: suffix replay preserves a manual (un-journaled) edit below fromFloor; full replay wipes it', () => {
    // The Variables-view debug editor (setFloorStatData) writes stored stat_data WITHOUT journaling.
    // A card mutation at floor 2 must not revert the user's edit on untouched floor 1 — but the
    // explicit Re-evaluate button (full replay) recomputes over it, per that editor's contract.
    floors[1].variables.stat_data = { hp: 999 } // manual edit; replaying f1's command would give 20
    floors[2].response.content = "<UpdateVariable>_.set('mp', 0, 5);</UpdateVariable>"

    const suffix = reevaluateVariables('p', 'c', 2)
    expect(suffix[1].variables.stat_data).toEqual({ hp: 999 }) // untouched prefix keeps the edit
    expect(suffix[2].variables.stat_data).toEqual({ hp: 999, mp: 5 }) // suffix seeded FROM the edit

    const full = reevaluateVariables('p', 'c')
    expect(full[1].variables.stat_data).toEqual({ hp: 20 }) // full replay recomputes over the edit
    expect(full[2].variables.stat_data).toEqual({ hp: 20, mp: 5 })
  })
})
