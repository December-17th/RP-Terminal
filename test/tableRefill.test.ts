import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// table-refill WS2 — the refill engine's DECISIONS are pure exported helpers (the house testing stance:
// the SQLite/fs shadow-build / publish / commit I/O is alias-mock-untestable, so every decision — what to
// replay, what to cut, what to commit, whether to abort, where to resume — lives in a pure function that
// is unit-tested here). Plus the token-owned write guard (pure Map logic in tableOpsService). electron +
// better-sqlite3 are globally aliased to stubs (vitest.config), so both real modules import cleanly.

import {
  shouldReplayIntoShadow,
  partitionBySelected,
  defaultRefillFrom,
  refillBaselineBlocked,
  watermarkMoved,
  resumeRefillFrom,
  planChunkCommit,
  refillRunOutcome
} from '../src/main/services/tableRefillService'
import {
  beginTableWrite,
  renewTableWrite,
  endTableWrite,
  tryBeginTableWrite
} from '../src/main/services/tableOpsService'

describe('shouldReplayIntoShadow — the shadow rollback predicate', () => {
  const selected = new Set(['characters'])
  it('drops a selected table op at/after the cut (the tail being regenerated)', () => {
    expect(shouldReplayIntoShadow({ targetTable: 'characters', floor: 5 }, selected, 5)).toBe(false)
    expect(shouldReplayIntoShadow({ targetTable: 'characters', floor: 9 }, selected, 5)).toBe(false)
  })
  it('keeps a selected table op BELOW the cut (base state as of fromFloor-1)', () => {
    expect(shouldReplayIntoShadow({ targetTable: 'characters', floor: 4 }, selected, 5)).toBe(true)
  })
  it('keeps an UNSELECTED table op at any floor (its latest state is preserved)', () => {
    expect(shouldReplayIntoShadow({ targetTable: 'world', floor: 9 }, selected, 5)).toBe(true)
  })
  it("keeps '*' / NULL target ops always (the always-replay tail)", () => {
    expect(shouldReplayIntoShadow({ targetTable: '*', floor: 9 }, selected, 5)).toBe(true)
    expect(shouldReplayIntoShadow({ targetTable: null, floor: 9 }, selected, 5)).toBe(true)
  })
})

describe('partitionBySelected — the write-scope filter', () => {
  it('keeps selected-table statements, drops the rest, preserving order', () => {
    const validated = [
      { kind: 'insert', table: 'characters', sql: 'A' },
      { kind: 'update', table: 'world', sql: 'B' },
      { kind: 'delete', table: 'characters', sql: 'C' }
    ] as never
    const { kept, dropped } = partitionBySelected(validated, new Set(['characters']))
    expect(kept).toEqual(['A', 'C'])
    expect(dropped).toEqual(['B'])
  })
})

describe('defaultRefillFrom — the clamped earliest-un-maintained cutpoint', () => {
  it('is min(last+1) over selected tables', () => {
    // characters last 4 → 5; world last 2 → 3; min = 3.
    expect(defaultRefillFrom({ characters: 4, world: 2 }, ['characters', 'world'], 9)).toBe(3)
  })
  it('a never-processed table contributes 0', () => {
    expect(defaultRefillFrom({ characters: 4 }, ['characters', 'world'], 9)).toBe(0)
  })
  it('clamps to latest when every pointer is already current (run-now stays meaningful)', () => {
    // Both current at floor 9 → min(10) clamped to latest 9.
    expect(defaultRefillFrom({ characters: 9, world: 9 }, ['characters', 'world'], 9)).toBe(9)
  })
  it('an empty chat (latest < 0) → 0', () => {
    expect(defaultRefillFrom({}, ['characters'], -1)).toBe(0)
  })
})

describe('refillBaselineBlocked — the structural re-baseline gate', () => {
  it('blocks a partial refill of a baselined table', () => {
    expect(refillBaselineBlocked(5, true)).toBe(true)
  })
  it('allows a partial refill with no baseline, and a full (from 0) refill always', () => {
    expect(refillBaselineBlocked(5, false)).toBe(false)
    expect(refillBaselineBlocked(0, true)).toBe(false)
  })
})

describe('watermarkMoved — the interleave check (only an increase is foreign)', () => {
  it('true when the observed max rose above the expected (a foreign insert)', () => {
    expect(watermarkMoved(11, 10)).toBe(true)
  })
  it('false when unchanged or lowered (our own tail deletes)', () => {
    expect(watermarkMoved(10, 10)).toBe(false)
    expect(watermarkMoved(8, 10)).toBe(false)
  })
})

