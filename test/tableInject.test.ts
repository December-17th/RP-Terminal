import { describe, it, expect } from 'vitest'
import {
  resolveInjectionPolicy,
  capInjectionRows,
  renderInjectionTable,
  renderInjectionBlock,
  injectionReadLimits
} from '../src/main/services/tableMaintenance'
import { TableTemplateSchema, type TableTemplate } from '../src/main/types/tableTemplate'
import type { TableRead } from '../src/main/services/tableDbService'

/**
 * WS4 — the PURE injection-consumption decisions (D10): policy resolution, cap math (which rows
 * survive + marker count), and the capped per-table block rendering. No fs, no sandbox — literal rows +
 * templates. The `table.inject` node is the thin I/O wrapper over these.
 */

describe('resolveInjectionPolicy', () => {
  it('defaults a missing policy to recent-N at the global cap', () => {
    expect(resolveInjectionPolicy(undefined, 20)).toEqual({ mode: 'recent', cap: 20 })
  })

  it('per-table rows OVERRIDES the global cap', () => {
    expect(resolveInjectionPolicy({ mode: 'recent', rows: 5 }, 20)).toEqual({ mode: 'recent', cap: 5 })
  })

  it('carries full / none modes through (cap irrelevant for them)', () => {
    expect(resolveInjectionPolicy({ mode: 'full' }, 20).mode).toBe('full')
    expect(resolveInjectionPolicy({ mode: 'none' }, 20).mode).toBe('none')
  })

  it('clamps a zero / negative / non-finite cap to 0', () => {
    expect(resolveInjectionPolicy({ mode: 'recent', rows: 0 }, 20).cap).toBe(0)
    expect(resolveInjectionPolicy(undefined, -3).cap).toBe(0)
    expect(resolveInjectionPolicy(undefined, Number.NaN).cap).toBe(0)
    // A fractional global cap floors.
    expect(resolveInjectionPolicy(undefined, 4.9).cap).toBe(4)
  })
})

describe('capInjectionRows', () => {
  const rows = [['a'], ['b'], ['c'], ['d'], ['e']]

  it('recent keeps the LAST N rows and reports the count omitted off the front', () => {
    expect(capInjectionRows(rows, { mode: 'recent', cap: 2 })).toEqual({
      rows: [['d'], ['e']],
      omitted: 3
    })
  })

  it('recent with cap >= length keeps all, omitted 0', () => {
    expect(capInjectionRows(rows, { mode: 'recent', cap: 5 })).toEqual({ rows, omitted: 0 })
    expect(capInjectionRows(rows, { mode: 'recent', cap: 99 })).toEqual({ rows, omitted: 0 })
  })

  it('recent with cap 0 keeps NOTHING (guards the slice(-0) whole-array trap) and omits all', () => {
    expect(capInjectionRows(rows, { mode: 'recent', cap: 0 })).toEqual({ rows: [], omitted: 5 })
  })

  it('full keeps everything and never truncates', () => {
    expect(capInjectionRows(rows, { mode: 'full', cap: 2 })).toEqual({ rows, omitted: 0 })
  })

  it('none keeps nothing, omitted 0 (excluded, not truncated)', () => {
    expect(capInjectionRows(rows, { mode: 'none', cap: 2 })).toEqual({ rows: [], omitted: 0 })
  })

  // P1-5: when `rows` was already SQL-bounded (only the newest cap), the caller passes the true total so
  // the omitted count stays correct without the older rows ever being materialized.
  it('recent with an explicit total treats pre-bounded rows as the newest cap and omits total - cap', () => {
    // `rows` holds ONLY the last 2 (SQL LIMIT 2), but the table really has 5.
    expect(capInjectionRows([['d'], ['e']], { mode: 'recent', cap: 2 }, 5)).toEqual({
      rows: [['d'], ['e']],
      omitted: 3
    })
  })

  it('recent total <= cap → keep the pre-bounded rows, omitted 0', () => {
    expect(capInjectionRows([['a'], ['b']], { mode: 'recent', cap: 5 }, 2)).toEqual({
      rows: [['a'], ['b']],
      omitted: 0
    })
  })

  it('recent cap 0 with an explicit total omits the whole (unmaterialized) table', () => {
    expect(capInjectionRows([], { mode: 'recent', cap: 0 }, 42)).toEqual({ rows: [], omitted: 42 })
  })
})

