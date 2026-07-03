import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  sandboxDbPath,
  buildDdlPlan,
  templateSqlNames,
  buildInitialInsert,
  unifyDisplayColumns
} from '../src/main/services/tableDbService'
import { getAppDir } from '../src/main/services/storageService'
import { TableTemplateSchema, TableTemplate } from '../src/main/types/tableTemplate'

// Only the PURE helpers are tested here — better-sqlite3 is stubbed to a no-op under vitest, so the
// SQL wrappers (instantiate/read/remove) are runtime-validated only, mirroring floorService's stance.

const template = (partial: any): TableTemplate =>
  TableTemplateSchema.parse({ name: 't', sourceFormat: 'native', ...partial })

const table = (over: any): any => ({
  uid: over.uid ?? 'u',
  displayName: over.displayName ?? 'D',
  sqlName: over.sqlName,
  ddl: over.ddl,
  headers: over.headers ?? [],
  initialRows: over.initialRows ?? [],
  ...over
})

describe('sandboxDbPath', () => {
  it('lives under the profile in its own table-dbs dir, not the app DB', () => {
    const p = sandboxDbPath('prof1', 'chatA')
    expect(p).toBe(path.join(getAppDir(), 'profiles', 'prof1', 'table-dbs', 'chatA.sqlite'))
    expect(p).not.toContain('rpterminal.db')
  })
})

describe('buildDdlPlan', () => {
  it('returns sqlName+ddl for each table when names agree', () => {
    const tpl = template({
      tables: [
        table({ sqlName: 'a', ddl: 'CREATE TABLE a (x INT);' }),
        table({ sqlName: 'b', ddl: 'CREATE TABLE b (y INT);' })
      ]
    })
    expect(buildDdlPlan(tpl)).toEqual([
      { sqlName: 'a', ddl: 'CREATE TABLE a (x INT);' },
      { sqlName: 'b', ddl: 'CREATE TABLE b (y INT);' }
    ])
  })

  it('throws when a DDL name disagrees with the registered sqlName (defense in depth)', () => {
    const tpl = template({
      tables: [table({ sqlName: 'a', ddl: 'CREATE TABLE different (x INT);' })]
    })
    expect(() => buildDdlPlan(tpl)).toThrow(/!=/)
  })

  it('throws when a DDL is not a single CREATE TABLE', () => {
    const tpl = template({
      tables: [table({ sqlName: 'a', ddl: 'CREATE TABLE a (x INT); DROP TABLE a;' })]
    })
    expect(() => buildDdlPlan(tpl)).toThrow()
  })
})

describe('templateSqlNames', () => {
  it('is the interpolation allowlist of table names', () => {
    const tpl = template({
      tables: [
        table({ sqlName: 'a', ddl: 'CREATE TABLE a (x INT);' }),
        table({ sqlName: 'b', ddl: 'CREATE TABLE b (y INT);' })
      ]
    })
    expect(templateSqlNames(tpl)).toEqual(new Set(['a', 'b']))
  })
})

describe('buildInitialInsert', () => {
  it('builds a purely positional insert — headers are DISPLAY names, never interpolated', () => {
    // Real chatSheets headers are display labels (row_id + Chinese names), NOT the DDL's column
    // names — the insert must be positional (`VALUES (?, …)`) or Chinese-header templates would
    // silently drop every initial row.
    const t = table({
      sqlName: 'chronicle',
      ddl: 'CREATE TABLE chronicle (row_id INT);',
      headers: ['row_id', '编码索引', '纪要'],
      initialRows: [
        ['1', 'AM0001', 'first'],
        ['2', 'AM0002', 'second']
      ]
    })
    const out = buildInitialInsert(t)!
    expect(out.sql).toBe('INSERT INTO "chronicle" VALUES (?, ?, ?)')
    expect(out.rows).toEqual([
      ['1', 'AM0001', 'first'],
      ['2', 'AM0002', 'second']
    ])
  })

  it('pads short rows with null and truncates long rows to the header width', () => {
    const t = table({
      sqlName: 'a',
      ddl: 'CREATE TABLE a (x INT);',
      headers: ['x', 'y'],
      initialRows: [['1'], ['1', '2', '3']]
    })
    const out = buildInitialInsert(t)!
    expect(out.sql).toBe('INSERT INTO "a" VALUES (?, ?)')
    expect(out.rows).toEqual([
      ['1', null],
      ['1', '2']
    ])
  })

  it('returns null when there are no initial rows', () => {
    const t = table({
      sqlName: 'a',
      ddl: 'CREATE TABLE a (x INT);',
      headers: ['x'],
      initialRows: []
    })
    expect(buildInitialInsert(t)).toBeNull()
  })

  it("binds an empty row_id cell as NULL (INTEGER PRIMARY KEY auto-assign), keeps '' elsewhere", () => {
    const t = table({
      sqlName: 'a',
      ddl: 'CREATE TABLE a (row_id INTEGER PRIMARY KEY, v TEXT);',
      headers: ['row_id', 'v'],
      initialRows: [['', '']]
    })
    const out = buildInitialInsert(t)!
    expect(out.rows).toEqual([[null, '']])
  })
})

describe('unifyDisplayColumns (issue 06 display-header unification)', () => {
  it('shows DISPLAY headers when their width matches the sandbox column count', () => {
    expect(unifyDisplayColumns(['row_id', '纪要'], ['row_id', 'summary'])).toEqual(['row_id', '纪要'])
  })
  it('falls back to sandbox column names when widths disagree', () => {
    expect(unifyDisplayColumns(['a'], ['x', 'y'])).toEqual(['x', 'y'])
  })
  it('uses headers when there are no sandbox columns (empty read)', () => {
    expect(unifyDisplayColumns(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})
