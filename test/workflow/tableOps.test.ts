import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  replayPlan,
  tryBeginTableWrite,
  endTableWrite,
  TableOp
} from '../../src/main/services/tableOpsService'

// Pure rewind-plan + per-chat write-lock tests (issue 03). Live state-equality after a rebuild is
// NOT testable under the better-sqlite3 alias mock (the native binary can't load under plain Node);
// the plan adjusts the issue's state-equality AC to pinning `replayPlan` (which ops survive a cut,
// order, floor attribution) + the lock instead. See the plan's Testing section.

describe('replayPlan', () => {
  const ops: TableOp[] = [
    { floor: 0, seq: 0, sql: 'A' },
    { floor: 0, seq: 1, sql: 'B' },
    { floor: 2, seq: 0, sql: 'C' },
    { floor: 1, seq: 0, sql: 'D' },
    { floor: 3, seq: 0, sql: 'E' }
  ]

  it('keeps only ops with floor < fromFloor, in (floor, seq) order', () => {
    expect(replayPlan(ops, 2).map((o) => o.sql)).toEqual(['A', 'B', 'D'])
  })

  it('a cut at floor 0 drops everything', () => {
    expect(replayPlan(ops, 0)).toEqual([])
  })

  it('a cut past the last floor keeps all, still ordered', () => {
    expect(replayPlan(ops, 99).map((o) => o.sql)).toEqual(['A', 'B', 'D', 'C', 'E'])
  })

  it('orders within a floor by seq', () => {
    const same: TableOp[] = [
      { floor: 5, seq: 2, sql: 'z' },
      { floor: 5, seq: 0, sql: 'x' },
      { floor: 5, seq: 1, sql: 'y' }
    ]
    expect(replayPlan(same, 6).map((o) => o.sql)).toEqual(['x', 'y', 'z'])
  })

  it('does not mutate the input array', () => {
    const input = [...ops]
    replayPlan(input, 2)
    expect(input).toEqual(ops)
  })
})

describe('per-chat write lock', () => {
  afterEach(() => {
    vi.useRealTimers()
    // Release any held slots so tests don't leak across the module-level Map.
    endTableWrite('lockchat')
    endTableWrite('a')
    endTableWrite('b')
  })

  it('claims once, then refuses a second claim until released', () => {
    expect(tryBeginTableWrite('lockchat')).toBe(true)
    expect(tryBeginTableWrite('lockchat')).toBe(false)
    endTableWrite('lockchat')
    expect(tryBeginTableWrite('lockchat')).toBe(true)
  })

  it('is per-chat (a claim on one does not block another)', () => {
    expect(tryBeginTableWrite('a')).toBe(true)
    expect(tryBeginTableWrite('b')).toBe(true)
  })

  it('a stale claim expires after the guard window', () => {
    vi.useFakeTimers()
    expect(tryBeginTableWrite('lockchat')).toBe(true)
    expect(tryBeginTableWrite('lockchat')).toBe(false)
    vi.advanceTimersByTime(120_001)
    // The prior holder never released, but the slot self-heals past the 2-minute expiry.
    expect(tryBeginTableWrite('lockchat')).toBe(true)
  })
})
