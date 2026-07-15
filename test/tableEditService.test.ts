import { describe, it, expect, beforeEach, vi } from 'vitest'

// Pure edit-SQL builders + the applyEdit wrapper (issue 06). Execution is NOT tested (better-sqlite3
// is alias-mocked — same stance as tableSql/tableOps); we mock the ONE write path (applySqlBatch +
// appendOps + the write lock + floorService) and pin: the BUILT sql is what applySqlBatch runs, floor
// attribution, lock busy → error result, error propagation, and that the lock is always released.

const sqlSvc = vi.hoisted(() => ({
  applySqlBatch: vi.fn(),
  TableSqlError: class TableSqlError extends Error {
    index: number
    constructor(message: string, index = -1) {
      super(message)
      this.name = 'TableSqlError'
      this.index = index
    }
  }
}))
vi.mock('../src/main/services/tableSql', () => sqlSvc)

const opsSvc = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(),
  endTableWrite: vi.fn()
}))
vi.mock('../src/main/services/tableOpsService', () => opsSvc)

const floorSvc = vi.hoisted(() => {
  const getAllFloors = vi.fn()
  // Count-only reads go through getFloorCount now — keep it slaved to the same fixture.
  return {
    getAllFloors,
    getFloorCount: vi.fn(() => (getAllFloors() as unknown[] | undefined)?.length ?? 0),
    getFloorRequest: vi.fn(() => undefined)
  }
})
vi.mock('../src/main/services/floorService', () => floorSvc)

import {
  sqlQuote,
  buildCellUpdate,
  buildRowInsert,
  buildRowDelete,
  buildTableReset,
  buildEditSql,
  applyEdit
} from '../src/main/services/tableEditService'
import { TableTemplateSchema, TableTemplate } from '../src/main/types/tableTemplate'

const template = (sqlName = 't'): TableTemplate =>
  TableTemplateSchema.parse({
    name: 'x',
    sourceFormat: 'native',
    tables: [
      { uid: 'u', displayName: 'D', sqlName, ddl: `CREATE TABLE ${sqlName} (row_id INTEGER, v TEXT);`, headers: ['row_id', 'v'] }
    ]
  })

describe('sqlQuote', () => {
  it('wraps in single quotes and doubles embedded quotes', () => {
    expect(sqlQuote('hello')).toBe("'hello'")
    expect(sqlQuote("o'clock")).toBe("'o''clock'")
    expect(sqlQuote("''")).toBe("''''''")
  })
  it('preserves CJK content verbatim', () => {
    expect(sqlQuote('艾莉亚在王城')).toBe("'艾莉亚在王城'")
  })
})

describe('buildCellUpdate', () => {
  it('builds a rowid-targeted UPDATE with a quoted value (CJK values survive quoting)', () => {
    // The COLUMN is the real sandbox column (ASCII, from the DDL — resolved main-side from an index);
    // the VALUE may be arbitrary text including CJK + embedded quotes.
    expect(buildCellUpdate('chronicle', 'summary', 7, "艾莉亚's here")).toBe(
      `UPDATE "chronicle" SET "summary" = '艾莉亚''s here' WHERE rowid = 7`
    )
  })
  it('rejects an unsafe column name', () => {
    expect(() => buildCellUpdate('t', 'a; DROP', 1, 'x')).toThrow()
  })
  it('rejects an unsafe table name', () => {
    expect(() => buildCellUpdate('t; DROP', 'v', 1, 'x')).toThrow()
  })
  it('rejects a non-integer / negative rowid', () => {
    expect(() => buildCellUpdate('t', 'v', 1.5, 'x')).toThrow()
    expect(() => buildCellUpdate('t', 'v', -1, 'x')).toThrow()
  })
})

describe('buildRowInsert', () => {
  it('positional INSERT with NULL for null cells and quoted literals otherwise', () => {
    expect(buildRowInsert('t', [null, 'a', "b'c"])).toBe(
      `INSERT INTO "t" VALUES (NULL, 'a', 'b''c')`
    )
  })
  it('rejects an unsafe table name', () => {
    expect(() => buildRowInsert('t;x', ['a'])).toThrow()
  })
})

describe('buildRowDelete / buildTableReset', () => {
  it('DELETE by rowid', () => {
    expect(buildRowDelete('t', 3)).toBe(`DELETE FROM "t" WHERE rowid = 3`)
  })
  it('reset = DELETE FROM (op-logged clear)', () => {
    expect(buildTableReset('t')).toBe(`DELETE FROM "t"`)
  })
  it('reject unsafe names / rowids', () => {
    expect(() => buildRowDelete('t', -1)).toThrow()
    expect(() => buildTableReset('t;x')).toThrow()
  })
})

