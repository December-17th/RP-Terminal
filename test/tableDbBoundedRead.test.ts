import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * P1-5 — the SQL-BOUNDED table reader (`readAllTablesBounded`) that the prompt-injection path uses so a
 * long table is never fully materialized just to keep its newest N rows. The default no-op alias mock
 * can't observe row order, so this suite swaps in the REAL `node:sqlite`-backed adapter (the same one the
 * table-structure suite uses) and asserts the reader returns the LAST N rows in ASCENDING order plus the
 * true total, and that the null / 0 limits mean unbounded / no-query.
 */

// Real SQLite for the sandbox files (overrides the vitest better-sqlite3 alias for this suite).
vi.mock('better-sqlite3', () => import('./mocks/betterSqlite3Node'))

import { TableTemplateSchema, type TableTemplate } from '../src/main/types/tableTemplate'
import {
  instantiate,
  readAllTables,
  readAllTablesBounded
} from '../src/main/services/tableDbService'
import { applySqlBatch } from '../src/main/services/tableSql'

const P = 'boundedReadProfile'
const CHAT = 'chatBounded'
const profileDir = path.join(os.tmpdir(), 'rpt-vitest-data', 'profiles', P)

const tpl = (): TableTemplate =>
  TableTemplateSchema.parse({
    name: 'Bounded',
    tables: [
      {
        uid: 'u',
        displayName: '纪要',
        sqlName: 'chronicle',
        ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY, text TEXT)',
        headers: ['row_id', 'text'],
        initialRows: []
      }
    ]
  })

/** Instantiate the sandbox and insert `n` rows (row_id auto-assigns 1..n, text = r1..rn). */
const seed = (n: number): TableTemplate => {
  const t = tpl()
  instantiate(P, CHAT, t)
  for (let i = 1; i <= n; i++) {
    applySqlBatch(P, CHAT, t, `INSERT INTO chronicle (text) VALUES ('r${i}')`)
  }
  return t
}

beforeEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
})

afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('readAllTablesBounded (P1-5 SQL row cap)', () => {
  it('a positive limit returns the LAST N rows in ASCENDING order + the true total', () => {
    const t = seed(5)
    const [read] = readAllTablesBounded(P, CHAT, t, new Map([['chronicle', 2]]))
    // Newest 2 rows (row_id 4,5), reversed back to ascending; totalRows is the full count.
    expect(read.rows).toEqual([
      [4, 'r4'],
      [5, 'r5']
    ])
    expect(read.rowids).toEqual([4, 5])
    expect(read.totalRows).toBe(5)
  })

  it('a limit >= the row count returns every row ascending (total == rows.length)', () => {
    const t = seed(3)
    const [read] = readAllTablesBounded(P, CHAT, t, new Map([['chronicle', 10]]))
    expect(read.rows).toEqual([
      [1, 'r1'],
      [2, 'r2'],
      [3, 'r3']
    ])
    expect(read.totalRows).toBe(3)
  })

  it('a null limit is UNBOUNDED — every row, no totalRows (matches readAllTables)', () => {
    const t = seed(4)
    const [bounded] = readAllTablesBounded(P, CHAT, t, new Map([['chronicle', null]]))
    const [plain] = readAllTables(P, CHAT, t)
    expect(bounded.rows).toEqual(plain.rows)
    expect(bounded.totalRows).toBeUndefined()
  })

  it('a 0 limit contributes nothing (no query) — empty rows, totalRows 0', () => {
    const t = seed(4)
    const [read] = readAllTablesBounded(P, CHAT, t, new Map([['chronicle', 0]]))
    expect(read.rows).toEqual([])
    expect(read.totalRows).toBe(0)
  })

  it('a missing sandbox → all-empty reads (no throw)', () => {
    const t = tpl() // never instantiated
    const [read] = readAllTablesBounded(P, CHAT, t, new Map([['chronicle', 2]]))
    expect(read.rows).toEqual([])
  })
})
