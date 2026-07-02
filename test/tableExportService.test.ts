import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { parseChatSheets } from '../src/main/parsers/chatSheetsParser'
import { TableTemplate } from '../src/main/types/tableTemplate'
import { TableRead } from '../src/main/services/tableDbService'
import {
  columnIndex,
  renderRow,
  renderWholeTable,
  renderIndexLine,
  applyTemplate,
  synthesizeEntries
} from '../src/main/services/tableExportService'

// Pure prompt-projection (issue 04) tested against the REAL 命定之诗 template's exportConfigs. Rows are
// hand-built TableRead arrays (positional in headers order — no SQL runs; better-sqlite3 is alias-mocked
// elsewhere but not even imported here). We pin the render formats, the key-derivation rule, the three
// placement mappings, the always-on index entry, and the disabled/empty-table cases.

const template: TableTemplate = parseChatSheets(
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'chatsheets-poem-of-destiny-5.9.json'),
      'utf-8'
    )
  ),
  'poem'
)

const table = (sqlName: string): (typeof template.tables)[number] =>
  template.tables.find((t) => t.sqlName === sqlName)!

/** A TableRead whose rows are POSITIONAL in the template's headers order (the readAllTables contract). */
const readFor = (sqlName: string, rows: unknown[][]): TableRead => {
  const t = table(sqlName)
  return { sqlName, displayName: t.displayName, columns: t.headers, rows, rowids: rows.map((_, i) => i + 1) }
}

describe('render helpers', () => {
  it('columnIndex maps display name → positional index', () => {
    const headers = ['row_id', '姓名', '所在位置']
    expect(columnIndex(headers, '姓名')).toBe(1)
    expect(columnIndex(headers, '所在位置')).toBe(2)
    expect(columnIndex(headers, 'missing')).toBe(-1)
  })

  it('renderRow → one `header: value` line per column (null/short cells → empty value)', () => {
    expect(renderRow(['row_id', '姓名', '位置'], [1, '艾莉亚', null])).toBe(
      'row_id: 1\n姓名: 艾莉亚\n位置: '
    )
    // short row: missing trailing cell rendered empty
    expect(renderRow(['a', 'b', 'c'], ['x'])).toBe('a: x\nb: \nc: ')
  })

  it('renderWholeTable → ` | `-joined header line then one line per row', () => {
    expect(
      renderWholeTable(['姓名', '位置'], [['艾莉亚', '王城'], ['凯', null]])
    ).toBe('姓名 | 位置\n艾莉亚 | 王城\n凯 | ')
  })

  it('renderIndexLine → `col: value` pairs joined with ` | ` for the configured columns', () => {
    const headers = ['row_id', '姓名', '所在位置', '角色间关系']
    const row = [1, '艾莉亚', '王城', '盟友']
    expect(renderIndexLine(['姓名', '所在位置', '角色间关系'], headers, row)).toBe(
      '姓名: 艾莉亚 | 所在位置: 王城 | 角色间关系: 盟友'
    )
  })

  it('applyTemplate replaces every `$1`; empty wrapper = body verbatim', () => {
    expect(applyTemplate('<x>\n$1\n</x>', 'BODY')).toBe('<x>\nBODY\n</x>')
    expect(applyTemplate('', 'BODY')).toBe('BODY')
    expect(applyTemplate('$1 / $1', 'B')).toBe('B / B')
  })
})

describe('synthesizeEntries — 重要角色表 (splitByRow, keyword, after_character_definition → top block)', () => {
  const chars = table('important_characters')
  const headers = chars.headers // row_id, 姓名, 所在位置, 角色间关系, ...

  it('one row entry per row; keys from 姓名 + 角色间关系 (keywords) PLUS 姓名 (both-mode index)', () => {
    const row = headers.map((h) =>
      h === '姓名' ? '艾莉亚' : h === '所在位置' ? '王城' : h === '角色间关系' ? '盟友' : ''
    )
    const entries = synthesizeEntries(
      { ...template, tables: [chars] },
      [readFor('important_characters', [row])]
    )
    // one row entry + one index entry (extraIndexEnabled)
    expect(entries).toHaveLength(2)
    const rowEntry = entries[0]
    // keywords columns 姓名 + 角色间关系, plus 姓名 is a 'both'-mode index column (de-duped)
    expect(rowEntry.keys).toEqual(['艾莉亚', '盟友'])
    expect(rowEntry.constant).toBe(false)
    expect(rowEntry.prevent_recursion).toBe(true)
    expect(rowEntry.comment).toBe('重要角色表#0')
    // wrapper <角色最新信息>\n$1\n</角色最新信息> applied around renderRow
    expect(rowEntry.content).toBe(`<角色最新信息>\n${renderRow(headers, row)}\n</角色最新信息>`)
    // after_character_definition → top block (null depth), order 680
    expect(rowEntry.insertion_depth).toBeNull()
    expect(rowEntry.insertion_order).toBe(680)
  })

  it('the index entry is always-on (constant), wraps renderIndexLine per row, mapped to its own placement', () => {
    const r1 = headers.map((h) => (h === '姓名' ? '艾莉亚' : h === '所在位置' ? '王城' : h === '角色间关系' ? '盟友' : ''))
    const r2 = headers.map((h) => (h === '姓名' ? '凯' : h === '所在位置' ? '边境' : h === '角色间关系' ? '未知' : ''))
    const entries = synthesizeEntries(
      { ...template, tables: [chars] },
      [readFor('important_characters', [r1, r2])]
    )
    const index = entries[entries.length - 1]
    expect(index.constant).toBe(true)
    expect(index.keys).toEqual([])
    const body = [
      renderIndexLine(['姓名', '所在位置', '角色间关系'], headers, r1),
      renderIndexLine(['姓名', '所在位置', '角色间关系'], headers, r2)
    ].join('\n')
    expect(index.content).toBe(
      `# 以下为已经登场过的角色及其最新信息：\n<已登场角色>\n${body}\n</已登场角色>`
    )
    // extraIndexPlacement after_character_definition → top block, order 670
    expect(index.insertion_depth).toBeNull()
    expect(index.insertion_order).toBe(670)
  })
})

