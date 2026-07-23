import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pins the floor read/write CONTRACT from the 2026-07 performance work (audit P0-2), post-merge
// with the decentralized save system (floors live in PER-SESSION stores via getSessionDbByChat;
// the central db only holds the denormalized chat summary):
//  - bulk reads are LEAN (project `request` out) while the full/on-demand readers keep it,
//  - counts run COUNT(*) instead of materializing rows,
//  - the upsert PRESERVES a stored request when the incoming floor carries none (lean
//    round-trips through saveFloor must never null the archived prompt).
const seam = vi.hoisted(() => ({
  prepared: [] as string[],
  runs: [] as Array<{ sql: string; args: unknown[] }>,
  requestRow: undefined as unknown,
  countRow: { n: 0 } as unknown,
  lastFloorRow: undefined as unknown,
  floorRow: undefined as unknown,
  floorExists: false
}))

const fakeDb = vi.hoisted(() => ({
  prepare: (sql: string) => {
    seam.prepared.push(sql)
    return {
      run: (...args: unknown[]) => seam.runs.push({ sql, args }),
      get: () => {
        if (sql.includes('SELECT 1 FROM floors'))
          return seam.floorExists ? { present: 1 } : undefined
        if (sql.includes('COUNT(*)')) return seam.countRow
        if (sql.includes('SELECT request')) return seam.requestRow
        if (sql.includes('SELECT * FROM floors WHERE chat_id')) return seam.floorRow
        if (sql.includes('ORDER BY floor DESC LIMIT 1')) return seam.lastFloorRow
        return undefined
      },
      all: () => [] as unknown[]
    }
  },
  // FloorState owns every floor-row write now (including the Yuzu annotation below), so the fake
  // store has to answer the two calls `createFloorState` makes on construction / in a transaction.
  exec: () => {},
  transaction: (fn: () => unknown) => fn
}))

vi.mock('../src/main/services/db', () => ({
  getDb: () => fakeDb,
  transact: (fn: () => unknown) => fn()
}))
vi.mock('../src/main/services/sessionDbService', () => ({
  getSessionDbByChat: () => fakeDb
}))

import {
  saveFloor,
  getAllFloors,
  getAllFloorsWithRequests,
  getFloorRequest,
  getFloorCount,
  getLatestFloor,
  updateActiveFloorResponse
} from '../src/main/services/floorService'
import { FloorFile } from '../src/main/types/chat'

const lastSql = (): string => seam.prepared[seam.prepared.length - 1]

const mkLean = (): FloorFile =>
  ({
    floor: 0,
    chat_id: 'c1',
    timestamp: 't',
    user_message: { content: 'u', timestamp: 't' },
    response: { content: 'a', model: 'm', provider: 'p' },
    events: [],
    variables: {}
  }) as unknown as FloorFile

