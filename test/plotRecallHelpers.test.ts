import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { parseChatSheets } from '../src/main/parsers/chatSheetsParser'
import { TableTemplate } from '../src/main/types/tableTemplate'
import { TableRead } from '../src/main/services/tableDbService'
import {
  renderIndexLine,
  applyTemplate,
  synthesizeEntries,
  renderCatalog,
  filterEntriesByCodes
} from '../src/main/services/tableExportService'
import { codeColumnOf } from '../src/shared/memory/codeColumn'
import { buildPlotBlock } from '../src/main/services/memory/plotRecallCompose'

// WP3 pure recall helpers, tested against the REAL 命定之诗 template's exportConfigs. Rows are
// hand-built positional TableRead arrays (no SQL runs). We pin: the catalogue rendering + gating +
// concatenation, the exact-key (non-substring) code fetch, cap + order, and code-column derivation.

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

const readFor = (sqlName: string, rows: unknown[][]): TableRead => {
  const t = table(sqlName)
  return { sqlName, displayName: t.displayName, columns: t.headers, rows, rowids: rows.map((_, i) => i + 1) }
}

/** Build a chronicle row with a given 编码索引 code + 概览 skeleton. */
const chronicleRow = (code: string, overview: string): unknown[] => {
  const headers = table('chronicle').headers
  return headers.map((h) => (h === '编码索引' ? code : h === '概览' ? overview : ''))
}

describe('renderCatalog', () => {
  it('multi-table: one wrapped block per enabled+indexed table, blank-line separated, per-row index lines', () => {
    const chars = table('important_characters')
    const chronicle = table('chronicle')
    const cHeaders = chars.headers
    const chHeaders = chronicle.headers
    const cr = cHeaders.map((h) =>
      h === '姓名' ? '艾莉亚' : h === '所在位置' ? '王城' : h === '角色间关系' ? '盟友' : ''
    )
    const chr = chronicleRow('MT001', '【时间】王城陷落')

    const out = renderCatalog({ ...template, tables: [chars, chronicle] }, [
      readFor('important_characters', [cr]),
      readFor('chronicle', [chr])
    ])

    const charsBlock = applyTemplate(
      chars.exportConfig.extraIndexInjectionTemplate,
      renderIndexLine(chars.exportConfig.extraIndexColumns, cHeaders, cr)
    )
    const chronicleBlock = applyTemplate(
      chronicle.exportConfig.extraIndexInjectionTemplate,
      renderIndexLine(chronicle.exportConfig.extraIndexColumns, chHeaders, chr)
    )
    expect(out).toBe(`${charsBlock}\n\n${chronicleBlock}`)
    // sanity: the concatenation actually contains both tables' index wrappers
    expect(out).toContain('已登场角色')
    expect(out).toContain('MT001')
  })

  it('empty enabled table → header-only (wrapper around empty body), same as the projected index entry', () => {
    const chars = table('important_characters')
    const out = renderCatalog({ ...template, tables: [chars] }, [
      readFor('important_characters', [])
    ])
    const expected = applyTemplate(chars.exportConfig.extraIndexInjectionTemplate, '')
    expect(out).toBe(expected)
    // matches synthesizeEntries' empty-table index-entry content
    const [indexEntry] = synthesizeEntries({ ...template, tables: [chars] }, [
      readFor('important_characters', [])
    ])
    expect(out).toBe(indexEntry.content)
  })

  it('disabled table contributes nothing (enabled:false → no catalogue block even if index-only elsewhere)', () => {
    const prot = table('protagonist_info') // exportConfig.enabled: false
    const out = renderCatalog({ ...template, tables: [prot] }, [
      readFor('protagonist_info', [prot.headers.map((_, i) => (i === 0 ? '1' : 'x'))])
    ])
    expect(out).toBe('')
  })

  it('table with no matching read contributes nothing', () => {
    const chars = table('important_characters')
    const out = renderCatalog({ ...template, tables: [chars] }, [])
    expect(out).toBe('')
  })
})

