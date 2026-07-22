import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * PM-G4 write-path SPIKE (docs/design/poem-status-parity-design-2026-07-07.md §6): the owner-decided
 * full edit mode lets a card SURFACE write message-floor `stat_data` back. This test PROVES the seam a
 * surface uses — the bare `updateVariablesWith(updater)` runtime global with NO options (default =
 * stat_data scope) — round-trips end to end AND lands as a journaled floor operation that survives an
 * MVU re-evaluate/replay. If a surface edit did NOT journal, a later chat edit/truncate would silently
 * discard it (the manual-pass issue 02 divergence). It does not, so editors can be built on this seam.
 *
 * Faithfulness note: this mirrors the original 状态栏's mvu-data.store.ts (updateField / deleteField),
 * which reads `Mvu.getMvuData()`, `_.set`/`_.unset`s a stat_data path, then writes the WHOLE object
 * back via `Mvu.replaceMvuData`. In our runtime `updateVariablesWith(fn)` (default scope) is the
 * awaitable equivalent: it diffs old→new via replaceStatDataOps and forwards to host.applyVariableOps.
 *
 * Wiring: the runtime's Host.applyVariableOps is bound to the REAL main-side applyVariableOps, running
 * against a REAL per-chat session database (`test/mocks/betterSqlite3Node` over `node:sqlite` + the
 * real SESSION_SCHEMA, injected by overriding `getSessionDbByChat`), so the journal + no-op guard +
 * replay all run for real. `better-sqlite3` itself is NOT re-mocked, so the CENTRAL `getDb()` stays on
 * the default no-op stub and nothing touches disk.
 */

let sessionDb: InstanceType<typeof Adapter> | null = null

vi.mock('../src/main/services/sessionDbService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/sessionDbService')>()
  return { ...actual, getSessionDbByChat: () => sessionDb }
})
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import Adapter from './mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../src/main/services/sessionDbService'
import { getAllFloors } from '../src/main/services/floorService'
import { createThRuntime } from '../src/shared/thRuntime'
import type { Host } from '../src/shared/thRuntime/types'
import { createNullHost } from '../src/shared/thRuntime/nullHost'
import {
  applyVariableOps as mainApplyVariableOps,
  reevaluateVariables,
  resetWriteLoopGuard
} from '../src/main/services/generationService'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const floors = (): any[] => getAllFloors('p', 'c')
const latest = (): any => floors().at(-1)
const statData = (): any => latest().variables.stat_data

const journal = (): Array<{ floor: number; seq: number; source: string; kind: string }> =>
  sessionDb!
    .prepare(
      'SELECT floor, seq, source, kind FROM floor_operations WHERE chat_id = ? ORDER BY floor, seq'
    )
    .all('c') as never

// A Host whose stat cache reads the latest floor and whose applyVariableOps drives the REAL main path.
// Everything else is an inert null-host neutral — only statData + the applyVariableOps seam matter here.
function surfaceHost(): Host {
  return {
    ...createNullHost({ profileId: 'p', chatId: 'c', characterId: 'ch' }),
    statData: () => clone(statData() || {}),
    floors: () => floors(),
    // THE SEAM under test: forward runtime write ops to the real main applier (journal + guard + persist).
    applyVariableOps: async (ops) => {
      mainApplyVariableOps('p', 'c', latest().floor, ops as any)
    }
  }
}

const addFloor = (floor: number, resp: string, stat: Record<string, unknown>): void => {
  sessionDb!
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES ('c', ?, '2026-07-22T00:00:00.000Z', '', ?, '[]', ?)`
    )
    .run(floor, resp, JSON.stringify({ stat_data: stat }))
}

beforeEach(() => {
  sessionDb = new Adapter(':memory:')
  sessionDb.exec(SESSION_SCHEMA)
  resetWriteLoopGuard('c')
})

describe('PM-G4 surface stat_data write seam (updateVariablesWith, default scope)', () => {
  it('edits a nested leaf → floor stat_data updated AND the write is journaled', async () => {
    addFloor(0, 'no model block', { 主角: { 属性: { 力量: 16 }, 金钱: 100 } })
    const g = createThRuntime(surfaceHost())

    // writeStat('主角.属性.力量', 18) — exactly what an editor commit does.
    await g.updateVariablesWith((sd: any) => {
      sd.主角.属性.力量 = 18
      return sd
    })

    expect(statData().主角.属性.力量).toBe(18)
    // sibling untouched
    expect(statData().主角.金钱).toBe(100)
    // the write was journaled (survives replay); nothing dropped as a no-op
    expect(journal()).toEqual([{ floor: 0, seq: 0, source: 'card', kind: 'patch' }])
  })

  it('the edit SURVIVES an MVU re-evaluate (journaled replay, not a phantom)', async () => {
    // floor 0 has no model block; only the card edit seeds 力量=18.
    addFloor(0, 'no model block', { 主角: { 属性: { 力量: 16 } } })
    const g = createThRuntime(surfaceHost())
    await g.updateVariablesWith((sd: any) => {
      sd.主角.属性.力量 = 18
      return sd
    })

    reevaluateVariables('p', 'c')
    // Without journaled replay, re-evaluate rebuilds from response text and 力量 reverts to 16.
    expect(statData().主角.属性.力量).toBe(18)
  })

  it('deletes a record entry (背包 item) via the same seam and it round-trips', async () => {
    addFloor(0, 'no model block', {
      主角: { 背包: { 治疗药水: { 数量: 3 }, 徽章: { 数量: 1 } } }
    })
    const g = createThRuntime(surfaceHost())

    // deleteStat('主角.背包.治疗药水') — the delete-confirm commit: unset the leaf, write the object back.
    await g.updateVariablesWith((sd: any) => {
      delete sd.主角.背包.治疗药水
      return sd
    })

    expect(statData().主角.背包.治疗药水).toBeUndefined()
    expect(statData().主角.背包.徽章).toEqual({ 数量: 1 })

    reevaluateVariables('p', 'c')
    // the deletion is journaled too — it must not resurrect on replay
    expect(statData().主角.背包.治疗药水).toBeUndefined()
  })

  it('a no-op edit (same value) is NOT journaled (matches the source-side guard)', async () => {
    addFloor(0, 'no model block', { 命运点数: 500 })
    const g = createThRuntime(surfaceHost())
    await g.updateVariablesWith((sd: any) => {
      sd.命运点数 = 500
      return sd
    })
    expect(journal()).toEqual([])
  })
})
