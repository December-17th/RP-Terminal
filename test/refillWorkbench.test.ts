import { describe, it, expect } from 'vitest'
import {
  defaultRefillFrom,
  computeRange,
  widenRefillRange,
  countEditOpsInRange,
  idleRail,
  applyRailEvent,
  railFromSnapshot,
  segmentDisplay,
  okFraction,
  SEGMENT_DISPLAY_MAX,
  RailState,
  RailEvent
} from '../src/renderer/src/components/memory/refillModel'

// Pure derivations behind the Refill workbench (table-refill WS6 Phase A). The renderer twins of the
// engine's own helpers MUST mirror its semantics (defaultRefillFrom = tableRefillService's, the rail
// reducer = the engine's event grammar incl. the F1 stop-on-failure terminal).

const status = (m: Record<string, number | null>): Record<string, { lastFloor: number | null; unprocessed: number }> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { lastFloor: v, unprocessed: 0 }]))

describe('defaultRefillFrom', () => {
  it('is min(last+1) over selected, clamped to latest', () => {
    expect(defaultRefillFrom(status({ a: 3, b: 7 }), ['a', 'b'], 10)).toBe(4)
    expect(defaultRefillFrom(status({ a: 3, b: 7 }), ['b'], 10)).toBe(8)
  })
  it('never-processed contributes 0; current pointers clamp to latest', () => {
    expect(defaultRefillFrom(status({ a: null, b: 9 }), ['a', 'b'], 10)).toBe(0)
    expect(defaultRefillFrom(status({ a: 10 }), ['a'], 10)).toBe(10) // latest-clamp: run-now stays meaningful
  })
  it('empty chat yields 0', () => {
    expect(defaultRefillFrom(status({ a: 5 }), ['a'], -1)).toBe(0)
  })
})

describe('computeRange', () => {
  it('derives range + batch estimate from the default cutpoint', () => {
    const r = computeRange(status({ a: 3 }), ['a'], 10, { fullRefill: false, fromOverride: null, batchSize: 3 })
    expect(r).toEqual({ from: 4, to: 10, floors: 7, batches: 3, firstFill: false })
  })
  it('fullRefill forces 0; fromOverride clamps into [0, latest]', () => {
    expect(
      computeRange(status({ a: 8 }), ['a'], 10, { fullRefill: true, fromOverride: 5, batchSize: 5 })?.from
    ).toBe(0)
    expect(
      computeRange(status({ a: 8 }), ['a'], 10, { fullRefill: false, fromOverride: 99, batchSize: 5 })?.from
    ).toBe(10)
  })
  it('flags firstFill only when NO selected table was ever maintained', () => {
    expect(
      computeRange(status({ a: null, b: null }), ['a', 'b'], 4, { fullRefill: false, fromOverride: null, batchSize: 2 })
        ?.firstFill
    ).toBe(true)
    expect(
      computeRange(status({ a: null, b: 1 }), ['a', 'b'], 4, { fullRefill: false, fromOverride: null, batchSize: 2 })
        ?.firstFill
    ).toBe(false)
  })
  it('null when there is nothing to run', () => {
    expect(computeRange(status({}), [], 10, { fullRefill: false, fromOverride: null, batchSize: 3 })).toBeNull()
    expect(computeRange(status({ a: 1 }), ['a'], -1, { fullRefill: false, fromOverride: null, batchSize: 3 })).toBeNull()
  })
})

describe('widenRefillRange', () => {
  // The engine widens a requested cut DOWN onto a stored batch boundary; the confirm dialog recomputes
  // the range at that widened floor with the SAME batch math computeRange uses.
  const base = computeRange(status({ a: 3 }), ['a'], 10, {
    fullRefill: false,
    fromOverride: null,
    batchSize: 3
  })!
  it('recomputes floors + batches at the widened cutpoint, matching computeRange', () => {
    // base is from 4 (floors 4–10). Widen down to floor 2.
    const w = widenRefillRange(base, 2, 3)
    expect(w).toEqual({ from: 2, to: 10, floors: 9, batches: 3, firstFill: false })
    // Consistent with computing the range directly at that override floor.
    const direct = computeRange(status({ a: 3 }), ['a'], 10, {
      fullRefill: false,
      fromOverride: 2,
      batchSize: 3
    })
    expect(w).toEqual(direct)
  })
  it('preserves firstFill and clamps the widened floor into [0, to]', () => {
    const first = computeRange(status({ a: null }), ['a'], 4, {
      fullRefill: false,
      fromOverride: 3,
      batchSize: 2
    })!
    const w = widenRefillRange(first, -5, 2)
    expect(w.from).toBe(0)
    expect(w.firstFill).toBe(true)
    expect(w.floors).toBe(5)
    expect(w.batches).toBe(3)
  })
})