describe('resumeRefillFrom — where a resumed refill restarts', () => {
  it('resumes just after the last committed floor', () => {
    expect(resumeRefillFrom(3, 6)).toBe(7)
  })
  it('resumes at the original cutpoint when nothing committed (completedUntil -1)', () => {
    expect(resumeRefillFrom(3, -1)).toBe(3)
  })
})

describe('planChunkCommit — chunk op-set assembly + first-chunk-only cut', () => {
  it('the first COMMITTED chunk carries the tail cut; ops attributed to span.to', () => {
    const plan = planChunkCommit(false, ['characters', 'world'], 3, ['INS1', 'INS2'], 6)
    expect(plan.cut).toEqual({ tables: ['characters', 'world'], fromFloor: 3 })
    expect(plan.floorOps).toEqual([
      { floor: 6, sql: 'INS1' },
      { floor: 6, sql: 'INS2' }
    ])
  })
  it('later chunks carry NO cut', () => {
    const plan = planChunkCommit(true, ['characters'], 3, ['INS3'], 8)
    expect(plan.cut).toBeNull()
    expect(plan.floorOps).toEqual([{ floor: 8, sql: 'INS3' }])
  })
  it('an empty batch still carries the cut on the first chunk (drops the stale tail)', () => {
    const plan = planChunkCommit(false, ['characters'], 0, [], 2)
    expect(plan.cut).toEqual({ tables: ['characters'], fromFloor: 0 })
    expect(plan.floorOps).toEqual([])
  })
})

describe('refillRunOutcome — stop-on-failure terminal branch (review fix F1)', () => {
  it('a failed batch ⇒ terminal error, NO finalize (pointers untouched, progress row retained)', () => {
    // Unlike backfill's continue-on-failure: the tail is already CUT, so skipping a failed span and
    // finalizing would advance the pointers over a permanent, non-resumable hole. Stop-and-resume.
    expect(refillRunOutcome(false, 'model gave up')).toEqual({
      status: 'error',
      finalize: false,
      message: 'model gave up'
    })
  })
  it('a failure outranks a concurrent cancel (the reason is what the user needs)', () => {
    expect(refillRunOutcome(true, 'boom')).toEqual({ status: 'error', finalize: false, message: 'boom' })
  })
  it('a cancel without failure ⇒ cancelled, NO finalize (also resumable)', () => {
    expect(refillRunOutcome(true, null)).toEqual({ status: 'cancelled', finalize: false })
  })
  it('a clean full run ⇒ done + finalize (advance pointers, delete the progress row)', () => {
    expect(refillRunOutcome(false, null)).toEqual({ status: 'done', finalize: true })
  })
})

describe('token-owned write guard (begin / renew / end)', () => {
  afterEach(() => {
    vi.useRealTimers()
    endTableWrite('chatG') // best-effort cleanup (unconditional)
  })

  it('begin claims the slot; a second begin is refused while held', () => {
    const token = beginTableWrite('chatG')
    expect(token).not.toBeNull()
    expect(beginTableWrite('chatG')).toBeNull()
    endTableWrite('chatG', token!)
    // Released → a fresh claim succeeds.
    const again = beginTableWrite('chatG')
    expect(again).not.toBeNull()
    endTableWrite('chatG', again!)
  })

  it('renew refreshes only the owning token', () => {
    const token = beginTableWrite('chatG')!
    expect(renewTableWrite('chatG', token)).toBe(true)
    expect(renewTableWrite('chatG', 'not-the-token')).toBe(false)
    endTableWrite('chatG', token)
  })

  it('token-checked end never frees a DIFFERENT owner claim', () => {
    const token = beginTableWrite('chatG')!
    endTableWrite('chatG', 'stale-token') // wrong token → no release
    expect(beginTableWrite('chatG')).toBeNull() // still held
    endTableWrite('chatG', token) // correct token → releases
    const fresh = beginTableWrite('chatG')
    expect(fresh).not.toBeNull()
    endTableWrite('chatG', fresh!)
  })

  it('the legacy pair are wrappers over the token guard', () => {
    expect(tryBeginTableWrite('chatG')).toBe(true)
    expect(tryBeginTableWrite('chatG')).toBe(false) // held
    endTableWrite('chatG') // unconditional legacy release
    expect(tryBeginTableWrite('chatG')).toBe(true)
    endTableWrite('chatG')
  })

  it('an expired claim (past the 120s stale window) is reclaimable, and renew of the lost token fails', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const token = beginTableWrite('chatG')!
    vi.setSystemTime(120_001) // past WRITE_GUARD_MS
    const reclaimed = beginTableWrite('chatG') // stale → a new owner claims it
    expect(reclaimed).not.toBeNull()
    expect(renewTableWrite('chatG', token)).toBe(false) // the old owner lost the slot
    endTableWrite('chatG', reclaimed!)
  })
})
