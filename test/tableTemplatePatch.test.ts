import { describe, it, expect } from 'vitest'
import { applyTemplatePatch } from '../src/main/services/tableTemplateService'
import { TableTemplateSchema, type TableTemplate } from '../src/main/types/tableTemplate'
import { parseChatSheets, exportChatSheets } from '../src/main/parsers/chatSheetsParser'

/**
 * Unit tests for the PURE `applyTemplatePatch` (the Tables-view prompt editor's merge, issue 03). No
 * fs, no mocks — literal `TableTemplate` objects fed in. Asserts structural fields pass through
 * verbatim, unknown/malformed patches are rejected, and the input object is never mutated.
 */

const makeTemplate = (): TableTemplate =>
  TableTemplateSchema.parse({
    name: 'Two-table template',
    sourceFormat: 'native',
    tables: [
      {
        uid: 'uid-a',
        displayName: '纪要表',
        sqlName: 'chronicle',
        ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY, summary TEXT);',
        headers: ['row_id', 'summary'],
        initialRows: [['1', '开端']],
        note: 'note-a',
        initNode: 'init-a',
        insertNode: 'insert-a',
        updateNode: 'update-a',
        deleteNode: 'delete-a',
        updateFrequency: 1,
        exportConfig: {
          enabled: true,
          entryType: 'keyword',
          keywords: '编码索引',
          injectionTemplate: 'OLD $1',
          entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 5 }
        }
      },
      {
        uid: 'uid-b',
        displayName: '角色表',
        sqlName: 'characters',
        ddl: 'CREATE TABLE characters (row_id INTEGER PRIMARY KEY, name TEXT);',
        headers: ['row_id', 'name'],
        initialRows: [],
        note: 'note-b',
        initNode: 'init-b',
        insertNode: 'insert-b',
        updateNode: 'update-b',
        deleteNode: 'delete-b',
        updateFrequency: 3
      }
    ]
  })

const asOk = (r: TableTemplate | { error: string }): TableTemplate => {
  if ('error' in r) throw new Error(`expected success, got error: ${r.error}`)
  return r
}

describe('applyTemplatePatch', () => {
  it('patches one table’s five prompts + updateFrequency; leaves structural + other table verbatim', () => {
    const tpl = makeTemplate()
    const out = asOk(
      applyTemplatePatch(tpl, {
        tables: [
          {
            uid: 'uid-a',
            note: 'NOTE',
            initNode: 'INIT',
            insertNode: 'INSERT',
            updateNode: 'UPDATE',
            deleteNode: 'DELETE',
            updateFrequency: 4
          }
        ]
      })
    )

    const a = out.tables.find((t) => t.uid === 'uid-a')!
    expect(a.note).toBe('NOTE')
    expect(a.initNode).toBe('INIT')
    expect(a.insertNode).toBe('INSERT')
    expect(a.updateNode).toBe('UPDATE')
    expect(a.deleteNode).toBe('DELETE')
    expect(a.updateFrequency).toBe(4)

    // Structural fields on the patched table unchanged.
    expect(a.uid).toBe('uid-a')
    expect(a.sqlName).toBe('chronicle')
    expect(a.ddl).toBe(tpl.tables[0].ddl)
    expect(a.headers).toEqual(['row_id', 'summary'])
    expect(a.initialRows).toEqual([['1', '开端']])
    expect(a.displayName).toBe('纪要表')
    // Unpatched exportConfig passes through verbatim.
    expect(a.exportConfig).toEqual(tpl.tables[0].exportConfig)

    // The other table is untouched, and order is preserved.
    expect(out.tables[1]).toEqual(tpl.tables[1])
    expect(out.tables.map((t) => t.uid)).toEqual(['uid-a', 'uid-b'])
  })

  it('patches exportConfig (parsed/normalized) — injectionTemplate, keywords, entryPlacement.depth', () => {
    const tpl = makeTemplate()
    const out = asOk(
      applyTemplatePatch(tpl, {
        tables: [
          {
            uid: 'uid-a',
            exportConfig: {
              enabled: true,
              entryType: 'keyword',
              keywords: 'NEWKEY',
              injectionTemplate: 'NEW $1',
              entryPlacement: { position: 'at_depth_as_system', depth: 9, order: 5 }
            }
          }
        ]
      })
    )
    const a = out.tables.find((t) => t.uid === 'uid-a')!
    expect(a.exportConfig.injectionTemplate).toBe('NEW $1')
    expect(a.exportConfig.keywords).toBe('NEWKEY')
    expect(a.exportConfig.entryPlacement.depth).toBe(9)
    // Zod-normalized: omitted placements/fields get schema defaults.
    expect(a.exportConfig.splitByRow).toBe(false)
    expect(a.exportConfig.extraIndexPlacement).toEqual({
      position: 'at_depth_as_system',
      depth: 0,
      order: 0
    })
  })

  it('rejects an unknown uid without mutating the input', () => {
    const tpl = makeTemplate()
    const before = JSON.parse(JSON.stringify(tpl))
    const res = applyTemplatePatch(tpl, { tables: [{ uid: 'uid-nope', note: 'x' }] })
    expect(res).toEqual({ error: 'tables.templateUnknownTable' })
    expect(tpl).toEqual(before)
  })

  it('rejects a malformed patch (updateFrequency 0)', () => {
    const res = applyTemplatePatch(makeTemplate(), {
      tables: [{ uid: 'uid-a', updateFrequency: 0 }]
    })
    expect(res).toEqual({ error: 'tables.templateBadPatch' })
  })

  it('rejects a malformed patch (tables not an array)', () => {
    const res = applyTemplatePatch(makeTemplate(), { tables: 'nope' })
    expect(res).toEqual({ error: 'tables.templateBadPatch' })
  })

  it('renames the template at the top level', () => {
    const out = asOk(applyTemplatePatch(makeTemplate(), { name: 'Renamed', tables: [] }))
    expect(out.name).toBe('Renamed')
  })

  it('round-trips through chatSheets export/import after a prompt-only patch', () => {
    const tpl = makeTemplate()
    const patched = asOk(
      applyTemplatePatch(tpl, {
        tables: [{ uid: 'uid-a', note: 'ROUND', insertNode: 'TRIP' }]
      })
    )
    // parse(export(patched)) must deep-equal patched (sourceFormat flips to chatSheets-v2 by design).
    const roundTripped = parseChatSheets(exportChatSheets(patched), patched.name)
    expect(roundTripped).toEqual({ ...patched, sourceFormat: 'chatSheets-v2' })
  })
})