describe('injectionReadLimits (P1-5 SQL row caps)', () => {
  const def = (over: Record<string, unknown>) => ({
    uid: String(over.sqlName),
    displayName: String(over.sqlName),
    ddl: `CREATE TABLE ${over.sqlName} (row_id INTEGER, text TEXT)`,
    headers: ['row_id', 'text'],
    ...over
  })

  it('maps recent → its resolved cap, full → null (unbounded), none / 0-cap → 0', () => {
    const tpl = TableTemplateSchema.parse({
      name: 't',
      tables: [
        def({ sqlName: 'recent_t', injectionPolicy: { mode: 'recent', rows: 3 } }),
        def({ sqlName: 'full_t', injectionPolicy: { mode: 'full' } }),
        def({ sqlName: 'none_t', injectionPolicy: { mode: 'none' } }),
        def({ sqlName: 'zero_t', injectionPolicy: { mode: 'recent', rows: 0 } }),
        def({ sqlName: 'default_t' }) // no policy → recent at the global cap
      ]
    })
    const limits = injectionReadLimits(tpl, 20)
    expect(limits.get('recent_t')).toBe(3)
    expect(limits.get('full_t')).toBeNull()
    expect(limits.get('none_t')).toBe(0)
    expect(limits.get('zero_t')).toBe(0)
    expect(limits.get('default_t')).toBe(20)
  })
})

const templateWith = (tables: Array<Record<string, unknown>>): TableTemplate =>
  TableTemplateSchema.parse({ name: 't', tables })

const read = (sqlName: string, rows: unknown[][]): TableRead => ({
  sqlName,
  displayName: sqlName,
  columns: [],
  rows,
  rowids: rows.map((_, i) => i + 1)
})

describe('renderInjectionTable', () => {
  const def = {
    uid: 'u',
    sqlName: 'summary',
    displayName: '纪要',
    ddl: 'CREATE TABLE summary (row_id INTEGER PRIMARY KEY, text TEXT)',
    headers: ['row_id', 'text']
  }

  it('emits the truncation marker with the omitted count when recent truncates', () => {
    const tpl = templateWith([{ ...def, injectionPolicy: { mode: 'recent', rows: 1 } }])
    const out = renderInjectionTable(tpl.tables[0], read('summary', [['1', 'old'], ['2', 'new']]), 20)
    expect(out).toContain('## 纪要（summary）')
    expect(out).toContain('2 | new')
    expect(out).not.toContain('1 | old')
    expect(out).toContain('…（省略 1 行较早记录）')
  })

  it('full renders all rows with NO marker', () => {
    const tpl = templateWith([{ ...def, injectionPolicy: { mode: 'full' } }])
    const out = renderInjectionTable(tpl.tables[0], read('summary', [['1', 'a'], ['2', 'b']]), 1)!
    expect(out).toContain('1 | a')
    expect(out).toContain('2 | b')
    expect(out).not.toContain('省略')
  })

  it('none → null (excluded)', () => {
    const tpl = templateWith([{ ...def, injectionPolicy: { mode: 'none' } }])
    expect(renderInjectionTable(tpl.tables[0], read('summary', [['1', 'a']]), 20)).toBeNull()
  })

  it('an empty table → null (no empty header)', () => {
    const tpl = templateWith([def])
    expect(renderInjectionTable(tpl.tables[0], read('summary', []), 20)).toBeNull()
    expect(renderInjectionTable(tpl.tables[0], undefined, 20)).toBeNull()
  })

  it('uses the DDL real column names, not the display headers', () => {
    const tpl = templateWith([def])
    const out = renderInjectionTable(tpl.tables[0], read('summary', [['1', 'x']]), 20)!
    expect(out).toContain('row_id | text')
  })
})

describe('renderInjectionBlock', () => {
  const a = {
    uid: 'a',
    sqlName: 'summary',
    displayName: '纪要',
    ddl: 'CREATE TABLE summary (row_id INTEGER, text TEXT)',
    headers: ['row_id', 'text']
  }
  const b = {
    uid: 'b',
    sqlName: 'chars',
    displayName: '角色',
    ddl: 'CREATE TABLE chars (row_id INTEGER, name TEXT)',
    headers: ['row_id', 'name']
  }

  it('joins every contributing table under one intro header, skipping none / empty', () => {
    const tpl = templateWith([
      { ...a, injectionPolicy: { mode: 'full' } },
      { ...b, injectionPolicy: { mode: 'none' } }
    ])
    const block = renderInjectionBlock(tpl, [read('summary', [['1', 'hi']]), read('chars', [['1', 'X']])], 20)
    expect(block).toContain('【记忆表格】')
    expect(block).toContain('## 纪要（summary）')
    expect(block).not.toContain('## 角色（chars）') // 'none' excluded
  })

  it('returns "" when NO table contributes (all empty / all none)', () => {
    const tpl = templateWith([a, b])
    expect(renderInjectionBlock(tpl, [read('summary', []), read('chars', [])], 20)).toBe('')
    const noneTpl = templateWith([
      { ...a, injectionPolicy: { mode: 'none' } },
      { ...b, injectionPolicy: { mode: 'none' } }
    ])
    expect(renderInjectionBlock(noneTpl, [read('summary', [['1', 'x']])], 20)).toBe('')
  })

  it('per-table override beats the global cap in the composed block', () => {
    const tpl = templateWith([{ ...a, injectionPolicy: { mode: 'recent', rows: 1 } }])
    const block = renderInjectionBlock(tpl, [read('summary', [['1', 'old'], ['2', 'new']])], 99)
    expect(block).toContain('…（省略 1 行较早记录）')
  })
})