beforeEach(() => {
  seam.prepared.length = 0
  seam.runs.length = 0
  seam.requestRow = undefined
  seam.countRow = { n: 0 }
  seam.lastFloorRow = undefined
  seam.floorRow = undefined
  seam.floorExists = false
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
    seam.requestRow = { request: JSON.stringify([{ role: 'user', content: 'prompt' }]) }
    expect(getFloorRequest('p1', 'c1', 3)).toEqual([{ role: 'user', content: 'prompt' }])
    expect(lastSql()).toMatch(/SELECT request FROM floors WHERE chat_id = \? AND floor = \?/)
    seam.requestRow = undefined
    expect(getFloorRequest('p1', 'c1', 99)).toBeUndefined()
  })

  it('getFloorCount uses COUNT(*) instead of materializing rows', () => {
    seam.countRow = { n: 7 }
    expect(getFloorCount('p1', 'c1')).toBe(7)
    expect(lastSql()).toMatch(/SELECT COUNT\(\*\)/)
  })

  it('getLatestFloor fetches ONLY the last floor with a lean, single-row query', () => {
    seam.lastFloorRow = {
      floor: 5,
      chat_id: 'c1',
      timestamp: 't',
      user_content: 'u',
      user_timestamp: 't',
      response_content: 'a',
      response_model: 'm',
      response_provider: 'p',
      swipes: JSON.stringify(['a']),
      swipe_id: 0,
      events: '[]',
      variables: JSON.stringify({ stat_data: { hp: 9 } }),
      metrics: null,
      plot_block: null
    }
    const latest = getLatestFloor('p1', 'c1')
    expect(latest?.floor).toBe(5)
    expect(latest?.variables).toEqual({ stat_data: { hp: 9 } })
    // ORDER BY floor DESC LIMIT 1, and lean (no `request` column / no SELECT *).
    expect(lastSql()).toMatch(/ORDER BY floor DESC LIMIT 1/)
    expect(lastSql()).not.toMatch(/SELECT \*/)
    expect(lastSql()).not.toMatch(/\brequest\b/)
  })

  it('getLatestFloor returns null on an empty chat (mirrors `.at(-1)` on `[]`)', () => {
    seam.lastFloorRow = undefined
    expect(getLatestFloor('p1', 'c1')).toBeNull()
  })

  it('the upsert preserves a stored request when the incoming floor has none', () => {
    saveFloor('p1', 'c1', mkLean())
    const upserts = seam.runs.filter((r) => r.sql.includes('INSERT INTO floors'))
    // COALESCE keeps the existing column when the bound request parameter is NULL…
    expect(upserts[0].sql).toMatch(/request = COALESCE\(excluded\.request, floors\.request\)/)
    // …and a request-less floor binds NULL (never the string "undefined"/"null").
    expect(upserts[0].args).toContain(null)
    // A floor WITH a request binds the JSON (the regenerate/swipe overwrite path).
    saveFloor('p1', 'c1', {
      ...mkLean(),
      request: [{ role: 'user', content: 'NEW' }]
    } as FloorFile)
    const upserts2 = seam.runs.filter((r) => r.sql.includes('INSERT INTO floors'))
    expect(upserts2[1].args).toContain(JSON.stringify([{ role: 'user', content: 'NEW' }]))
  })

  it('reports a floor commit only for the first write of that floor identity', () => {
    const committed = vi.fn()
    saveFloor('p1', 'c1', mkLean(), committed)
    expect(committed).toHaveBeenCalledWith(true)

    seam.floorExists = true
    saveFloor('p1', 'c1', mkLean(), committed)
    expect(committed).toHaveBeenLastCalledWith(false)
    expect(committed).toHaveBeenCalledTimes(2)
  })

  it('saveFloor refreshes the central chat summary after the row write (§B3)', () => {
    seam.countRow = { n: 1 }
    saveFloor('p1', 'c1', mkLean())
    expect(seam.runs.some((r) => r.sql.includes('UPDATE chats SET floor_count'))).toBe(true)
  })

  it('Yuzu annotation replaces response text and the active swipe without replaying variables', () => {
    seam.floorRow = {
      floor: 2,
      chat_id: 'c1',
      timestamp: 't',
      user_content: 'u',
      user_timestamp: 't',
      response_content: 'active',
      response_model: 'm',
      response_provider: 'p',
      swipes: JSON.stringify(['old', 'active']),
      swipe_id: 1,
      events: '[]',
      variables: JSON.stringify({ stat_data: { hp: 5 } }),
      request: null,
      metrics: null,
      plot_block: null
    }
    const updated = updateActiveFloorResponse('p1', 'c1', 2, '<| block |>\nactive\n<| end |>')
    expect(updated?.response.content).toContain('<| block |>')
    expect(updated?.swipes).toEqual(['old', '<| block |>\nactive\n<| end |>'])
    // Routed through FloorState's transcript write (refold: false) — same columns, no replay.
    const write = seam.runs.find((run) => run.sql.includes('UPDATE floors SET'))
    expect(write?.args).toEqual([
      null, // user_content untouched
      '<| block |>\nactive\n<| end |>',
      1,
      JSON.stringify(['old', '<| block |>\nactive\n<| end |>']),
      1,
      1,
      'c1',
      2
    ])
    expect(write?.sql).not.toContain('variables')
  })
})
