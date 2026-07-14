import { describe, it, expect } from 'vitest'
import {
  maintenanceSummary,
  type TableStatusLike
} from '../src/renderer/src/components/workspace/memoryPaneModel'

// The maintenance-summary roll-up (memoryPaneModel — trimmed in table-refill WS6 Phase B: the
// MemoryPane it once modelled is deleted; the pane-mode + memory-pack-strip derivations went with it.
// This aggregate survives as the TopStrip memory chip's (记忆 · N) backlog source). Pure, no IPC.

describe('maintenanceSummary', () => {
  const st = (unprocessed: number): TableStatusLike => ({
    lastFloor: 0,
    processed: 0,
    nextExpected: 1,
    unprocessed
  })

  it('empty status → no tables, no backlog', () => {
    const s = maintenanceSummary({})
    expect(s).toEqual({ tableCount: 0, maxUnprocessed: 0, hasBacklog: false })
  })

  it('takes the max unprocessed across tables and flags a backlog', () => {
    const s = maintenanceSummary({ a: st(0), b: st(4), c: st(2) })
    expect(s.tableCount).toBe(3)
    expect(s.maxUnprocessed).toBe(4)
    expect(s.hasBacklog).toBe(true)
  })

  it('all tables caught up → no backlog', () => {
    const s = maintenanceSummary({ a: st(0), b: st(0) })
    expect(s.hasBacklog).toBe(false)
    expect(s.maxUnprocessed).toBe(0)
  })
})
