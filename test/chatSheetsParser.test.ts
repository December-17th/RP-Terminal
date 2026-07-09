import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  parseChatSheets,
  exportChatSheets,
  extractCreateTableName,
  stripSqlComments,
  isSafeSqlIdentifier,
  parseDdlColumnNames,
  ChatSheetsParseError
} from '../src/main/parsers/chatSheetsParser'
import { TableTemplateSchema } from '../src/main/types/tableTemplate'

const fixture = (): any =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'chatsheets-poem-of-destiny-5.9.json'),
      'utf-8'
    )
  )

describe('extractCreateTableName / DDL guard', () => {
  it('extracts a bare table name from a commented CREATE TABLE', () => {
    expect(extractCreateTableName('CREATE TABLE chronicle ( -- 纪要表\n  row_id INTEGER\n);')).toBe(
      'chronicle'
    )
  })

  it('accepts IF NOT EXISTS, TEMP, and quoted names', () => {
    expect(extractCreateTableName('CREATE TABLE IF NOT EXISTS t (a INT);')).toBe('t')
    expect(extractCreateTableName('CREATE TEMP TABLE t2 (a INT);')).toBe('t2')
    expect(extractCreateTableName('CREATE TABLE "quoted_name" (a INT);')).toBe('quoted_name')
  })

  it('rejects a non-CREATE statement', () => {
    expect(() => extractCreateTableName('DROP TABLE chronicle;')).toThrow(ChatSheetsParseError)
    expect(() => extractCreateTableName('SELECT * FROM x;')).toThrow(ChatSheetsParseError)
  })

  it('rejects a multi-statement DDL (injection guard)', () => {
    expect(() => extractCreateTableName('CREATE TABLE a (x INT); DROP TABLE b;')).toThrow(
      /single CREATE TABLE/
    )
  })

  it('allows a single trailing semicolon and trailing whitespace', () => {
    expect(extractCreateTableName('CREATE TABLE a (x INT);   \n')).toBe('a')
  })

  it('rejects empty DDL', () => {
    expect(() => extractCreateTableName('   ')).toThrow(ChatSheetsParseError)
  })
})

describe('stripSqlComments / isSafeSqlIdentifier', () => {
  it('strips -- line comments but preserves structure', () => {
    expect(stripSqlComments('CREATE TABLE t ( -- c\n  a INT -- x\n);')).toBe(
      'CREATE TABLE t ( \n  a INT \n);'
    )
  })
  it('accepts valid identifiers and rejects unsafe ones', () => {
    expect(isSafeSqlIdentifier('chronicle')).toBe(true)
    expect(isSafeSqlIdentifier('row_id')).toBe(true)
    expect(isSafeSqlIdentifier('1bad')).toBe(false)
    expect(isSafeSqlIdentifier('drop table')).toBe(false)
    expect(isSafeSqlIdentifier('a;b')).toBe(false)
    expect(isSafeSqlIdentifier('')).toBe(false)
  })
})

describe('parseDdlColumnNames', () => {
  it('returns the DDL real column names in declared order (not the zh comments)', () => {
    const ddl =
      'CREATE TABLE protagonist_info ( -- 主角信息\n' +
      '  row_id INTEGER PRIMARY KEY, -- 行号\n' +
      '  name TEXT, -- 人物名称\n' +
      '  gender_age TEXT -- 性别/年龄\n);'
    expect(parseDdlColumnNames(ddl)).toEqual(['row_id', 'name', 'gender_age'])
  })

  it('skips table-level constraints but keeps inline column constraints and nested parens', () => {
    const ddl =
      'CREATE TABLE chronicle (\n' +
      "  row_id INTEGER PRIMARY KEY,\n" +
      "  code_index TEXT NOT NULL UNIQUE CHECK(code_index GLOB 'AM[0-9]'),\n" +
      '  summary TEXT CHECK(summary IS NULL OR LENGTH(summary) <= 80),\n' +
      '  UNIQUE(row_id)\n);'
    // row_id/code_index/summary kept (inline constraints); the table-level UNIQUE(...) clause dropped.
    expect(parseDdlColumnNames(ddl)).toEqual(['row_id', 'code_index', 'summary'])
  })

  it('handles quoted identifiers and a comma inside a type', () => {
    expect(parseDdlColumnNames('CREATE TABLE t ("a b" TEXT, amount DECIMAL(10,2));')).toEqual([
      'a b',
      'amount'
    ])
  })

  it('returns [] when there is no parsable table body', () => {
    expect(parseDdlColumnNames('')).toEqual([])
    expect(parseDdlColumnNames('not a ddl')).toEqual([])
  })
})

