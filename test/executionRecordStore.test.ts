import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Execution-record persistence + rolling retention (st-preset-compat issue 09). This suite observes
 * REAL SQLite via the node:sqlite-backed adapter (the retention prune uses a `NOT IN (SELECT … LIMIT)`
 * subquery whose behavior a no-op mock can't verify). The session handle + the floor-request lookup
 * (used to rehydrate the stripped `wire`) are mocked onto that in-memory DB / a canned request.
 */

vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))

const hoisted = vi.hoisted(() => ({
  db: undefined as any,
  request: undefined as unknown
}))

vi.mock('../src/main/services/sessionDbService', () => ({
  getSessionDbByChat: () => hoisted.db
}))
vi.mock('../src/main/services/floorService', () => ({
  getFloorRequest: () => hoisted.request
}))

import Adapter from './mocks/betterSqlite3Node'
import {
  saveExecutionRecord,
  getExecutionRecord,
  pruneExecutionRecords,
  listExecutionRecordFloors
} from '../src/main/services/executionRecordStore'
import { ExecutionRecord, EXECUTION_RECORD_VERSION } from '../src/shared/executionRecord'

const CHAT = 'c1'

/** A record fixture with a fat `wire` (the part that must NOT be double-stored) + a couple entries. */
const mkRecord = (floor: number): ExecutionRecord => ({
  version: EXECUTION_RECORD_VERSION,
  createdAt: `2026-07-17T00:00:0${floor}.000Z`,
  entries: [
    { seq: 0, stage: 'marker-expand', source: { kind: 'marker', id: 'char_description' }, role: 'system' },
    { seq: 1, stage: 'macro', source: { kind: 'preset-block', id: 'lit' } }
  ],
  wire: [
    { role: 'system', content: 'X'.repeat(5000) },
    { role: 'user', content: `floor ${floor} action` }
  ],
  stats: { entries: 2, bytes: 42000, buildMs: 3 }
})

beforeEach(() => {
  hoisted.db = new Adapter(':memory:')
  hoisted.db.exec(
    `CREATE TABLE execution_records (
       chat_id TEXT NOT NULL,
       floor INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       record TEXT NOT NULL,
       PRIMARY KEY (chat_id, floor)
     )`
  )
  hoisted.request = undefined
})

const storedJson = (floor: number): string =>
  hoisted.db
    .prepare('SELECT record FROM execution_records WHERE chat_id = ? AND floor = ?')
    .get(CHAT, floor).record as string

describe('executionRecordStore — dedup (wire is not double-stored)', () => {
  it('strips `wire` from the persisted row (it lives once in the floor request)', () => {
    saveExecutionRecord(CHAT, 1, mkRecord(1), 50)
    const raw = storedJson(1)
    expect(raw).not.toContain('XXXXX') // the 5 KB wire body is gone
    const parsed = JSON.parse(raw)
    expect(parsed).not.toHaveProperty('wire')
    // …but the forensic delta is intact.
    expect(parsed.version).toBe(EXECUTION_RECORD_VERSION)
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.stats.bytes).toBe(42000)
  })

  it('rehydrates `wire` from the floor request on read', () => {
    saveExecutionRecord(CHAT, 1, mkRecord(1), 50)
    hoisted.request = [
      { role: 'system', content: 'the real assembled system prompt' },
      { role: 'user', content: 'the real user turn' }
    ]
    const rec = getExecutionRecord('p1', CHAT, 1)
    expect(rec).not.toBeNull()
    expect(rec!.wire).toEqual([
      { role: 'system', content: 'the real assembled system prompt' },
      { role: 'user', content: 'the real user turn' }
    ])
    expect(rec!.entries).toHaveLength(2)
  })

  it('returns null for a floor with no record; empty wire when the floor request is gone', () => {
    expect(getExecutionRecord('p1', CHAT, 99)).toBeNull()
    saveExecutionRecord(CHAT, 2, mkRecord(2), 50)
    hoisted.request = undefined // floor truncated / aborted gen
    const rec = getExecutionRecord('p1', CHAT, 2)
    expect(rec!.wire).toEqual([])
    expect(rec!.entries).toHaveLength(2)
  })

  it('upserts (a regenerate of the same floor replaces its record)', () => {
    saveExecutionRecord(CHAT, 1, mkRecord(1), 50)
    const updated = { ...mkRecord(1), createdAt: '2026-07-17T09:09:09.000Z' }
    saveExecutionRecord(CHAT, 1, updated, 50)
    expect(listExecutionRecordFloors(CHAT)).toEqual([1])
    expect(JSON.parse(storedJson(1)).createdAt).toBe('2026-07-17T09:09:09.000Z')
  })
})

describe('executionRecordStore — rolling retention', () => {
  it('keeps only the N most-recent records (by floor); prunes the oldest past the cap', () => {
    for (let f = 1; f <= 5; f++) saveExecutionRecord(CHAT, f, mkRecord(f), 3)
    // Cap 3 → floors 3,4,5 survive; 1,2 pruned.
    expect(listExecutionRecordFloors(CHAT)).toEqual([3, 4, 5])
    // A sixth generation slides the window forward.
    saveExecutionRecord(CHAT, 6, mkRecord(6), 3)
    expect(listExecutionRecordFloors(CHAT)).toEqual([4, 5, 6])
  })

  it('ranks by the floors that actually have records (robust to gaps)', () => {
    for (const f of [2, 5, 9]) saveExecutionRecord(CHAT, f, mkRecord(f), 2)
    expect(listExecutionRecordFloors(CHAT)).toEqual([5, 9]) // the 2 highest, not a contiguous range
  })

  it('retention 0 (disabled) keeps none', () => {
    saveExecutionRecord(CHAT, 1, mkRecord(1), 0)
    expect(listExecutionRecordFloors(CHAT)).toEqual([])
  })

  it('pruneExecutionRecords can be called directly to trim an existing window', () => {
    for (let f = 1; f <= 4; f++) saveExecutionRecord(CHAT, f, mkRecord(f), 50)
    expect(listExecutionRecordFloors(CHAT)).toEqual([1, 2, 3, 4])
    pruneExecutionRecords(CHAT, 2)
    expect(listExecutionRecordFloors(CHAT)).toEqual([3, 4])
  })
})

describe('executionRecordStore — no session store', () => {
  it('all ops no-op / return empty when the chat has no session DB', () => {
    hoisted.db = null
    expect(() => saveExecutionRecord(CHAT, 1, mkRecord(1), 50)).not.toThrow()
    expect(() => pruneExecutionRecords(CHAT, 50)).not.toThrow()
    expect(getExecutionRecord('p1', CHAT, 1)).toBeNull()
    expect(listExecutionRecordFloors(CHAT)).toEqual([])
  })
})
