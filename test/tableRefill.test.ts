import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// table-refill WS2 — the refill engine's DECISIONS are pure exported helpers (the house testing stance:
// the SQLite/fs shadow-build / publish / commit I/O is alias-mock-untestable, so every decision — what to
// replay, what to cut, what to commit, whether to abort, where to resume — lives in a pure function that
// is unit-tested here). Plus the token-owned write guard (pure Map logic in tableOpsService). electron +
// better-sqlite3 are globally aliased to stubs (vitest.config), so both real modules import cleanly.

// `effectiveRefillFrom` is impure (reads floors + op-log), so its ONE non-pure decision — iterating the
// widen step to a fixed point across CHAINED spans — is exercised by partial-mocking the two seams it
// reads (`getAllFloors`, `earliestSpanStart`) while keeping the real guard/pure exports intact.
vi.mock('../src/main/services/floorService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/floorService')>()
  const getAllFloors = vi.fn()
  return {
    ...actual,
    getAllFloors,
    // Count-only reads go through getFloorCount now — keep it slaved to the same fixture.
    getFloorCount: vi.fn(() => (getAllFloors() as unknown[] | undefined)?.length ?? 0)
  }
})
vi.mock('../src/main/services/tableOpsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/tableOpsService')>()
  return { ...actual, earliestSpanStart: vi.fn() }
})

import {
  shouldReplayIntoShadow,
  partitionBySelected,
  defaultRefillFrom,
  refillBaselineBlocked,
  watermarkMoved,
  resumeRefillFrom,
  widenedRefillFrom,
  planChunkCommit,
  refillRunOutcome,
  refillProgressAfterCut,
  refillProgressAfterEdit,
  effectiveRefillFrom,
  startGuardHeartbeat,
  REFILL_HEARTBEAT_MS
} from '../src/main/services/tableRefillService'
import {
  beginTableWrite,
  renewTableWrite,
  endTableWrite,
  tryBeginTableWrite,
  earliestSpanStart,
  WRITE_GUARD_MS
} from '../src/main/services/tableOpsService'
import { getAllFloors } from '../src/main/services/floorService'

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
  it('the first COMMITTED chunk carries the tail cut; ops carry the batch span (from..to)', () => {
    // First batch of a refill from 3: span [3,6] → ops keyed to span.to (6) carrying span.from (3).
    const plan = planChunkCommit(false, ['characters', 'world'], 3, ['INS1', 'INS2'], 6, 3)
    expect(plan.cut).toEqual({ tables: ['characters', 'world'], fromFloor: 3 })
    expect(plan.floorOps).toEqual([
      { floor: 6, fromFloor: 3, sql: 'INS1' },
      { floor: 6, fromFloor: 3, sql: 'INS2' }
    ])
  })
  it('later chunks carry NO cut; ops carry their own batch span start', () => {
    // A later batch [7,8]: no cut, ops keyed to span.to (8) carrying span.from (7).
    const plan = planChunkCommit(true, ['characters'], 3, ['INS3'], 8, 7)
    expect(plan.cut).toBeNull()
    expect(plan.floorOps).toEqual([{ floor: 8, fromFloor: 7, sql: 'INS3' }])
  })
  it('an empty batch still carries the cut on the first chunk (drops the stale tail)', () => {
    const plan = planChunkCommit(false, ['characters'], 0, [], 2, 0)
    expect(plan.cut).toEqual({ tables: ['characters'], fromFloor: 0 })
    expect(plan.floorOps).toEqual([])
  })
})

describe('widenedRefillFrom — a cutpoint can never bisect a stored span', () => {
  it('no overlapping span (null earliest) ⇒ the cutpoint is unchanged', () => {
    expect(widenedRefillFrom(5, null)).toBe(5)
  })
  it('a span starting BELOW the cut widens the cutpoint down to that span start', () => {
    // A maintainer batch summarized floors [2,6]; a refill requested at 5 would bisect it → widen to 2.
    expect(widenedRefillFrom(5, 2)).toBe(2)
  })
  it('a legacy NULL-from_floor row (earliest COALESCEs to its own floor ≥ cut) never widens below', () => {
    expect(widenedRefillFrom(5, 7)).toBe(5)
    expect(widenedRefillFrom(5, 5)).toBe(5)
  })
  it('resume-aligned: committed ops all sit below resume-from, so earliest is null ⇒ unchanged', () => {
    // A resume restarts at completedUntil+1; every committed refill op is keyed to a floor ≤ completedUntil
    // < resume-from, so earliestSpanStart finds none (null) and the resume cutpoint stays batch-aligned.
    expect(widenedRefillFrom(7, null)).toBe(7)
  })
})