describe('parseChatSheets — the real 命定之诗 template', () => {
  it('parses into 8 ordered TableDefs with the expected sqlNames', () => {
    const tpl = parseChatSheets(fixture(), 'poem')
    expect(tpl.sourceFormat).toBe('chatSheets-v2')
    expect(tpl.tables).toHaveLength(8)
    expect(tpl.tables.map((t) => t.sqlName)).toEqual([
      'protagonist_info',
      'important_characters',
      'chronicle',
      'roleplay_guide',
      'foreshadow_table',
      'covenant_table',
      'region_table',
      'location_table'
    ])
    // ordered by orderNo 0..7
    expect(tpl.tables.map((t) => t.displayName)).toEqual([
      '主角信息',
      '重要角色表',
      '纪要表',
      '角色扮演指南',
      '伏笔表',
      '约定表',
      '地区表',
      '地点表'
    ])
  })

  it('carries global injection defaults', () => {
    const tpl = parseChatSheets(fixture(), 'poem')
    expect(tpl.globalInjection?.readableEntryPlacement?.position).toBe(
      'before_character_definition'
    )
    expect(tpl.globalInjection?.wrapperPlacement?.order).toBe(99980)
  })

  it('纪要表: updateFrequency -1 KEPT (use-global sentinel, issue 04); keyword index config', () => {
    const tpl = parseChatSheets(fixture(), 'poem')
    const chronicle = tpl.tables.find((t) => t.sqlName === 'chronicle')!
    // Deliberate behavior change (manual-pass issue 04): the importer no longer normalizes -1 → 1;
    // -1 is the "use the app global default" sentinel and round-trips verbatim.
    expect(chronicle.updateFrequency).toBe(-1)
    expect(chronicle.exportConfig.enabled).toBe(true)
    expect(chronicle.exportConfig.entryType).toBe('keyword')
    expect(chronicle.exportConfig.keywords).toBe('编码索引')
    expect(chronicle.exportConfig.extraIndexEnabled).toBe(true)
    expect(chronicle.exportConfig.extraIndexColumnModes).toEqual({
      概览: 'index_only',
      编码索引: 'both'
    })
    // headers from content[0]; no initial data rows
    expect(chronicle.headers[0]).toBe('row_id')
    expect(chronicle.initialRows).toEqual([])
  })

  it('重要角色表: splitByRow, keyword columns, extraIndexColumnModes', () => {
    const tpl = parseChatSheets(fixture(), 'poem')
    const chars = tpl.tables.find((t) => t.sqlName === 'important_characters')!
    expect(chars.updateFrequency).toBe(3) // positive kept as-is
    expect(chars.exportConfig.splitByRow).toBe(true)
    expect(chars.exportConfig.keywords).toBe('姓名, 角色间关系')
    expect(chars.exportConfig.extraIndexColumns).toEqual(['姓名', '所在位置', '角色间关系'])
    expect(chars.exportConfig.extraIndexColumnModes['姓名']).toBe('both')
    expect(chars.exportConfig.extraIndexColumnModes['所在位置']).toBe('index_only')
    expect(chars.exportConfig.entryPlacement.position).toBe('after_character_definition')
  })

  // updateFrequency normalization (manual-pass issue 04): -1 kept (use-global), 0 kept (off),
  // absent → -1, anything <= -2 clamped to -1. Built from a minimal synthetic sheet.
  const oneSheet = (updateFrequency: unknown): any => ({
    mate: { type: 'chatSheets', version: 2 },
    sheet_a: {
      uid: 'sheet_a',
      name: 'T',
      orderNo: 0,
      content: [['row_id']],
      updateConfig: updateFrequency === undefined ? {} : { updateFrequency },
      sourceData: { ddl: 'CREATE TABLE t (row_id INTEGER);' }
    }
  })
  const freqOf = (updateFrequency: unknown): number =>
    parseChatSheets(oneSheet(updateFrequency), 'x').tables[0].updateFrequency

  it('updateFrequency: -1 kept, 0 kept, absent → -1, <= -2 clamped to -1 (issue 04)', () => {
    expect(freqOf(-1)).toBe(-1) // use-global sentinel — verbatim
    expect(freqOf(0)).toBe(0) // off — verbatim
    expect(freqOf(4)).toBe(4) // positive kept
    expect(freqOf(undefined)).toBe(-1) // absent → global default sentinel
    expect(freqOf(-5)).toBe(-1) // <= -2 clamped
  })

  it('主角信息: export disabled, single header, per-op instructions preserved', () => {
    const tpl = parseChatSheets(fixture(), 'poem')
    const prot = tpl.tables.find((t) => t.sqlName === 'protagonist_info')!
    expect(prot.exportConfig.enabled).toBe(false)
    expect(prot.insertNode).toBe('禁止操作。')
    expect(prot.deleteNode).toBe('禁止删除。')
    expect(prot.note).toContain('【表定义】')
    // ddl stored verbatim (comment kept)
    expect(prot.ddl).toContain('-- 主角信息')
  })

  it('round-trips through TableTemplateSchema (lossless internal model)', () => {
    const tpl = parseChatSheets(fixture(), 'poem')
    expect(() => TableTemplateSchema.parse(tpl)).not.toThrow()
  })
})