describe('countEditOpsInRange', () => {
  const ops = [
    { floor: 2, table: 'a', source: 'edit' },
    { floor: 5, table: 'a', source: 'edit' },
    { floor: 5, table: 'b', source: 'edit' },
    { floor: 6, table: 'a', source: 'maintain' },
    { floor: 7, table: null, source: 'edit' }
  ]
  it('counts only selected-table hand edits at/after the cut', () => {
    expect(countEditOpsInRange(ops, new Set(['a']), 3)).toBe(1)
    expect(countEditOpsInRange(ops, new Set(['a', 'b']), 0)).toBe(3)
    expect(countEditOpsInRange(ops, new Set(['b']), 6)).toBe(0)
  })
})

describe('rail reducer (the engine event grammar)', () => {
  const ev = (partial: Partial<RailEvent>): RailEvent => ({
    batchIndex: -1,
    batchCount: 3,
    span: null,
    status: 'running',
    ...partial
  })
  const run = (events: RailEvent[]): RailState => events.reduce(applyRailEvent, idleRail())

  it('a clean run: running → ok per batch → done', () => {
    const r = run([
      ev({ status: 'running' }),
      ev({ status: 'batch-ok', batchIndex: 0, completedUntil: 2 }),
      ev({ status: 'batch-ok', batchIndex: 1, completedUntil: 5 }),
      ev({ status: 'batch-ok', batchIndex: 2, completedUntil: 8 }),
      ev({ status: 'done', batchIndex: 2, completedUntil: 8 })
    ])
    expect(r.phase).toBe('done')
    expect(r.segs).toEqual(['ok', 'ok', 'ok'])
    expect(r.completedUntil).toBe(8)
  })
  it('advances the running marker to the next pending segment', () => {
    const r = run([ev({ status: 'running' }), ev({ status: 'batch-ok', batchIndex: 0, completedUntil: 2 })])
    expect(r.segs).toEqual(['ok', 'running', 'pending'])
  })
  it('stop-on-failure (F1): failed batch stays failed, terminal error demotes running→pending', () => {
    const r = run([
      ev({ status: 'running' }),
      ev({ status: 'batch-ok', batchIndex: 0, completedUntil: 2 }),
      ev({ status: 'batch-failed', batchIndex: 1, span: { from: 3, to: 5 }, message: 'boom' }),
      ev({ status: 'error', batchIndex: 1, message: 'boom', completedUntil: 2 })
    ])
    expect(r.phase).toBe('error')
    expect(r.segs).toEqual(['ok', 'failed', 'pending'])
    expect(r.failures).toEqual([{ from: 3, to: 5, reason: 'boom' }])
    expect(r.message).toBe('boom')
    expect(r.completedUntil).toBe(2) // resume retries exactly the failed span
  })
  it('cancel demotes the in-flight segment (it never committed)', () => {
    const r = run([
      ev({ status: 'running' }),
      ev({ status: 'batch-ok', batchIndex: 0, completedUntil: 2 }),
      ev({ status: 'cancelled', batchIndex: 1, completedUntil: 2 })
    ])
    expect(r.phase).toBe('cancelled')
    expect(r.segs).toEqual(['ok', 'pending', 'pending'])
  })
})

describe('railFromSnapshot (mid-run re-mount)', () => {
  it('pre-index batches are ok (the engine stops on failure), current is running', () => {
    const r = railFromSnapshot({
      running: true,
      batchIndex: 2,
      batchCount: 4,
      completedUntil: 5,
      failures: []
    })
    expect(r.segs).toEqual(['ok', 'ok', 'running', 'pending'])
    expect(r.phase).toBe('running')
    expect(r.completedUntil).toBe(5)
  })
})

describe('segment density fallback', () => {
  it('degrades to one continuous bar past the display max', () => {
    expect(segmentDisplay(SEGMENT_DISPLAY_MAX)).toBe('segments')
    expect(segmentDisplay(SEGMENT_DISPLAY_MAX + 1)).toBe('bar')
  })
  it('okFraction is committed/total', () => {
    expect(okFraction(['ok', 'ok', 'pending', 'failed'])).toBe(0.5)
    expect(okFraction([])).toBe(0)
  })
})
