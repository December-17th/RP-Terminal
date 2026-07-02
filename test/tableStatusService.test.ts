import { describe, it, expect } from 'vitest'
import { mergeLastMaintained } from '../src/main/services/tableStatusService'

// Pure merge only (issue 06): getTablesStatus wraps resolveWorkflowDoc + node_state (DB-backed), which
// are not unit-tested here — same stance as the rest of the table-memory services.

describe('mergeLastMaintained', () => {
  it('takes the MAX last-maintained floor per table across gates', () => {
    expect(
      mergeLastMaintained([
        { chronicle: 3, chars: 1 },
        { chronicle: 5, region: 2 }
      ])
    ).toEqual({ chronicle: 5, chars: 1, region: 2 })
  })

  it('ignores undefined gate states', () => {
    expect(mergeLastMaintained([undefined, { a: 1 }, undefined])).toEqual({ a: 1 })
  })

  it('drops negative / non-finite / non-number entries (defensive)', () => {
    expect(
      mergeLastMaintained([{ a: -1, b: 0, c: NaN as unknown as number, d: 4 }])
    ).toEqual({ b: 0, d: 4 })
  })

  it('a table present in no gate is absent (→ never maintained)', () => {
    expect('missing' in mergeLastMaintained([{ a: 1 }])).toBe(false)
  })

  it('empty input → empty map', () => {
    expect(mergeLastMaintained([])).toEqual({})
  })
})
