import { describe, it, expect, beforeEach, vi } from 'vitest'

// parse.extract (generic extractor) + table.apply (SQL write node) run() contract tests (issue 03).
// table.apply's service deps are mocked — no real SQL runs (better-sqlite3 is alias-mocked). We pin:
// silent no-op on blank sql, class-B failures (no-template / busy / bad-sql) on the error path,
// success → appendOps floor attribution + done, and that the lock is always released.

const chatSvc = vi.hoisted(() => ({ getChatTableTemplateId: vi.fn() }))
vi.mock('../../src/main/services/chatService', () => chatSvc)

const templateSvc = vi.hoisted(() => ({ getTableTemplateById: vi.fn() }))
vi.mock('../../src/main/services/tableTemplateService', () => templateSvc)

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
vi.mock('../../src/main/services/tableSql', () => sqlSvc)

const opsSvc = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(),
  endTableWrite: vi.fn()
}))
vi.mock('../../src/main/services/tableOpsService', () => opsSvc)

// table.export reads via tableDbService (mocked — no SQL) but QUALIFIES via the REAL lorebookService
// matchAcross + REAL tableExportService synthesis (both pure), so the qualification path is exercised end-to-end.
const dbSvc = vi.hoisted(() => ({ readAllTables: vi.fn() }))
vi.mock('../../src/main/services/tableDbService', () => dbSvc)

import { parseExtract } from '../../src/main/services/nodes/builtin/parseNodes'
import { tableApply, tableExport } from '../../src/main/services/nodes/builtin/tableNodes'
import { NodeRunFailure, RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { TableTemplateSchema } from '../../src/main/types/tableTemplate'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

describe('parse.extract (tag mode)', () => {
  it('extracts all <tag>…</tag> occurrences; first + all + found signal', () => {
    const text = 'x <char_info>Alice</char_info> y <char_info>Bob</char_info> z'
    const r = parseExtract.run(ctx, { text }, meta(parseExtract, 'n', { tag: 'char_info' }))
    expect(r).toEqual({
      outputs: { first: 'Alice', all: ['Alice', 'Bob'] },
      signals: ['found']
    })
  })

  it('is case-insensitive and dotall (matches across newlines)', () => {
    const text = '<SQL>\nINSERT INTO a\nVALUES (1)\n</sql>'
    const r = parseExtract.run(ctx, { text }, meta(parseExtract, 'n', { tag: 'sql' }))
    expect(r.outputs?.first).toBe('\nINSERT INTO a\nVALUES (1)\n')
    expect(r.signals).toEqual(['found'])
  })

  it('no match → empty outputs, no found signal', () => {
    const r = parseExtract.run(ctx, { text: 'nothing here' }, meta(parseExtract, 'n', { tag: 'x' }))
    expect(r).toEqual({ outputs: { first: '', all: [] } })
  })

  it('blank/absent input text → empty outputs, no found signal', () => {
    expect(parseExtract.run(ctx, { text: '' }, meta(parseExtract, 'n', { tag: 'x' }))).toEqual({
      outputs: { first: '', all: [] }
    })
    expect(parseExtract.run(ctx, {}, meta(parseExtract, 'n', { tag: 'x' }))).toEqual({
      outputs: { first: '', all: [] }
    })
  })
})

describe('parse.extract (regex mode)', () => {
  it('captures group 1 when present, across all matches', () => {
    const text = 'a=1 b=2 c=3'
    const r = parseExtract.run(
      ctx,
      { text },
      meta(parseExtract, 'n', { mode: 'regex', pattern: '(\\d)' })
    )
    expect(r.outputs).toEqual({ first: '1', all: ['1', '2', '3'] })
    expect(r.signals).toEqual(['found'])
  })

  it('uses the whole match when there is no capture group', () => {
    const r = parseExtract.run(
      ctx,
      { text: 'foo foo' },
      meta(parseExtract, 'n', { mode: 'regex', pattern: 'foo' })
    )
    expect(r.outputs).toEqual({ first: 'foo', all: ['foo', 'foo'] })
  })

  it('a bad user regex → class-B bad-pattern, never a crash', () => {
    try {
      parseExtract.run(ctx, { text: 'x' }, meta(parseExtract, 'n', { mode: 'regex', pattern: '(' }))
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NodeRunFailure)
      expect((e as NodeRunFailure).kind).toBe('B')
      expect((e as NodeRunFailure).code).toBe('bad-pattern')
    }
  })
})

const gen = {
  profileId: 'p1',
  chatId: 'c1',
  floors: [{ floor: 0 }, { floor: 1 }, { floor: 2 }]
}

