import { describe, it, expect } from 'vitest'
import { effectiveFrequencies } from '../src/main/services/tableStatusService'
import { TableTemplateSchema, TableTemplate } from '../src/main/types/tableTemplate'

// Pure effective-frequency merge for the Tables view status (the table-maintenance cadence fix):
// the status must predict 下次维护 with the SAME rule the gate fires on, so gate `every` overrides
// replace the template's per-table frequencies for the tables each gate watches.

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

describe('effectiveFrequencies', () => {
  it('no gates / no overrides → the template frequencies as-is', () => {
    expect(effectiveFrequencies(template(), [])).toEqual({ chronicle: 1, world: 3 })
    expect(effectiveFrequencies(template(), [{ tables: 'chronicle' }])).toEqual({
      chronicle: 1,
      world: 3
    })
  })

  it('an unfiltered gate with `every` overrides EVERY table', () => {
    expect(effectiveFrequencies(template(), [{ every: 5 }])).toEqual({
      chronicle: 5,
      world: 5
    })
  })

  it('a tables-filtered gate overrides only its watched tables', () => {
    expect(effectiveFrequencies(template(), [{ every: 5, tables: 'chronicle' }])).toEqual({
      chronicle: 5,
      world: 3
    })
  })

  it('several overriding gates on one table → the LOWEST every wins (soonest fire drives 下次维护)', () => {
    expect(
      effectiveFrequencies(template(), [{ every: 5 }, { every: 2, tables: 'chronicle' }])
    ).toEqual({ chronicle: 2, world: 5 })
  })

  it('unknown watched names are ignored', () => {
    expect(effectiveFrequencies(template(), [{ every: 5, tables: 'nope' }])).toEqual({
      chronicle: 1,
      world: 3
    })
  })
})