describe('buildEditSql (dispatch)', () => {
  it('cell requires column + rowid', () => {
    expect(() => buildEditSql({ kind: 'cell', table: 't', value: 'x' })).toThrow()
  })
  it('delete requires a rowid', () => {
    expect(() => buildEditSql({ kind: 'delete', table: 't' })).toThrow()
  })
  it('dispatches each kind', () => {
    expect(buildEditSql({ kind: 'cell', table: 't', column: 'v', rowid: 1, value: 'a' })).toContain('UPDATE')
    expect(buildEditSql({ kind: 'insert', table: 't', values: [null, 'a'] })).toContain('INSERT')
    expect(buildEditSql({ kind: 'delete', table: 't', rowid: 2 })).toContain('DELETE FROM "t" WHERE')
    expect(buildEditSql({ kind: 'reset', table: 't' })).toBe('DELETE FROM "t"')
  })
})

describe('applyEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    opsSvc.tryBeginTableWrite.mockReturnValue(true)
    floorSvc.getAllFloors.mockReturnValue([{}, {}, {}]) // 3 floors → attribute at index 2
    sqlSvc.applySqlBatch.mockReturnValue({ applied: 1, changes: 1, statements: [`DELETE FROM "t" WHERE rowid = 5`] })
  })

  it('runs the BUILT sql through applySqlBatch and logs the applied statements at the last floor', () => {
    const res = applyEdit('p', 'c', template(), { kind: 'delete', table: 't', rowid: 5 })
    expect(res).toEqual({ ok: true, changes: 1 })
    // applySqlBatch received the exact built statement.
    expect(sqlSvc.applySqlBatch).toHaveBeenCalledWith('p', 'c', expect.anything(), `DELETE FROM "t" WHERE rowid = 5`)
    // ops logged at floor 2 (length-1) with the statements the service reported.
    // Single-floor hand edit: from_floor = its own floor (2).
    expect(opsSvc.appendOps).toHaveBeenCalledWith('p', 'c', 2, [`DELETE FROM "t" WHERE rowid = 5`], 'edit', 2)
    expect(opsSvc.endTableWrite).toHaveBeenCalledWith('c')
  })

  it('clamps floor attribution to 0 for an empty chat', () => {
    floorSvc.getAllFloors.mockReturnValue([])
    sqlSvc.applySqlBatch.mockReturnValue({ applied: 1, changes: 1, statements: ['DELETE FROM "t"'] })
    applyEdit('p', 'c', template(), { kind: 'reset', table: 't' })
    expect(opsSvc.appendOps).toHaveBeenCalledWith('p', 'c', 0, ['DELETE FROM "t"'], 'edit', 0)
  })

  it('returns an error result (no throw) when the lock is busy — and does not run sql', () => {
    opsSvc.tryBeginTableWrite.mockReturnValue(false)
    const res = applyEdit('p', 'c', template(), { kind: 'reset', table: 't' })
    expect('error' in res).toBe(true)
    expect(sqlSvc.applySqlBatch).not.toHaveBeenCalled()
    expect(opsSvc.endTableWrite).not.toHaveBeenCalled() // never claimed → nothing to release
  })

  it('propagates a SQLite/validation error as an error result and releases the lock', () => {
    sqlSvc.applySqlBatch.mockImplementation(() => {
      throw new sqlSvc.TableSqlError('CHECK constraint failed', 0)
    })
    const res = applyEdit('p', 'c', template(), { kind: 'cell', table: 't', column: 'v', rowid: 1, value: 'x' })
    expect(res).toEqual({ error: 'CHECK constraint failed' })
    expect(opsSvc.appendOps).not.toHaveBeenCalled()
    expect(opsSvc.endTableWrite).toHaveBeenCalledWith('c')
  })

  it('returns an error result for a malformed op WITHOUT taking the lock', () => {
    const res = applyEdit('p', 'c', template(), { kind: 'cell', table: 't', value: 'x' })
    expect('error' in res).toBe(true)
    expect(opsSvc.tryBeginTableWrite).not.toHaveBeenCalled()
  })

  it('does not append ops when applySqlBatch reports zero statements', () => {
    sqlSvc.applySqlBatch.mockReturnValue({ applied: 0, changes: 0, statements: [] })
    applyEdit('p', 'c', template(), { kind: 'reset', table: 't' })
    expect(opsSvc.appendOps).not.toHaveBeenCalled()
  })
})
