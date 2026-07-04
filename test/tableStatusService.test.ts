import { describe, it, expect } from 'vitest'
import {
  effectiveFrequencies,
  resolveUpdateFrequency
} from '../src/main/services/tableStatusService'
import { TableTemplateSchema, TableTemplate } from '../src/main/types/tableTemplate'

// Pure effective-frequency merge for the Tables view status (the table-maintenance cadence fix):
// the status must predict 下次维护 with the SAME rule the gate fires on, so gate `every` overrides
// replace the template's per-table frequencies for the tables each gate watches. Per-table values are
// RESOLVED against the app global default first (manual-pass issue 04): -1 → global, 0 → off (omitted).

const GLOBAL = 3 // the app default cadence used across these cases

const template = (): TableTemplate =>
  TableTemplateSchema.parse({
    name: 't',
    sourceFormat: 'native',
    tables: [
      {
        uid: 'c',
        displayName: '纪要表',
        sqlName: 'chronicle',
        ddl: 'CREATE TABLE chronicle (row_id INTEGER);',
        headers: ['row_id'],
        updateFrequency: 1
      },
      {
        uid: 'w',
        displayName: '世界表',
        sqlName: 'world',
        ddl: 'CREATE TABLE world (row_id INTEGER);',
        headers: ['row_id'],
        updateFrequency: 3
      }
    ]
  })

// A template mixing the two new sentinels: a -1 (use-global) table and a 0 (off) table.
const sentinelTemplate = (): TableTemplate =>
  TableTemplateSchema.parse({
    name: 't',
    sourceFormat: 'native',
    tables: [
      {
        uid: 'g',
        displayName: '全局表',
        sqlName: 'global_t',
        ddl: 'CREATE TABLE global_t (row_id INTEGER);',
        headers: ['row_id'],
        updateFrequency: -1
      },
      {
        uid: 'o',
        displayName: '关闭表',
        sqlName: 'off_t',
        ddl: 'CREATE TABLE off_t (row_id INTEGER);',
        headers: ['row_id'],
        updateFrequency: 0
      }
    ]
  })

describe('resolveUpdateFrequency', () => {
  it('-1 → the global default; 0 → null (off); N>=1 → N; garbage → global default', () => {
    expect(resolveUpdateFrequency(-1, 3)).toBe(3)
    expect(resolveUpdateFrequency(0, 3)).toBeNull()
    expect(resolveUpdateFrequency(5, 3)).toBe(5)
    // garbage (any other value) is treated as -1 → the global default
    expect(resolveUpdateFrequency(-7, 4)).toBe(4)
    // a zero/NaN global default falls back to 3; a negative one clamps up to the floor of 1.
    expect(resolveUpdateFrequency(-1, 0)).toBe(3)
    expect(resolveUpdateFrequency(-1, Number.NaN)).toBe(3)
    expect(resolveUpdateFrequency(-1, -2)).toBe(1) // Math.max(1, -2) — the spec formula's clamp
  })
})

describe('effectiveFrequencies', () => {
  it('no gates / no overrides → the template frequencies as-is', () => {
    expect(effectiveFrequencies(template(), [], GLOBAL)).toEqual({ chronicle: 1, world: 3 })
    expect(effectiveFrequencies(template(), [{ tables: 'chronicle' }], GLOBAL)).toEqual({
      chronicle: 1,
      world: 3
    })
  })

  it('an unfiltered gate with `every` overrides EVERY table', () => {
    expect(effectiveFrequencies(template(), [{ every: 5 }], GLOBAL)).toEqual({
      chronicle: 5,
      world: 5
    })
  })

  it('a tables-filtered gate overrides only its watched tables', () => {
    expect(effectiveFrequencies(template(), [{ every: 5, tables: 'chronicle' }], GLOBAL)).toEqual({
      chronicle: 5,
      world: 3
    })
  })

  it('several overriding gates on one table → the LOWEST every wins (soonest fire drives 下次维护)', () => {
    expect(
      effectiveFrequencies(template(), [{ every: 5 }, { every: 2, tables: 'chronicle' }], GLOBAL)
    ).toEqual({ chronicle: 2, world: 5 })
  })

  it('unknown watched names are ignored', () => {
    expect(effectiveFrequencies(template(), [{ every: 5, tables: 'nope' }], GLOBAL)).toEqual({
      chronicle: 1,
      world: 3
    })
  })

  it('resolves sentinels: -1 → the global default; 0 (off) is OMITTED from the map', () => {
    expect(effectiveFrequencies(sentinelTemplate(), [], 4)).toEqual({ global_t: 4 })
  })

  it('a gate `every` override re-includes an OFF table (explicit author intent)', () => {
    expect(effectiveFrequencies(sentinelTemplate(), [{ every: 2 }], 4)).toEqual({
      global_t: 2,
      off_t: 2
    })
  })
})