describe('table.apply', () => {
  beforeEach(() => {
    chatSvc.getChatTableTemplateId.mockReset()
    templateSvc.getTableTemplateById.mockReset()
    sqlSvc.applySqlBatch.mockReset()
    opsSvc.appendOps.mockReset()
    opsSvc.tryBeginTableWrite.mockReset()
    opsSvc.endTableWrite.mockReset()
  })

  it('blank/whitespace sql → silent no-op (no template lookup, no lock)', () => {
    const r = tableApply.run(ctx, { gen, sql: '   ' }, meta(tableApply, 'n'))
    expect(r).toEqual({ outputs: {} })
    expect(chatSvc.getChatTableTemplateId).not.toHaveBeenCalled()
    expect(opsSvc.tryBeginTableWrite).not.toHaveBeenCalled()
  })

  it('no template assigned → class-B no-template', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    try {
      tableApply.run(ctx, { gen, sql: 'INSERT INTO a VALUES (1)' }, meta(tableApply, 'n'))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as NodeRunFailure).kind).toBe('B')
      expect((e as NodeRunFailure).code).toBe('no-template')
    }
    expect(opsSvc.tryBeginTableWrite).not.toHaveBeenCalled()
  })

  it('lock busy → class-B busy (lock not released — it was never held by us)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue({ tables: [] })
    opsSvc.tryBeginTableWrite.mockReturnValue(false)
    try {
      tableApply.run(ctx, { gen, sql: 'INSERT INTO a VALUES (1)' }, meta(tableApply, 'n'))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as NodeRunFailure).code).toBe('busy')
    }
    expect(sqlSvc.applySqlBatch).not.toHaveBeenCalled()
    expect(opsSvc.endTableWrite).not.toHaveBeenCalled()
  })

  it('success → appendOps at floors.length-1, results + done, lock released', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue({ tables: [] })
    opsSvc.tryBeginTableWrite.mockReturnValue(true)
    sqlSvc.applySqlBatch.mockReturnValue({
      applied: 2,
      changes: 3,
      statements: ['INSERT INTO a VALUES (1)', 'UPDATE a SET x=1']
    })
    const r = tableApply.run(
      ctx,
      { gen, sql: 'INSERT INTO a VALUES (1); UPDATE a SET x=1' },
      meta(tableApply, 'n')
    )
    expect(r).toEqual({ outputs: { results: { applied: 2, changes: 3 }, done: true } })
    expect(opsSvc.appendOps).toHaveBeenCalledWith('p1', 'c1', 2, [
      'INSERT INTO a VALUES (1)',
      'UPDATE a SET x=1'
    ])
    expect(opsSvc.endTableWrite).toHaveBeenCalledWith('c1')
  })

  it('floor attribution clamps to >= 0 when there are no floors', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue({ tables: [] })
    opsSvc.tryBeginTableWrite.mockReturnValue(true)
    sqlSvc.applySqlBatch.mockReturnValue({ applied: 1, changes: 1, statements: ['INSERT INTO a VALUES (1)'] })
    tableApply.run(ctx, { gen: { ...gen, floors: [] }, sql: 'INSERT INTO a VALUES (1)' }, meta(tableApply, 'n'))
    expect(opsSvc.appendOps).toHaveBeenCalledWith('p1', 'c1', 0, ['INSERT INTO a VALUES (1)'])
  })

  it('execution failure → class-B bad-sql and the lock IS released', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue({ tables: [] })
    opsSvc.tryBeginTableWrite.mockReturnValue(true)
    sqlSvc.applySqlBatch.mockImplementation(() => {
      throw new sqlSvc.TableSqlError('boom', 0)
    })
    try {
      tableApply.run(ctx, { gen, sql: 'INSERT INTO a VALUES (1)' }, meta(tableApply, 'n'))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as NodeRunFailure).kind).toBe('B')
      expect((e as NodeRunFailure).code).toBe('bad-sql')
      expect((e as Error).message).toContain('boom')
    }
    expect(opsSvc.appendOps).not.toHaveBeenCalled()
    expect(opsSvc.endTableWrite).toHaveBeenCalledWith('c1')
  })
})

