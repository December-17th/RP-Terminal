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
  executeReadQuery: vi.fn(),
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

const floorSvc = vi.hoisted(() => ({ getAllFloors: vi.fn() }))
vi.mock('../../src/main/services/floorService', () => floorSvc)

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

// The chat-level progress store the gate now reads/advances (issue 07) — replaces its node state.
const progressSvc = vi.hoisted(() => ({ getProgress: vi.fn(), advanceProgress: vi.fn() }))
vi.mock('../../src/main/services/tableProgressService', () => progressSvc)

import { parseExtract } from '../../src/main/services/nodes/builtin/parseNodes'
import {
  tableApply,
  tableExport,
  tableGate,
  tableRead,
  tableQuery
} from '../../src/main/services/nodes/builtin/tableNodes'
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
  rows,
  rowids: rows.map((_, i) => i + 1)
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

// ---- Maintenance pipeline (issue 05): table.gate / table.read / table.query ------------------

// Two tables: 纪要 (every turn, freq 1) and 世界 (freq 3), with rules for the read node.
const maintTemplate = () =>
  TableTemplateSchema.parse({
    name: 'M',
    tables: [
      {
        uid: 'j',
        displayName: '纪要表',
        sqlName: 'chronicle',
        ddl: 'CREATE TABLE chronicle (row_id INTEGER, summary TEXT);',
        headers: ['row_id', 'summary'],
        note: '按时间顺序记录事件',
        insertNode: 'INSERT INTO chronicle …',
        updateNode: 'UPDATE chronicle …',
        deleteNode: '',
        initNode: 'INSERT the first row',
        updateFrequency: 1
      },
      {
        uid: 'w',
        displayName: '世界表',
        sqlName: 'world',
        ddl: 'CREATE TABLE world (row_id INTEGER, fact TEXT);',
        headers: ['row_id', 'fact'],
        note: '世界设定',
        insertNode: 'INSERT INTO world …',
        updateFrequency: 3
      }
    ]
  })

