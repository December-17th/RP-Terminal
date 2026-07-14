// Pure derivations for the Refill workbench (table-refill WS6 Phase A) — the renderer-side twins of
// the engine's own pure helpers (`tableRefillService.defaultRefillFrom` etc.), kept here so the
// workbench can show an HONEST consequence line ("将重新生成第 X–Y 层…") that always matches what the
// engine will actually do, and so the run rail's segment state machine is unit-testable without the
// React tree (the memoryPaneModel convention; tests in test/refillWorkbench.test.ts).

/** The slice of a table's maintenance status the workbench consumes (tableGridModel's shape). */
export interface RefillTableStatus {
  lastFloor: number | null
  unprocessed: number
}

/**
 * The default refill cutpoint — MUST mirror the engine's `defaultRefillFrom` (tableRefillService):
 * `min(lastFloor + 1)` over the selected tables (never-processed contributes 0), clamped to
 * `[0, latest]`. The latest-clamp keeps "run now" meaningful when every pointer is current.
 */
export const defaultRefillFrom = (
  status: Record<string, RefillTableStatus | undefined>,
  selected: string[],
  latest: number
): number => {
  if (latest < 0) return 0
  let min = latest
  for (const t of selected) {
    const cand = (status[t]?.lastFloor ?? -1) + 1
    if (cand < min) min = cand
  }
  return Math.max(0, Math.min(min, latest))
}

/** What the consequence line states: the pinned range, its size, and the batch estimate. */
export interface RefillRange {
  from: number
  to: number
  floors: number
  batches: number
  /** True when NO selected table has ever been maintained — the "first fill" teaching variant. */
  firstFill: boolean
}

/**
 * Derive the range the engine would regenerate for the current picker state, or null when there is
 * nothing to run (no floors / no selection). `fromOverride` is the stepper's pinned value (clamped);
 * `fullRefill` forces 0 (the baseline-gate escape hatch).
 */
export const computeRange = (
  status: Record<string, RefillTableStatus | undefined>,
  selected: string[],
  latest: number,
  opts: { fullRefill: boolean; fromOverride: number | null; batchSize: number }
): RefillRange | null => {
  if (latest < 0 || selected.length === 0) return null
  const from = opts.fullRefill
    ? 0
    : opts.fromOverride != null
      ? Math.max(0, Math.min(opts.fromOverride, latest))
      : defaultRefillFrom(status, selected, latest)
  const floors = latest - from + 1
  const batchSize = Math.max(1, Math.floor(opts.batchSize) || 1)
  return {
    from,
    to: latest,
    floors,
    batches: Math.ceil(floors / batchSize),
    firstFill: selected.every((t) => status[t]?.lastFloor == null)
  }
}

/** One op row as `listChatTableOps` projects it (only the fields the edit-warning check reads). */
export interface OpLike {
  floor: number
  table: string | null
  source: string | null
}

/** How many HAND-EDIT ops the refill cut would delete: `source='edit'`, floor ≥ from, table selected.
 *  Drives the destructive-confirm's edit-loss warning (skipped when 0 — no scare copy for nothing). */
export const countEditOpsInRange = (ops: OpLike[], selected: Set<string>, from: number): number =>
  ops.filter((o) => o.source === 'edit' && o.floor >= from && o.table != null && selected.has(o.table))
    .length

// ---- run-rail state machine ------------------------------------------------------------------

export type SegState = 'pending' | 'running' | 'ok' | 'failed'

export interface RailState {
  phase: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
  segs: SegState[]
  /** Floor index the last committed chunk reached (-1 = none yet). */
  completedUntil: number
  /** The failure reason on phase 'error' (the engine stops on the first failed batch — F1). */
  message?: string
  /** Failed spans for the failures list (floor spans, not indices). */
  failures: Array<{ from: number; to: number; reason: string }>
}

export const idleRail = (): RailState => ({
  phase: 'idle',
  segs: [],
  completedUntil: -1,
  failures: []
})