describe('exportChatSheets — round-trip equivalence (issue 06 AC)', () => {
  it('parse → export → parse deep-equals the TableTemplate (the real 命定之诗 template)', () => {
    // The AC is EQUIVALENCE, not bytes: `updateFrequency -1` now round-trips VERBATIM (issue 04), but
    // UI sentinel / preventRecursion drops still mean a byte match is impossible; the model round-trips.
    const original = parseChatSheets(fixture(), 'poem')
    const roundTripped = parseChatSheets(exportChatSheets(original), 'poem')
    expect(roundTripped).toEqual(original)
  })

  it('preserves sheet uids and order', () => {
    const original = parseChatSheets(fixture(), 'poem')
    const raw = exportChatSheets(original) as Record<string, any>
    // one sheet_<uid> per table, uid preserved, orderNo = index.
    original.tables.forEach((t, i) => {
      const sheet = raw[`sheet_${t.uid}`]
      expect(sheet).toBeTruthy()
      expect(sheet.uid).toBe(t.uid)
      expect(sheet.orderNo).toBe(i)
    })
  })

  it('defaults globalInjectionConfig when the template has none', () => {
    const tpl = TableTemplateSchema.parse({
      name: 'n',
      sourceFormat: 'native',
      tables: [
        { uid: 'a', displayName: 'A', sqlName: 'a', ddl: 'CREATE TABLE a (row_id INTEGER);', headers: ['row_id'] }
      ]
    })
    const raw = exportChatSheets(tpl) as Record<string, any>
    expect(raw.mate.type).toBe('chatSheets')
    expect(raw.mate.version).toBe(2)
    // No injection defaults → the key is omitted (a present-but-empty object would parse back as a
    // defined globalInjection, breaking the round-trip); re-parse leaves globalInjection undefined.
    expect('globalInjectionConfig' in raw.mate).toBe(false)
    const reparsed = parseChatSheets(raw, 'n')
    expect(reparsed.globalInjection).toBeUndefined()
    // sourceFormat flips native → chatSheets-v2 by design (export always yields the chatSheets shape);
    // everything else round-trips.
    expect(reparsed.tables).toEqual(tpl.tables)
  })

  it('export-with-data embeds current rows as content[1..] (null → empty string)', () => {
    const tpl = TableTemplateSchema.parse({
      name: 'n',
      sourceFormat: 'native',
      tables: [
        { uid: 'a', displayName: 'A', sqlName: 'chronicle', ddl: 'CREATE TABLE chronicle (row_id INTEGER, v TEXT);', headers: ['row_id', 'v'] }
      ]
    })
    const data = new Map<string, string[][]>([['chronicle', [['1', '事件一'], ['2', '']]]])
    const raw = exportChatSheets(tpl, data) as Record<string, any>
    const sheet = raw['sheet_a']
    expect(sheet.content[0]).toEqual(['row_id', 'v']) // header row
    expect(sheet.content.slice(1)).toEqual([['1', '事件一'], ['2', '']])
    // re-import picks the embedded rows up as initialRows.
    const reimported = parseChatSheets(raw, 'n')
    expect(reimported.tables[0].initialRows).toEqual([['1', '事件一'], ['2', '']])
  })
})