// table.gate now reads/advances the CHAT-LEVEL progress store (issue 07), not per-workflow node state.
// The `at` rewind discriminator is retired — the store is clamped explicitly on truncation (tested as a
// clampProgress service test). We pin cadence, at-most-once, config filter, and silent no-template
// against the mocked progress service.
describe('table.gate', () => {
  const gen = { profileId: 'p1', chatId: 'c1', floors: [] }

  beforeEach(() => {
    chatSvc.getChatTableTemplateId.mockReset()
    templateSvc.getTableTemplateById.mockReset()
    floorSvc.getAllFloors.mockReset()
    progressSvc.getProgress.mockReset()
    progressSvc.advanceProgress.mockReset()
    progressSvc.getProgress.mockReturnValue({}) // default: nothing processed
  })

  it('no template → silent no-op (no floor read, no progress read)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    const r = tableGate.run(ctx, { gen }, meta(tableGate, 'g'))
    expect(r).toEqual({ outputs: {} })
    expect(floorSvc.getAllFloors).not.toHaveBeenCalled()
    expect(progressSvc.getProgress).not.toHaveBeenCalled()
  })

  it('first turn: freq-1 fires (last -1); freq-3 not yet (needs 3 floors elapsed)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    floorSvc.getAllFloors.mockReturnValue([{}]) // 1 floor → currentFloor 0
    const r = tableGate.run(ctx, { gen }, meta(tableGate, 'g'))
    expect(r.signals).toEqual(['due'])
    // world: 0 - (-1) = 1, not >= 3 → not due. Only chronicle (freq 1) is due.
    expect(r.outputs!.tables).toEqual(['chronicle'])
    expect(r.outputs!.span).toEqual({ from: 0, to: 0 })
  })

  it('advances the store on fire (only the due tables, at currentFloor)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    floorSvc.getAllFloors.mockReturnValue([{}]) // currentFloor 0
    const first = tableGate.run(ctx, { gen }, meta(tableGate, 'g'))
    expect(first.signals).toEqual(['due'])
    // Only the due table (chronicle) advances; world is untouched (missing = still -1).
    expect(progressSvc.advanceProgress).toHaveBeenCalledWith('p1', 'c1', ['chronicle'], 0)
  })

  it('at-most-once: a table already processed at the current floor is not due again', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    floorSvc.getAllFloors.mockReturnValue([{}]) // currentFloor 0
    // Store says chronicle already processed through floor 0; world still -1 (0 - (-1) = 1 < 3).
    progressSvc.getProgress.mockReturnValue({ chronicle: 0 })
    const r = tableGate.run(ctx, { gen }, meta(tableGate, 'g'))
    expect(r).toEqual({ outputs: {} })
    expect(progressSvc.advanceProgress).not.toHaveBeenCalled()
  })

  it('cadence: freq-3 table fires once 3 floors have elapsed, alongside the every-turn table', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    // Floor 2: chronicle last=1, world last=-1. world now due (2 - (-1) = 3 >= 3); chronicle due (2-1>=1).
    floorSvc.getAllFloors.mockReturnValue([{}, {}, {}])
    progressSvc.getProgress.mockReturnValue({ chronicle: 1 })
    const t2 = tableGate.run(ctx, { gen }, meta(tableGate, 'g'))
    expect(t2.outputs!.tables).toEqual(['chronicle', 'world'])
    // span.from = min(chronicle=1, world=-1) + 1 = 0.
    expect(t2.outputs!.span).toEqual({ from: 0, to: 2 })
    expect(progressSvc.advanceProgress).toHaveBeenCalledWith('p1', 'c1', ['chronicle', 'world'], 2)
  })

  it('config.tables narrows which tables the gate watches', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    // Floor 2 → world (freq 3) is due; chronicle is out of scope, so only world fires.
    floorSvc.getAllFloors.mockReturnValue([{}, {}, {}])
    const r = tableGate.run(ctx, { gen }, meta(tableGate, 'g', { tables: 'world' }))
    expect(r.outputs!.tables).toEqual(['world'])
  })

  it('config.every OVERRIDES per-table frequencies — the whole pass runs only every N floors', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    // every: 3. Floor 0: 0 - (-1) = 1 < 3 → NOTHING due, even chronicle (template freq 1).
    floorSvc.getAllFloors.mockReturnValue([{}])
    expect(tableGate.run(ctx, { gen }, meta(tableGate, 'g', { every: 3 }))).toEqual({
      outputs: {}
    })
    expect(progressSvc.advanceProgress).not.toHaveBeenCalled()
    // Floor 2: 2 - (-1) = 3 >= 3 → BOTH tables fire together in one pass.
    floorSvc.getAllFloors.mockReturnValue([{}, {}, {}])
    const r = tableGate.run(ctx, { gen }, meta(tableGate, 'g', { every: 3 }))
    expect(r.signals).toEqual(['due'])
    expect(r.outputs!.tables).toEqual(['chronicle', 'world'])
    expect(r.outputs!.span).toEqual({ from: 0, to: 2 })
  })
})

