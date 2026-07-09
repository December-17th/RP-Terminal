import { describe, it, expect } from 'vitest'
import {
  columnWidthHint,
  filterRowIndices,
  pageInfo,
  pageSlice,
  pointerSpec
} from '../src/renderer/src/components/workspace/tableGridModel'

// The shared memory-table grid's pure model (agent-memory-ux WP-I; spec §8).

describe('filterRowIndices', () => {
  const rows: unknown[][] = [
    [1, 'Alice met the dragon', 'forest'],
    [2, 'Bob slept', 'inn'],
    [3, null, 'DRAGON lair']
  ]
  it('blank query keeps every index', () => {
    expect(filterRowIndices(rows, '')).toEqual([0, 1, 2])
    expect(filterRowIndices(rows, '   ')).toEqual([0, 1, 2])
  })
  it('case-insensitive substring over any cell, ORIGINAL indices preserved', () => {
    expect(filterRowIndices(rows, 'dragon')).toEqual([0, 2])
    expect(filterRowIndices(rows, 'inn')).toEqual([1])
    expect(filterRowIndices(rows, 'nothing')).toEqual([])
  })
  it('null cells never match; numbers match by string form', () => {
    expect(filterRowIndices(rows, '2')).toEqual([1])
  })
})

describe('pointerSpec', () => {
  it('never-processed → the never key', () => {
    expect(pointerSpec(null)).toEqual({ kind: 'never', key: 'tables.progressNever' })
    expect(pointerSpec(undefined)).toEqual({ kind: 'never', key: 'tables.progressNever' })
    expect(
      pointerSpec({ lastFloor: null, processed: 0, nextExpected: 0, unprocessed: 0 })
    ).toEqual({ kind: 'never', key: 'tables.progressNever' })
  })
  it('processed → ONE keyed pattern with params (never concatenated fragments)', () => {
    expect(
      pointerSpec({ lastFloor: 9, processed: 10, nextExpected: 13, unprocessed: 2 })
    ).toEqual({
      kind: 'at',
      key: 'tables.pointerLine',
      params: { processed: 10, next: 13, unprocessed: 2 }
    })
  })
})

describe('pageInfo', () => {
  it('reports page count and the 1-based row range for a mid list', () => {
    // 65 rows, 30/page → 3 pages; page 1 (0-based) shows rows 31–60.
    expect(pageInfo(65, 1, 30)).toEqual({ page: 1, pageCount: 3, from: 31, to: 60, total: 65 })
    // Last page is short: rows 61–65.
    expect(pageInfo(65, 2, 30)).toEqual({ page: 2, pageCount: 3, from: 61, to: 65, total: 65 })
  })
  it('clamps an over-range page to the last page (a shrinking filter never strands the view)', () => {
    expect(pageInfo(10, 9, 30)).toEqual({ page: 0, pageCount: 1, from: 1, to: 10, total: 10 })
    expect(pageInfo(65, -5, 30).page).toBe(0)
  })
  it('empty list → one page, a 0-length range', () => {
    expect(pageInfo(0, 3, 30)).toEqual({ page: 0, pageCount: 1, from: 0, to: 0, total: 0 })
  })
  it('guards a non-positive page size', () => {
    expect(pageInfo(5, 0, 0)).toEqual({ page: 0, pageCount: 5, from: 1, to: 1, total: 5 })
  })
})

describe('pageSlice', () => {
  const items = Array.from({ length: 65 }, (_, i) => i)
  it('slices the requested page, agreeing with pageInfo', () => {
    expect(pageSlice(items, 0, 30)).toEqual(items.slice(0, 30))
    expect(pageSlice(items, 2, 30)).toEqual(items.slice(60, 65))
  })
  it('clamps an over-range page to the last page', () => {
    expect(pageSlice(items, 99, 30)).toEqual(items.slice(60, 65))
  })
  it('empty list → empty slice', () => {
    expect(pageSlice([], 0, 30)).toEqual([])
  })
})

describe('columnWidthHint', () => {
  const rows: unknown[][] = [
    ['1', 'a moderately long prose cell in this column', 'x'],
    ['22', 'short', null]
  ]
  it('clamps between min and max around the longest of header + sampled cells', () => {
    // Short id column: header 'id' (2) + longest cell '22' (2) + 2 → below min → min.
    expect(columnWidthHint('id', rows, 0)).toBe(6)
    // Prose column: longest cell 43 chars + 2 = 45 < max 48.
    expect(columnWidthHint('c', rows, 1)).toBe(45)
    // Cap at max.
    expect(columnWidthHint('c', rows, 1, { max: 30 })).toBe(30)
  })
  it('null cells are skipped; header alone drives an empty column', () => {
    expect(columnWidthHint('location', [], 0)).toBe(10)
  })
})