describe('filterEntriesByCodes', () => {
  // Synthesize real per-row chronicle entries keyed by their 编码索引 codes.
  const entriesFor = (codes: string[]) =>
    synthesizeEntries({ ...template, tables: [table('chronicle')] }, [
      readFor('chronicle', codes.map((c, i) => chronicleRow(c, `事件${i}`)))
    ])

  it('EXACT key match: MT001 must NOT match MT0012 (no substring collision)', () => {
    const entries = entriesFor(['MT001', 'MT0012'])
    const hit = filterEntriesByCodes(entries, ['MT001'], 10)
    expect(hit).toHaveLength(1)
    expect(hit[0].keys).toContain('MT001')
    expect(hit[0].keys).not.toContain('MT0012')
  })

  it('invented / out-of-corpus codes drop out (match nothing)', () => {
    const entries = entriesFor(['MT001', 'MT002'])
    expect(filterEntriesByCodes(entries, ['MT999'], 10)).toEqual([])
  })

  it('constant / always-on index entries (keys: []) never match a code', () => {
    const entries = entriesFor(['MT001'])
    // chronicle has extraIndexEnabled → there IS a constant index entry with keys []
    expect(entries.some((e) => e.constant && e.keys.length === 0)).toBe(true)
    const hit = filterEntriesByCodes(entries, ['MT001', 'MT002'], 10)
    expect(hit.every((e) => !e.constant)).toBe(true)
  })

  it('cap enforcement: never returns more than `cap` entries', () => {
    const entries = entriesFor(['MT001', 'MT002', 'MT003'])
    const hit = filterEntriesByCodes(entries, ['MT001', 'MT002', 'MT003'], 2)
    expect(hit).toHaveLength(2)
    expect(hit.map((e) => e.keys[0])).toEqual(['MT001', 'MT002'])
  })

  it('preserves entry (first-seen) order regardless of the codes order', () => {
    const entries = entriesFor(['MT001', 'MT002', 'MT003'])
    const hit = filterEntriesByCodes(entries, ['MT003', 'MT001'], 10)
    // result follows the ENTRIES order, not the codes order
    expect(hit.map((e) => e.keys[0])).toEqual(['MT001', 'MT003'])
  })

  it('cap <= 0 returns nothing', () => {
    const entries = entriesFor(['MT001'])
    expect(filterEntriesByCodes(entries, ['MT001'], 0)).toEqual([])
  })
})

describe('buildPlotBlock — beautification-regex contract', () => {
  // The EXACT `findRegex` of the user-installed 剧情推进美化正则 (profile regex 20de25c7…). The plot
  // block MUST match this so the renderer's beautifier fires; the render JS then re-parses the tags.
  const FIND_REGEX =
    /(^\s*(?:(?:以下|以上)是(?:用户|Participant)的本轮输入|<用户本轮输入>)[\s\S]*$)/m
  // getTag(raw, tag) as the beautifier's JS defines it: an attribute-tolerant CLOSED-tag extractor.
  const getTag = (text: string, tag: string): string | null => {
    const m = new RegExp('<' + tag + '(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(text)
    return m ? m[1].trim() : null
  }

  it('output matches findRegex AND embeds the QuestPlan/Recall/StoryEngine tags verbatim', () => {
    const block = buildPlotBlock({
      action: '走向黑塔',
      questPlan: '<QuestPlan>主线：抵达塔顶</QuestPlan>',
      recall: 'MT0001, MT0003',
      storyEngine: '节奏：紧张'
    })
    // (a) findRegex fires — the block opens with the <用户本轮输入> marker.
    expect(FIND_REGEX.test(block)).toBe(true)
    // (b) the render JS can extract each planning family the beautifier reads.
    expect(getTag(block, '用户本轮输入')).toBe('走向黑塔')
    // renderQuestPlan uses /<QuestPlan>([\s\S]*?)<\/QuestPlan>/i — present.
    expect(/<QuestPlan>[\s\S]*?<\/QuestPlan>/i.test(block)).toBe(true)
    // buildPlotBlock maps MT→AM in the <Recall> body so the beautifier's /AM\d+/ extractor populates.
    expect(getTag(block, 'Recall')).toBe('AM0001, AM0003')
    expect(getTag(block, 'StoryEngine')).toBe('节奏：紧张')
  })

  it('always keeps the <用户本轮输入> marker (so findRegex fires) even with all planning bodies empty', () => {
    const block = buildPlotBlock({ action: '', questPlan: '', recall: '', storyEngine: '' })
    expect(FIND_REGEX.test(block)).toBe(true)
    expect(block).toContain('<用户本轮输入>')
    // Empty families are dropped — no stray empty tags.
    expect(block).not.toContain('<QuestPlan>')
    expect(block).not.toContain('<Recall>')
    expect(block).not.toContain('<StoryEngine>')
  })
})

describe('codeColumnOf', () => {
  it('Can改-style config: first keywords column wins (编码索引)', () => {
    expect(codeColumnOf(table('chronicle').exportConfig)).toBe('编码索引')
  })

  it('important_characters: first of a multi-column keywords string (姓名)', () => {
    // keywords = '姓名,角色间关系' → first column
    expect(codeColumnOf(table('important_characters').exportConfig)).toBe('姓名')
  })

  it('no keywords → first index column whose mode is `both`', () => {
    expect(
      codeColumnOf({
        keywords: '',
        extraIndexColumns: ['概览', '编码索引'],
        extraIndexColumnModes: { 概览: 'index_only', 编码索引: 'both' }
      })
    ).toBe('编码索引')
  })

  it('no-code table → null (no keywords, no `both` index column)', () => {
    expect(
      codeColumnOf({
        keywords: '',
        extraIndexColumns: ['概览'],
        extraIndexColumnModes: { 概览: 'index_only' }
      })
    ).toBeNull()
  })

  it('blank/whitespace-only keywords are ignored, falls through to `both`', () => {
    expect(
      codeColumnOf({
        keywords: ' , ',
        extraIndexColumns: ['a', 'b'],
        extraIndexColumnModes: { a: 'index_only', b: 'both' }
      })
    ).toBe('b')
  })
})
