import { describe, it, expect } from 'vitest'
import {
  columnWidthHint,
  filterRowIndices,
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