describe('effectiveRefillFrom — widening iterates to a fixed point across CHAINED spans', () => {
  beforeEach(() => {
    vi.mocked(getAllFloors).mockReset()
    vi.mocked(earliestSpanStart).mockReset()
    // 6 floors ⇒ latest 5, so a request of 3 is in-range and never clamped.
    vi.mocked(getAllFloors).mockReturnValue(new Array(6).fill({}) as never)
  })

  it('chains the widen step 3 → 2 → 0 to the transitively-closed cutpoint', () => {
    // op A spans [0,2] (start 0, keyed at floor 2), op B spans [2,4] (start 2, keyed at floor 4).
    // Request 3 overlaps B ⇒ widen to 2; the cut at 2 still straddles A ⇒ widen again to 0; 0 is stable.
    const spanByFrom: Record<number, number | null> = { 3: 2, 2: 0, 0: 0 }
    vi.mocked(earliestSpanStart).mockImplementation((_c, _t, from) => spanByFrom[from] ?? null)
    expect(effectiveRefillFrom('p', 'c', ['characters', 'world'], 3)).toBe(0)
    expect(vi.mocked(earliestSpanStart)).toHaveBeenCalledTimes(3)
  })

  it('no overlapping span ⇒ one query settles it (the common case stays a single probe)', () => {
    vi.mocked(earliestSpanStart).mockReturnValue(null)
    expect(effectiveRefillFrom('p', 'c', ['characters'], 3)).toBe(3)
    expect(vi.mocked(earliestSpanStart)).toHaveBeenCalledTimes(1)
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

describe('refillProgressAfterCut — the resume row after a transcript cut (the refill race)', () => {
  const row = { fromFloor: 3, completedUntil: 8 }
  it('cut at/below the cutpoint ⇒ delete (nothing committed survives — all refill ops were ≥ fromFloor)', () => {
    expect(refillProgressAfterCut(row, 3)).toBe('delete')
    expect(refillProgressAfterCut(row, 0)).toBe('delete')
  })
  it('cut inside the committed range ⇒ clamp completedUntil to cutFloor - 1 (the surviving part)', () => {
    expect(refillProgressAfterCut(row, 6)).toEqual({ completedUntil: 5 })
    // Cut right after the cutpoint: committed part shrinks to nothing usable beyond fromFloor..3.
    expect(refillProgressAfterCut(row, 4)).toEqual({ completedUntil: 3 })
  })
  it('cut above the committed range ⇒ keep (the committed part is untouched)', () => {
    expect(refillProgressAfterCut(row, 9)).toBe('keep')
    expect(refillProgressAfterCut({ fromFloor: 3, completedUntil: -1 }, 5)).toBe('keep')
  })
})

describe('refillProgressAfterEdit — the resume row after an in-place floor edit / swipe (the refill race)', () => {
  const row = { fromFloor: 3, completedUntil: 8 }
  it('edit inside the committed range ⇒ clamp completedUntil to editFloor - 1 (the edited floor regenerates on resume)', () => {
    expect(refillProgressAfterEdit(row, 6)).toEqual({ completedUntil: 5 })
  })
  it('edit at completedUntil (upper boundary) ⇒ clamp to editFloor - 1', () => {
    expect(refillProgressAfterEdit(row, 8)).toEqual({ completedUntil: 7 })
  })
  it('edit at fromFloor (lower boundary) ⇒ clamp to fromFloor - 1 (resume re-runs the full range)', () => {
    expect(refillProgressAfterEdit(row, 3)).toEqual({ completedUntil: 2 })
  })
  it('edit below fromFloor ⇒ keep (frozen base state — maintain\'s domain, and the floor still exists)', () => {
    expect(refillProgressAfterEdit(row, 2)).toBe('keep')
  })
  it('edit above completedUntil ⇒ keep (nothing committed there; the epoch fence covers a live chunk)', () => {
    expect(refillProgressAfterEdit(row, 9)).toBe('keep')
    // Nothing committed yet (completedUntil = -1): any edit is above the committed range ⇒ keep.
    expect(refillProgressAfterEdit({ fromFloor: 3, completedUntil: -1 }, 4)).toBe('keep')
  })
})

describe('startGuardHeartbeat — the guard-lease heartbeat (the >120s-batch hole)', () => {
  afterEach(() => vi.useRealTimers())

  it('renews on an interval while alive so the lease never lapses across a >120s await', () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockReturnValue(true)
    const hb = startGuardHeartbeat(renew)
    expect(hb.lost()).toBe(false)
    // A single batch await spanning ~150s (past WRITE_GUARD_MS 120s): the interval fires meanwhile.
    vi.advanceTimersByTime(150_000)
    // At least two beats inside a 120s window (REFILL_HEARTBEAT_MS < 60s) → lease stayed owned.
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(hb.lost()).toBe(false)
    hb.stop()
  })

  it('latches lost() true when a renew reports the slot was reclaimed, and stays lost', () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const hb = startGuardHeartbeat(renew)
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS) // beat 1 — still owned
    expect(hb.lost()).toBe(false)
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS) // beat 2 — reclaimed → latch
    expect(hb.lost()).toBe(true)
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS * 3) // stays lost regardless of later beats
    expect(hb.lost()).toBe(true)
    hb.stop()
  })

  it('stop() clears the interval — no further renews fire', () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockReturnValue(true)
    const hb = startGuardHeartbeat(renew)
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS)
    const after = renew.mock.calls.length
    hb.stop()
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS * 5)
    expect(renew.mock.calls.length).toBe(after)
  })

  it('latches lost on a renewal GAP ≥ guard window even when renew still succeeds, and stays lost', () => {
    vi.useFakeTimers()
    // Event-loop starvation: renew() never fails (token identity intact), but a wall-clock gap past the
    // guard window opens between beats — a probe could have seen the slot free, so the run must stop.
    const renew = vi.fn().mockReturnValue(true)
    const hb = startGuardHeartbeat(renew)
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS) // one normal beat — lease still owned
    expect(hb.lost()).toBe(false)
    // Timers starve: the wall clock jumps past WRITE_GUARD_MS with no beat firing, then the next tick runs.
    vi.setSystemTime(Date.now() + WRITE_GUARD_MS + 10_000)
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS) // overdue beat observes the gap → latch, despite renew=true
    expect(hb.lost()).toBe(true)
    // Latched: further SUCCESSFUL renews at normal cadence must NOT launder the proven lapse.
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS * 3)
    expect(hb.lost()).toBe(true)
    hb.stop()
  })

  it('lost() recomputes fresh — a ≥ guard-window stall since the last beat trips it before any timer fires', () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockReturnValue(true)
    const hb = startGuardHeartbeat(renew)
    expect(hb.lost()).toBe(false)
    // Stall between the last tick and the pre-commit check: no interval has fired yet.
    vi.setSystemTime(Date.now() + WRITE_GUARD_MS) // exactly the window — `>=` trips (probe already reads free)
    expect(hb.lost()).toBe(true)
    expect(renew).not.toHaveBeenCalled() // caught purely by the fresh recompute, no beat needed
    hb.stop()
  })

  it('stays not-lost across many beats at normal cadence with successful renews', () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockReturnValue(true)
    const hb = startGuardHeartbeat(renew)
    // ~10 beats (450s) at the 45s cadence: each gap (45s) stays well under the 120s window.
    vi.advanceTimersByTime(REFILL_HEARTBEAT_MS * 10)
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(hb.lost()).toBe(false)
    hb.stop()
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