/** The progress event payload the rail consumes (`table-backfill-progress`, kind:'refill'). */
export interface RailEvent {
  batchIndex: number
  batchCount: number
  span: { from: number; to: number } | null
  status: 'running' | 'batch-ok' | 'batch-failed' | 'done' | 'cancelled' | 'error'
  message?: string
  completedUntil?: number
}

const sized = (segs: SegState[], count: number): SegState[] => {
  if (segs.length === count) return segs.slice()
  const out: SegState[] = new Array(count).fill('pending')
  for (let i = 0; i < Math.min(segs.length, count); i++) out[i] = segs[i]
  return out
}

/** Advance the 'running' marker to the first pending segment (the engine runs strictly in order). */
const markRunning = (segs: SegState[]): SegState[] => {
  const i = segs.findIndex((s) => s === 'pending')
  if (i >= 0) segs[i] = 'running'
  return segs
}

/**
 * PURE reducer: fold one progress event into the rail. Encodes the engine's actual event grammar:
 * one 'running' at start (batchIndex -1), then per-batch 'batch-ok' | 'batch-failed' (the engine
 * STOPS after a failed batch — stop-and-resume), then exactly one terminal 'done' | 'cancelled' |
 * 'error'. A terminal event demotes any still-'running' segment back to 'pending' (it never ran to
 * commit), so the bar honestly shows what was PAID and KEPT.
 */
export const applyRailEvent = (rail: RailState, ev: RailEvent): RailState => {
  const next: RailState = {
    ...rail,
    segs: sized(rail.segs, Math.max(0, ev.batchCount)),
    completedUntil: ev.completedUntil ?? rail.completedUntil,
    failures: rail.failures.slice()
  }
  switch (ev.status) {
    case 'running':
      next.phase = 'running'
      markRunning(next.segs)
      return next
    case 'batch-ok':
      next.phase = 'running'
      if (ev.batchIndex >= 0 && ev.batchIndex < next.segs.length) next.segs[ev.batchIndex] = 'ok'
      markRunning(next.segs)
      return next
    case 'batch-failed':
      next.phase = 'running'
      if (ev.batchIndex >= 0 && ev.batchIndex < next.segs.length) next.segs[ev.batchIndex] = 'failed'
      if (ev.span) next.failures.push({ from: ev.span.from, to: ev.span.to, reason: ev.message ?? '' })
      return next
    case 'done':
    case 'cancelled':
    case 'error':
      next.phase = ev.status
      next.segs = next.segs.map((s) => (s === 'running' ? 'pending' : s))
      if (ev.status === 'error') next.message = ev.message
      return next
  }
}

/**
 * Reconstruct the rail from a `getTableRefillState().run` snapshot (a view re-mount mid-run): every
 * batch below `batchIndex` committed (the engine stops on failure, so pre-index batches are 'ok'),
 * the current one is 'running'.
 */
export const railFromSnapshot = (run: {
  running: boolean
  batchIndex: number
  batchCount: number
  completedUntil: number
  failures: Array<{ span: { from: number; to: number }; reason: string }>
}): RailState => {
  const segs: SegState[] = new Array(Math.max(0, run.batchCount)).fill('pending')
  for (let i = 0; i < Math.min(run.batchIndex, segs.length); i++) segs[i] = 'ok'
  if (run.running && run.batchIndex >= 0 && run.batchIndex < segs.length) {
    segs[run.batchIndex] = 'running'
  }
  return {
    phase: run.running ? 'running' : 'idle',
    segs,
    completedUntil: run.completedUntil,
    failures: run.failures.map((f) => ({ from: f.span.from, to: f.span.to, reason: f.reason })),
    message: undefined
  }
}

/** Above this many batches, individual segments are sub-3px noise in the ~640px workbench column —
 *  render one continuous fill bar (ok-fraction) instead. */
export const SEGMENT_DISPLAY_MAX = 60

export const segmentDisplay = (batchCount: number): 'segments' | 'bar' =>
  batchCount > SEGMENT_DISPLAY_MAX ? 'bar' : 'segments'

/** The continuous-bar fallback's fill fraction: committed batches over total. */
export const okFraction = (segs: SegState[]): number => {
  if (!segs.length) return 0
  return segs.filter((s) => s === 'ok').length / segs.length
}