describe('parseChatSheets — rejection cases', () => {
  it('rejects a wrong mate.type', () => {
    expect(() => parseChatSheets({ mate: { type: 'other', version: 2 } }, 'x')).toThrow(
      /chatSheets/
    )
  })
  it('rejects a non-2 version', () => {
    expect(() =>
      parseChatSheets({ mate: { type: 'chatSheets', version: 1 }, sheet_a: {} }, 'x')
    ).toThrow(/version/)
  })
  it('rejects when there are no sheets', () => {
    expect(() => parseChatSheets({ mate: { type: 'chatSheets', version: 2 } }, 'x')).toThrow(
      /no sheets/
    )
  })
  it('rejects a sheet whose ddl is not a single CREATE TABLE', () => {
    const raw = {
      mate: { type: 'chatSheets', version: 2 },
      sheet_a: {
        uid: 'sheet_a',
        name: 'Bad',
        orderNo: 0,
        content: [['row_id']],
        sourceData: { ddl: 'CREATE TABLE a (x INT); DROP TABLE evil;' }
      }
    }
    expect(() => parseChatSheets(raw, 'x')).toThrow(ChatSheetsParseError)
  })
  it('rejects a sheet missing its header row', () => {
    const raw = {
      mate: { type: 'chatSheets', version: 2 },
      sheet_a: {
        uid: 'sheet_a',
        name: 'NoHeader',
        orderNo: 0,
        content: [],
        sourceData: { ddl: 'CREATE TABLE a (x INT);' }
      }
    }
    expect(() => parseChatSheets(raw, 'x')).toThrow(/header row/)
  })
  it('rejects a non-object input', () => {
    expect(() => parseChatSheets(null, 'x')).toThrow(ChatSheetsParseError)
    expect(() => parseChatSheets('nope', 'x')).toThrow(ChatSheetsParseError)
  })
  it('rejects two sheets creating the same SQL table (would collide at instantiation)', () => {
    const sheet = (uid: string, orderNo: number): object => ({
      uid,
      name: uid,
      orderNo,
      content: [['row_id']],
      sourceData: { ddl: 'CREATE TABLE dup (x INT);' }
    })
    const raw = {
      mate: { type: 'chatSheets', version: 2 },
      sheet_a: sheet('sheet_a', 0),
      sheet_b: sheet('sheet_b', 1)
    }
    expect(() => parseChatSheets(raw, 'x')).toThrow(/Duplicate table name "dup"/)
  })
})
