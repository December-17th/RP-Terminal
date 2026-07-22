import { describe, it, expect, vi, beforeEach } from 'vitest'

// Suffix replay for reevaluateVariables (perf audit P1-4): a mutation at floor K only invalidates
// K and later — the replay seeds from K-1's STORED stat_data (which is by construction the replay
// of floors 0..K-1) and must not rewrite the untouched prefix.
//
// Runs on a REAL per-chat session database (`test/mocks/betterSqlite3Node` over `node:sqlite` + the
// real SESSION_SCHEMA, injected by overriding `getSessionDbByChat`), because the replay itself now
// belongs to FloorState. The previous in-memory `floorService` mock forced `floorStateForChat` to
// null and so measured a legacy fold production could never reach.

let sessionDb: InstanceType<typeof Adapter> | null = null

vi.mock('../src/main/services/sessionDbService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/sessionDbService')>()
  return { ...actual, getSessionDbByChat: () => sessionDb }
})
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import Adapter from './mocks/betterSqlite3Node'
import { SESSION_SCHEMA } from '../src/main/services/sessionDbService'
import { reevaluateVariables } from '../src/main/services/generationService'

const addFloor = (floor: number, resp: string, statData: Record<string, unknown>): void => {
  sessionDb!
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, response_content, events, variables)
       VALUES ('c', ?, '2026-07-22T00:00:00.000Z', ?, ?, '[]', ?)`
    )
    .run(floor, `u${floor}`, resp, JSON.stringify({ stat_data: statData, delta_data: [] }))
}

const setStat = (floor: number, statData: Record<string, unknown>): void => {
  sessionDb!
    .prepare('UPDATE floors SET variables = ? WHERE chat_id = ? AND floor = ?')
    .run(JSON.stringify({ stat_data: statData, delta_data: [] }), 'c', floor)
}

const stats = (floors: Array<{ variables: unknown }>): unknown[] =>
  floors.map((f) => (f.variables as any).stat_data)

/** Only a replay that STARTS at floor 0 persists a baseline row — the "prefix was rewritten" probe. */
const replayedFromZero = (): boolean =>
  !!sessionDb!.prepare('SELECT 1 FROM floor_state_baselines WHERE chat_id = ?').get('c')

beforeEach(() => {
  sessionDb = new Adapter(':memory:')
  sessionDb.exec(SESSION_SCHEMA)
  // Floors whose stored stat_data is exactly what a full replay of their MVU commands yields.
  // Floor 0's `_.set` is deliberately UNWRAPPED (no <UpdateVariable> tag), so it contributes no
  // model fold and its stored variables are themselves the pre-transcript baseline.
  addFloor(0, "_.set('hp', 0, 10); // init", { hp: 10 })
  addFloor(1, "<UpdateVariable>_.set('hp', 10, 20);</UpdateVariable>", { hp: 20 })
  addFloor(2, "<UpdateVariable>_.set('hp', 20, 30);</UpdateVariable>", { hp: 30 })
})

describe('reevaluateVariables — suffix replay (perf audit P1-4)', () => {
  it('fromFloor seeds from the previous floor and rewrites ONLY the suffix', () => {
    const out = reevaluateVariables('p', 'c', 2)
    // The suffix replay seeded hp=20 from floor 1's STORED stat, then applied floor 2's command.
    expect(stats(out)).toEqual([{ hp: 10 }, { hp: 20 }, { hp: 30 }])
    // It never restarted at floor 0, so no pre-transcript baseline was inferred/persisted.
    expect(replayedFromZero()).toBe(false)
  })

  it('default (fromFloor 0) is the full from-scratch replay covering every floor', () => {
    reevaluateVariables('p', 'c')
    expect(replayedFromZero()).toBe(true)
  })

  it('an out-of-range fromFloor replays nothing', () => {
    const out = reevaluateVariables('p', 'c', 99)
    expect(out).toHaveLength(3)
    expect(stats(out)).toEqual([{ hp: 10 }, { hp: 20 }, { hp: 30 }])
    expect(replayedFromZero()).toBe(false)
  })

  it('INTENDED divergence: suffix replay preserves a manual (un-journaled) edit below fromFloor; full replay wipes it', () => {
    // The Variables-view debug editor writes stored stat_data; a card mutation at floor 2 must not
    // revert the user's edit on untouched floor 1 — but the explicit Re-evaluate button (full
    // replay) recomputes over it, per that editor's contract.
    setStat(1, { hp: 999 }) // replaying f1's command would give 20
    sessionDb!
      .prepare('UPDATE floors SET response_content = ? WHERE chat_id = ? AND floor = ?')
      .run("<UpdateVariable>_.set('mp', 0, 5);</UpdateVariable>", 'c', 2)

    const suffix = reevaluateVariables('p', 'c', 2)
    expect(stats(suffix)[1]).toEqual({ hp: 999 }) // untouched prefix keeps the edit
    expect(stats(suffix)[2]).toEqual({ hp: 999, mp: 5 }) // suffix seeded FROM the edit

    const full = reevaluateVariables('p', 'c')
    expect(stats(full)[1]).toEqual({ hp: 20 }) // full replay recomputes over the edit
    expect(stats(full)[2]).toEqual({ hp: 20, mp: 5 })
  })
})
