import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pins the floor read/write CONTRACT from the 2026-07 performance work (audit P0-2) at the
// SQL seam (the repo aliases better-sqlite3 to a stub, so no real DB opens in tests):
//  - bulk reads are LEAN (project `request` out) while the full/on-demand readers keep it,
//  - counts run COUNT(*) instead of materializing rows,
//  - the upsert PRESERVES a stored request when the incoming floor carries none (lean
//    round-trips through saveFloor must never null the archived prompt).
const seam = vi.hoisted(() => ({
  prepared: [] as string[],
  nextGet: undefined as unknown,
  nextAll: [] as unknown[],
  runs: [] as unknown[][]
}))
vi.mock('../src/main/services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      seam.prepared.push(sql)
      return {
        run: (...args: unknown[]) => seam.runs.push(args),
        get: () => seam.nextGet,
        all: () => seam.nextAll
      }
    }
  }),
  transact: (fn: () => unknown) => fn()
}))

import {
  saveFloor,
  getAllFloors,
  getAllFloorsWithRequests,
  getFloorRequest,
  getFloorCount
} from '../src/main/services/floorService'
import { FloorFile } from '../src/main/types/chat'

const lastSql = (): string => seam.prepared[seam.prepared.length - 1]

beforeEach(() => {
  seam.prepared.length = 0
  seam.runs.length = 0
  seam.nextGet = undefined
  seam.nextAll = []
})

describe('floorService — lean floor projections (perf audit P0-2)', () => {
  it('getAllFloors projects `request` OUT of the bulk read', () => {
    getAllFloors('p1', 'c1')
    expect(lastSql()).not.toMatch(/SELECT \*/)
    expect(lastSql()).not.toMatch(/\brequest\b/)
    // The other floor fields all stay in the projection.
    for (const col of ['response_content', 'variables', 'swipes', 'metrics', 'plot_block'])
      expect(lastSql()).toContain(col)
  })

  it('getAllFloorsWithRequests keeps the full row for the one consumer that needs it', () => {
    getAllFloorsWithRequests('p1', 'c1')
    expect(lastSql()).toMatch(/SELECT \* FROM floors/)
  })

  it('getFloorRequest fetches ONE floor request on demand and parses it', () => {
    seam.nextGet = { request: JSON.stringify([{ role: 'user', content: 'prompt' }]) }
    expect(getFloorRequest('p1', 'c1', 3)).toEqual([{ role: 'user', content: 'prompt' }])
    expect(lastSql()).toMatch(/SELECT request FROM floors WHERE chat_id = \? AND floor = \?/)
    seam.nextGet = undefined
    expect(getFloorRequest('p1', 'c1', 99)).toBeUndefined()
  })

  it('getFloorCount uses COUNT(*) instead of materializing rows', () => {
    seam.nextGet = { n: 7 }
    expect(getFloorCount('p1', 'c1')).toBe(7)
    expect(lastSql()).toMatch(/SELECT COUNT\(\*\)/)
  })

  it('the upsert preserves a stored request when the incoming floor has none', () => {
    const lean = {
      floor: 0,
      chat_id: 'c1',
      timestamp: 't',
      user_message: { content: 'u', timestamp: 't' },
      response: { content: 'a', model: 'm', provider: 'p' },
      events: [],
      variables: {}
    } as unknown as FloorFile
    saveFloor('p1', 'c1', lean)
    // COALESCE keeps the existing column when the bound request parameter is NULL…
    expect(lastSql()).toMatch(/request = COALESCE\(excluded\.request, floors\.request\)/)
    // …and a request-less floor binds NULL (never the string "undefined"/"null").
    expect(seam.runs[0]).toContain(null)
    // A floor WITH a request binds the JSON (the regenerate/swipe overwrite path).
    saveFloor('p1', 'c1', {
      ...lean,
      request: [{ role: 'user', content: 'NEW' }]
    } as FloorFile)
    expect(seam.runs[1]).toContain(JSON.stringify([{ role: 'user', content: 'NEW' }]))
  })
})
