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
  lastFloorRow: undefined as unknown
}))

const fakeDb = vi.hoisted(() => ({
  prepare: (sql: string) => {
    seam.prepared.push(sql)
    return {
      run: (...args: unknown[]) => seam.runs.push({ sql, args }),
      get: () => {
        if (sql.includes('COUNT(*)')) return seam.countRow
        if (sql.includes('SELECT request')) return seam.requestRow
        if (sql.includes('ORDER BY floor DESC LIMIT 1')) return seam.lastFloorRow
        return undefined
      },
      all: () => [] as unknown[]
    }
  }
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
  getFloorCount
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

  it('saveFloor refreshes the central chat summary after the row write (§B3)', () => {
    seam.countRow = { n: 1 }
    saveFloor('p1', 'c1', mkLean())
    expect(seam.runs.some((r) => r.sql.includes('UPDATE chats SET floor_count'))).toBe(true)
  })
})