// A minimal two-table template (validated through the schema) for the export node: one keyword table
// (fires only on a scan hit) + one constant table (always fires). exportConfig fields default via prefault.
const makeTemplate = () =>
  TableTemplateSchema.parse({
    name: 'T',
    tables: [
      {
        uid: 'k',
        displayName: 'People',
        sqlName: 'people',
        ddl: 'CREATE TABLE people (row_id INTEGER, name TEXT);',
        headers: ['row_id', 'name'],
        exportConfig: {
          enabled: true,
          splitByRow: true,
          entryType: 'keyword',
          keywords: 'name',
          injectionTemplate: '<p>\n$1\n</p>',
          entryPlacement: { position: 'at_depth_as_system', depth: 5, order: 100 }
        }
      },
      {
        uid: 'c',
        displayName: 'Rules',
        sqlName: 'rules',
        ddl: 'CREATE TABLE rules (row_id INTEGER, text TEXT);',
        headers: ['row_id', 'text'],
        exportConfig: {
          enabled: true,
          splitByRow: true,
          entryType: 'constant',
          entryPlacement: { position: 'before_character_definition', depth: 0, order: 50 }
        }
      }
    ]
  })

const readOf = (sqlName: string, headers: string[], rows: unknown[][]) => ({
  sqlName,
  displayName: sqlName,
  columns: headers,
  rows
})

describe('table.export', () => {
  const genExp = { profileId: 'p1', chatId: 'c1', scanText: '', maxRecursion: 0 }

  beforeEach(() => {
    chatSvc.getChatTableTemplateId.mockReset()
    templateSvc.getTableTemplateById.mockReset()
    dbSvc.readAllTables.mockReset()
  })

  it('no template assigned → SILENT empty (entries: [], block: ""), not an error', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    const r = tableExport.run(ctx, { gen: genExp }, meta(tableExport, 'n'))
    expect(r).toEqual({ outputs: { entries: [], block: '' } })
    expect(dbSvc.readAllTables).not.toHaveBeenCalled()
  })

  it('constant entries always survive; keyword entries fire only on a scan hit (real matchAcross)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(makeTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('people', ['row_id', 'name'], [[1, '艾莉亚']]),
      readOf('rules', ['row_id', 'text'], [[1, 'be kind']])
    ])
    // scanText does NOT mention 艾莉亚 → the keyword entry does not qualify; only the constant survives.
    const r = tableExport.run(ctx, { gen: genExp }, meta(tableExport, 'n'))
    const entries = r.outputs!.entries as any[]
    expect(entries).toHaveLength(1)
    expect(entries[0].constant).toBe(true)
    expect(entries[0].comment).toBe('Rules#0')
  })

  it('a scan hit lets the keyword entry through too', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(makeTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('people', ['row_id', 'name'], [[1, '艾莉亚']]),
      readOf('rules', ['row_id', 'text'], [[1, 'be kind']])
    ])
    const r = tableExport.run(
      ctx,
      { gen: { ...genExp, scanText: '……艾莉亚走进房间……' } },
      meta(tableExport, 'n')
    )
    const entries = r.outputs!.entries as any[]
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.comment).sort()).toEqual(['People#0', 'Rules#0'])
  })

  it('block contains only the NULL-depth (top-block) qualified entries content', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(makeTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('people', ['row_id', 'name'], [[1, '艾莉亚']]),
      readOf('rules', ['row_id', 'text'], [[1, 'be kind']])
    ])
    // scan hit → both qualify; People is at_depth (depth 5), Rules is before_char_def (null depth = top block).
    const r = tableExport.run(
      ctx,
      { gen: { ...genExp, scanText: '艾莉亚' } },
      meta(tableExport, 'n')
    )
    // block should contain the Rules (top-block) content but NOT the depth-placed People entry.
    expect(r.outputs!.block).toBe('row_id: 1\ntext: be kind')
  })

  it('tables filter narrows which tables project (by sqlName)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(makeTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('people', ['row_id', 'name'], [[1, '艾莉亚']]),
      readOf('rules', ['row_id', 'text'], [[1, 'be kind']])
    ])
    // only 'people' — the constant Rules table is excluded before synthesis.
    const r = tableExport.run(
      ctx,
      { gen: { ...genExp, scanText: '艾莉亚' } },
      meta(tableExport, 'n', { tables: 'people' })
    )
    const entries = r.outputs!.entries as any[]
    expect(entries).toHaveLength(1)
    expect(entries[0].comment).toBe('People#0')
  })

  it('max_rows keeps the LAST N data rows per table', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(makeTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('people', ['row_id', 'name'], []),
      readOf('rules', ['row_id', 'text'], [[1, 'r1'], [2, 'r2'], [3, 'r3']])
    ])
    const r = tableExport.run(
      ctx,
      { gen: genExp },
      meta(tableExport, 'n', { max_rows: 2 })
    )
    const entries = r.outputs!.entries as any[]
    // constant table → all survive; capped to last 2 rows (r2, r3)
    expect(entries.map((e) => e.comment)).toEqual(['Rules#0', 'Rules#1'])
    expect(entries[0].content).toContain('text: r2')
    expect(entries[1].content).toContain('text: r3')
  })
})