describe('synthesizeEntries — 纪要表 (keyword keys from 编码索引; at_depth_as_system 999)', () => {
  const chronicle = table('chronicle')
  const headers = chronicle.headers

  it('keyword entry keys from 编码索引 cells; depth 999 / order 10000', () => {
    const row = headers.map((h) => (h === '编码索引' ? 'EV001' : h === '概览' ? '事件A' : ''))
    const entries = synthesizeEntries(
      { ...template, tables: [chronicle] },
      [readFor('chronicle', [row])]
    )
    const rowEntry = entries[0]
    // keywords '编码索引' + 编码索引 is 'both'-mode index (de-duped to one)
    expect(rowEntry.keys).toEqual(['EV001'])
    expect(rowEntry.insertion_depth).toBe(999)
    expect(rowEntry.insertion_order).toBe(10000)
    // index entry mapped at_depth_as_system depth 1000 / order 10010
    const index = entries[entries.length - 1]
    expect(index.constant).toBe(true)
    expect(index.insertion_depth).toBe(1000)
    expect(index.insertion_order).toBe(10010)
  })
})

describe('synthesizeEntries — 伏笔表 (constant entries, depth 1003)', () => {
  it('constant row entries carry NO keys and map to depth 1003', () => {
    const fs_ = table('foreshadow_table')
    const headers = fs_.headers
    const row = headers.map((h, i) => (i === 0 ? '1' : `c${i}`))
    const entries = synthesizeEntries(
      { ...template, tables: [fs_] },
      [readFor('foreshadow_table', [row])]
    )
    // constant, no extraIndex on this table → exactly one entry
    expect(entries).toHaveLength(1)
    expect(entries[0].constant).toBe(true)
    expect(entries[0].keys).toEqual([])
    expect(entries[0].insertion_depth).toBe(1003)
    expect(entries[0].content).toBe(`<伏笔>\n${renderRow(headers, row)}\n</伏笔>`)
  })
})

describe('synthesizeEntries — disabled / empty / whole-table / max-rows', () => {
  it('主角信息 (exportConfig.enabled: false) → zero entries', () => {
    const prot = table('protagonist_info')
    const row = prot.headers.map((_, i) => (i === 0 ? '1' : 'x'))
    const entries = synthesizeEntries({ ...template, tables: [prot] }, [
      readFor('protagonist_info', [row])
    ])
    expect(entries).toEqual([])
  })

  it('empty enabled table → ONLY the index entry (empty body); no row entries', () => {
    const chars = table('important_characters')
    const entries = synthesizeEntries({ ...template, tables: [chars] }, [
      readFor('important_characters', [])
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].constant).toBe(true)
    // empty body → wrapper around ''
    expect(entries[0].content).toBe(
      '# 以下为已经登场过的角色及其最新信息：\n<已登场角色>\n\n</已登场角色>'
    )
  })

  it('empty table with NO extraIndex → nothing at all', () => {
    const fs_ = table('foreshadow_table')
    const entries = synthesizeEntries({ ...template, tables: [fs_] }, [
      readFor('foreshadow_table', [])
    ])
    expect(entries).toEqual([])
  })

  it('splitByRow: false → one whole-table entry (keys derived over ALL rows for keyword tables)', () => {
    // Synthesize a keyword table forced to whole-table mode.
    const chronicle = table('chronicle')
    const wholeTable = {
      ...chronicle,
      exportConfig: { ...chronicle.exportConfig, splitByRow: false, extraIndexEnabled: false }
    }
    const headers = chronicle.headers
    const r1 = headers.map((h) => (h === '编码索引' ? 'EV001' : ''))
    const r2 = headers.map((h) => (h === '编码索引' ? 'EV002' : ''))
    const entries = synthesizeEntries({ ...template, tables: [wholeTable] }, [
      readFor('chronicle', [r1, r2])
    ])
    expect(entries).toHaveLength(1)
    // comment = exportConfig.entryName (fixture: '纪要') when set, else displayName; NO #index for whole-table
    expect(entries[0].comment).toBe(chronicle.exportConfig.entryName || '纪要表')
    expect(entries[0].keys).toEqual(['EV001', 'EV002']) // keys over all rows
    expect(entries[0].content).toBe(
      `<记忆回溯>\n${renderWholeTable(headers, [r1, r2])}\n</记忆回溯>`
    )
  })

  it('de-dupes repeated keyword cell values across rows', () => {
    const chars = table('important_characters')
    const headers = chars.headers
    const mk = (name: string, rel: string): unknown[] =>
      headers.map((h) => (h === '姓名' ? name : h === '角色间关系' ? rel : ''))
    const wholeTable = { ...chars, exportConfig: { ...chars.exportConfig, splitByRow: false } }
    const entries = synthesizeEntries({ ...template, tables: [wholeTable] }, [
      readFor('important_characters', [mk('艾莉亚', '盟友'), mk('艾莉亚', '盟友')])
    ])
    // whole-table row entry + index; row entry keys de-duped to one each
    expect(entries[0].keys).toEqual(['艾莉亚', '盟友'])
  })
})