describe('table.read', () => {
  const gen = { profileId: 'p1', chatId: 'c1' }

  beforeEach(() => {
    chatSvc.getChatTableTemplateId.mockReset()
    templateSvc.getTableTemplateById.mockReset()
    dbSvc.readAllTables.mockReset()
  })

  it('no template → silent empty (read semantics)', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    const r = tableRead.run(ctx, { gen }, meta(tableRead, 'r'))
    expect(r).toEqual({ outputs: { block: '', tables: [] } })
    expect(dbSvc.readAllTables).not.toHaveBeenCalled()
  })

  it('renders definition + rules + data; init only when the table is empty; tables passthrough', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('chronicle', ['row_id', 'summary'], []), // empty → init rule shown
      readOf('world', ['row_id', 'fact'], [[1, '天空']]) // non-empty → no init rule
    ])
    const r = tableRead.run(ctx, { gen, tables: ['chronicle', 'world'] }, meta(tableRead, 'r'))
    const block = r.outputs!.block as string
    expect(block).toContain('## 纪要表 (chronicle) — 每 1 轮维护')
    expect(block).toContain('【表定义】按时间顺序记录事件')
    expect(block).toContain('【初始化规则】INSERT the first row') // empty table
    expect(block).toContain('【插入规则】INSERT INTO chronicle …')
    expect(block).toContain('【当前数据】')
    expect(block).toContain('## 世界表 (world) — 每 3 轮维护')
    expect(block).not.toContain('【删除规则】') // deleteNode empty on both
    // world is non-empty → its init rule is NOT shown (chronicle's init is the only 初始化规则).
    expect(block.match(/【初始化规则】/g)?.length).toBe(1)
    expect(r.outputs!.tables).toEqual(['chronicle', 'world'])
  })

  it('include_rules: false renders only header + data', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    dbSvc.readAllTables.mockReturnValue([readOf('chronicle', ['row_id', 'summary'], [])])
    const r = tableRead.run(
      ctx,
      { gen, tables: 'chronicle' },
      meta(tableRead, 'r', { include_rules: false })
    )
    const block = r.outputs!.block as string
    expect(block).toContain('## 纪要表 (chronicle)')
    expect(block).toContain('【当前数据】')
    expect(block).not.toContain('【插入规则】')
    expect(block).not.toContain('【表定义】')
  })

  it('accepts a comma-separated string for tables and narrows scope', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('chronicle', ['row_id', 'summary'], []),
      readOf('world', ['row_id', 'fact'], [])
    ])
    const r = tableRead.run(ctx, { gen, tables: 'world' }, meta(tableRead, 'r'))
    expect(r.outputs!.tables).toEqual(['world'])
    expect(r.outputs!.block as string).not.toContain('chronicle')
  })

  it('unwired tables → ALL template tables', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('chronicle', ['row_id', 'summary'], []),
      readOf('world', ['row_id', 'fact'], [])
    ])
    const r = tableRead.run(ctx, { gen }, meta(tableRead, 'r'))
    expect(r.outputs!.tables).toEqual(['chronicle', 'world'])
  })

  it('max_rows keeps the LAST N data rows', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    dbSvc.readAllTables.mockReturnValue([
      readOf('chronicle', ['row_id', 'summary'], [[1, 'a'], [2, 'b'], [3, 'c']])
    ])
    const r = tableRead.run(
      ctx,
      { gen, tables: 'chronicle' },
      meta(tableRead, 'r', { max_rows: 2 })
    )
    const block = r.outputs!.block as string
    expect(block).toContain('b')
    expect(block).toContain('c')
    expect(block).not.toContain('| a')
  })
})

describe('table.query', () => {
  const gen = { profileId: 'p1', chatId: 'c1' }

  beforeEach(() => {
    chatSvc.getChatTableTemplateId.mockReset()
    templateSvc.getTableTemplateById.mockReset()
    sqlSvc.executeReadQuery.mockReset()
  })

  it('blank query → silent empty (no template lookup)', () => {
    const r = tableQuery.run(ctx, { gen, query: '   ' }, meta(tableQuery, 'q'))
    expect(r).toEqual({ outputs: { rows: [], block: '' } })
    expect(chatSvc.getChatTableTemplateId).not.toHaveBeenCalled()
  })

  it('no template → silent empty', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    const r = tableQuery.run(ctx, { gen, query: 'chronicle' }, meta(tableQuery, 'q'))
    expect(r).toEqual({ outputs: { rows: [], block: '' } })
    expect(sqlSvc.executeReadQuery).not.toHaveBeenCalled()
  })

  it('renders the result block from columns + rows', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    sqlSvc.executeReadQuery.mockReturnValue({
      columns: ['row_id', 'summary'],
      rows: [[1, '事件一'], [2, '事件二']]
    })
    const r = tableQuery.run(ctx, { gen, query: 'chronicle' }, meta(tableQuery, 'q'))
    expect(r.outputs!.rows).toEqual([[1, '事件一'], [2, '事件二']])
    expect(r.outputs!.block).toBe('row_id | summary\n1 | 事件一\n2 | 事件二')
  })

  it('a bad query → class-B bad-query on the error path', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(maintTemplate())
    sqlSvc.executeReadQuery.mockImplementation(() => {
      throw new sqlSvc.TableSqlError('no such table: secrets')
    })
    try {
      tableQuery.run(ctx, { gen, query: 'SELECT * FROM secrets' }, meta(tableQuery, 'q'))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as NodeRunFailure).kind).toBe('B')
      expect((e as NodeRunFailure).code).toBe('bad-query')
      expect((e as Error).message).toContain('no such table')
    }
  })
})
