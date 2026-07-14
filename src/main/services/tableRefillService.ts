import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { getAllFloors, transcriptEpoch, onTranscriptCut, onTranscriptEdited } from './floorService'
import {
  refillShadowPath,
  instantiateAt,
  readAllTablesAt,
  publishShadow,
  removeShadow,
  templateSqlNames
} from './tableDbService'
import {
  beginTableWrite,
  renewTableWrite,
  endTableWrite,
  WRITE_GUARD_MS,
  listOpsForReplay,
  opsWatermark,
  appendOpsAt,
  deleteOpsFor,
  earliestSpanStart,
  hasBaselineOps,
  replayOpsInto,
  rebuildSandboxUnguarded,
  FloorOp,
  TableOpWithTarget
} from './tableOpsService'
import { validateBatch, applySqlBatchAt, partitionBySelected } from './tableSql'
import { getProgress, advanceProgress } from './tableProgressService'
import { composeTablesBlock, refillMaintainerPrompt } from './tableMaintenance'
import { planBatches, buildBatchTranscript, BatchSpan } from './tableBackfillService'
import { runMaintainerBatch } from './tableMaintainerLoop'
import { getSettings } from './settingsService'
import { buildGenContext } from './generation/genContext'
import { withPreset } from './generation/resilientCall'
import { notifyBackfillProgress } from './tableBackfillEvents'
import { getDb, transact } from './db'
import { log } from './logService'
import { ChatMessage } from './promptBuilder'
import { TableTemplate } from '../types/tableTemplate'
import { FloorFile } from '../types/chat'
import { GenContext } from './generation/types'

/**
 * Chunk-committed, resumable REFILL engine for SQL-table memory (table-refill WS2 — the fix for the
 * duplicate-rows bug). Where the manual backfill APPENDS onto the current tables (double-counting
 * overlapping floors), a refill ROLLS the selected tables back to a cutpoint and REGENERATES the rest
 * from the transcript, in ascending batches, committing per chunk so a late failure never throws away
 * the paid LLM work and an interrupted run RESUMES from where it stopped.
 *
 * FAILURE SEMANTICS = STOP-AND-RESUME, not backfill's continue-on-failure: a batch that exhausts its
 * retries TERMINATES the run (`refillRunOutcome`). Backfill could skip a failed span (append-world:
 * "nothing added"); refill has already CUT the tail, so skipping would let later chunks advance
 * `completedUntil` past the failed span and finalize would advance the pointers over a permanent,
 * non-resumable hole. Instead: committed chunks + the `in_progress` progress row stay (completedUntil =
 * the last GOOD chunk), pointers are NOT advanced, and Resume retries exactly the failed span.
 *
 * The design is "generalized backfill" (per-floor attribution via `appendOpsAt` at each batch's `span.to`)
 * built on a temp SHADOW sandbox so the live sandbox is never mutated in place mid-run: the shadow is
 * "state as of fromFloor-1 for selected tables, latest for the rest", regenerated forward, and PUBLISHED
 * over the live file per committed chunk. Three correctness traps this encodes (see the plan §0b):
 *  1. never `rebuildSandbox` under the held guard (it self-claims + silently skips) — publish by file copy,
 *  2. a token-owned write guard renewed per batch AND on a heartbeat interval (the 120s stale-expiry
 *     would otherwise silently drop the lock across a single >120s batch model call),
 *  3. a partial refill of a structurally re-baselined table is BLOCKED (would re-duplicate) → full refill.
 *
 * Per the house testing stance, every DECISION is a PURE exported helper (unit-tested); the SQLite/fs
 * I/O wrappers are alias-mock-untestable and kept dumb. See docs/sdk/table-templates.md.
 */

// ---- pure decision helpers (unit-tested) -----------------------------------------------------

/**
 * Whether an op should be REPLAYED into the shadow when rolling selected tables back to `fromFloor`.
 * Replay everything EXCEPT a selected table's op at/after the cut (that is the tail being regenerated).
 * `'*'` / NULL target_table ops are never in `selected`, so they always replay (the always-replay tail);
 * an unselected table's ops always replay (its latest state is kept); a selected table's ops BELOW the
 * cut replay (they are the base state as of fromFloor-1).
 */
export const shouldReplayIntoShadow = (
  op: { targetTable: string | null; floor: number },
  selected: Set<string>,
  fromFloor: number
): boolean => !(op.targetTable != null && selected.has(op.targetTable) && op.floor >= fromFloor)

/**
 * The write-scope filter (kept/dropped by selected table) now lives in `tableSql` next to the
 * `ValidatedStatement` it consumes, so the AUTO due-set gate (`memory.maintain`) and this manual REFILL
 * engine share ONE filter without importing each other (table-refill WS3). Re-exported here so the
 * engine's public surface is unchanged.
 */
export { partitionBySelected } from './tableSql'

/**
 * The default refill cutpoint when the caller doesn't pin one: the earliest un-maintained floor across
 * the selected tables — `min(last_floor + 1)` over `selected` — clamped to `latest`. The latest-clamp
 * keeps "run refill now" meaningful when every selected pointer is already current (otherwise the range
 * would be empty and the run a silent no-op): it regenerates at least the last floor. A never-processed
 * table (`last = -1`) contributes 0. `latest = getAllFloors().length - 1`; an empty chat (`latest < 0`)
 * yields 0.
 */
export const defaultRefillFrom = (
  progress: Record<string, number>,
  selected: string[],
  latest: number
): number => {
  if (latest < 0) return 0
  let min = latest
  for (const t of selected) {
    const cand = (progress[t] ?? -1) + 1
    if (cand < min) min = cand
  }
  return Math.max(0, Math.min(min, latest))
}

/** A partial refill (`from > 0`) of a table carrying a structural re-baseline (`source='baseline'`) would
 *  re-duplicate content, so it is BLOCKED → the user is steered to a full (from 0) refill, which is clean.
 *  A from-0 refill is always allowed (its cut deletes the baseline rows and regenerates). */
export const refillBaselineBlocked = (fromFloor: number, hasBaseline: boolean): boolean =>
  fromFloor > 0 && hasBaseline

/**
 * The per-chunk interleave check: a foreign INSERT for this chat (a concurrent auto-maintain that slipped
 * past the guard's 120s expiry) pushes `MAX(rowid)` ABOVE the refill's own last-observed value. Only an
 * INCREASE is foreign — the refill's own tail DELETEs lower the mark. A moved watermark ABORTS the commit
 * rather than silently merge the interleave.
 */
export const watermarkMoved = (observed: number, expected: number): boolean => observed > expected

/**
 * Where a resumed refill restarts: `max(fromFloor, completedUntil + 1)`. If chunks committed (up to
 * `completedUntil`), resume just after them; if nothing committed (`completedUntil = -1`), resume at the
 * original cutpoint. The op-log composes exactly — the committed tail (floors < resume-from) is replayed
 * into the resume's shadow, and the resume's own cut only drops floors ≥ resume-from.
 */
export const resumeRefillFrom = (fromFloor: number, completedUntil: number): number =>
  Math.max(fromFloor, completedUntil + 1)

/**
 * Widen a requested refill cutpoint DOWN onto a stored span boundary (PURE). `earliest` is the earliest
 * span start among the selected tables' ops that end at/after the request (`earliestSpanStart`, or null
 * when none). A multi-floor maintainer batch summarizes floors [span.from, span.to]; if the request
 * lands INSIDE that span, cutting there would delete the op but only regenerate from the request, losing
 * the span's earlier floors — so pull the cut down to the span start. `null` (no overlapping span) ⇒
 * unchanged; otherwise `min(requested, earliest)` (already ≤ requested, but min guards a legacy row whose
 * COALESCEd floor could sit above the request). Widening to 0 turns a baseline-blocked partial into an
 * allowed full refill — which is why the caller widens BEFORE the baseline gate.
 */
export const widenedRefillFrom = (requested: number, earliest: number | null): number =>
  earliest == null ? requested : Math.min(requested, earliest)
// ↑ SINGLE step: widens onto the ONE span overlapping `requested`. Spans can CHAIN (a batch at [2,4]
// whose start floor 2 is the end of a batch at [0,2]), so one step is NOT transitively closed — the
// caller (`effectiveRefillFrom`) iterates this step to a fixed point.

/**
 * Assemble a chunk's commit plan (PURE): the recorded statements attributed to the batch (keyed to its
 * LAST floor `toFloor` = `span.to`, and carrying the batch's SPAN START `batchFrom` = `span.from` as
 * `from_floor` provenance so a later refill can widen its cut onto the span boundary instead of bisecting
 * it), plus the tail cut — present ONLY on the first COMMITTED chunk (`cutDone` false), which deletes the
 * selected tables' ops at/after the run cutpoint `fromFloor` so the mid-refill state is base +
 * regenerated-so-far (never a stale/new mix). Later chunks carry no cut.
 */
export const planChunkCommit = (
  cutDone: boolean,
  selected: string[],
  fromFloor: number,
  recorded: string[],
  toFloor: number,
  batchFrom: number
): { cut: { tables: string[]; fromFloor: number } | null; floorOps: FloorOp[] } => ({
  cut: cutDone ? null : { tables: selected, fromFloor },
  floorOps: recorded.map((sql) => ({ floor: toFloor, fromFloor: batchFrom, sql }))
})

/** How a refill run ends, decided from what happened during the batch loop. */
export interface RefillRunOutcome {
  /** The terminal event status the UI listens for. */
  status: 'done' | 'cancelled' | 'error'
  /** True ONLY for a clean full run: advance the pointers to latest + delete the progress row.
   *  False keeps the `in_progress` row (completedUntil = the last GOOD chunk) so Resume retries
   *  exactly what didn't commit. */
  finalize: boolean
  /** The failed batch's reason (status 'error' only). */
  message?: string
}

/**
 * Decide the run's terminal branch (PURE): a FAILED batch ⇒ terminal `error`, NO finalize — unlike the
 * append backfill (where a failed span just meant "nothing added"), refill has already CUT the tail, so
 * skipping past a failed span and finalizing would advance the pointers over a permanent hole and delete
 * the resume record. Stop-and-resume instead: committed chunks + the progress row stay, Resume (from
 * `completedUntil + 1`) retries exactly the failed span. A failure outranks a concurrent cancel (it
 * carries the reason); a cancel without failure ⇒ `cancelled` (also resumable); otherwise `done`.
 */
export const refillRunOutcome = (aborted: boolean, failedReason: string | null): RefillRunOutcome =>
  failedReason != null
    ? { status: 'error', finalize: false, message: failedReason }
    : aborted
      ? { status: 'cancelled', finalize: false }
      : { status: 'done', finalize: true }

/**
 * What a transcript CUT at `cutFloor` (regenerate / floor delete) does to a persisted refill resume
 * row (PURE — the refill race, owner pass 2026-07-14). `truncateFloors` deletes ops at/after the cut,
 * so committed refill work at those floors is GONE from the log:
 *  - cut at/below the run's cutpoint → the whole plan is void ('delete' the row; nothing committed
 *    survives — every committed floor is ≥ fromFloor ≥ cut),
 *  - cut inside the committed range → clamp `completedUntil` to `cutFloor - 1` (the surviving part;
 *    Resume re-reads the floors fresh, so continuing against the NEW tail is sound),
 *  - cut above the committed range → 'keep' (the committed part is untouched; the un-run tail is
 *    recomposed from disk at resume time anyway).
 */
export const refillProgressAfterCut = (
  row: { fromFloor: number; completedUntil: number },
  cutFloor: number
): 'delete' | 'keep' | { completedUntil: number } =>
  cutFloor <= row.fromFloor
    ? 'delete'
    : row.completedUntil >= cutFloor
      ? { completedUntil: cutFloor - 1 }
      : 'keep'

/**
 * What an in-place transcript EDIT at `editFloor` (a floor's text changed, or a swipe switch/append) does
 * to a persisted refill resume row (PURE — the refill race, part 2, owner pass 2026-07-14). Unlike a CUT,
 * the floor still EXISTS — only its content is now stale — so this NEVER deletes the row (an edit
 * invalidates content, not floor indices). Three branches, keyed on where the edit lands:
 *  - edit INSIDE the committed range (`fromFloor <= editFloor <= completedUntil`) → clamp `completedUntil`
 *    to `editFloor - 1`. Resume then restarts at `editFloor` (via `resumeRefillFrom = max(fromFloor,
 *    completedUntil + 1)`, which yields `editFloor` here, or the full range when `editFloor == fromFloor`),
 *    and Resume's own cut deletes the now-stale committed ops at/after `editFloor` before regenerating —
 *    so the edited floor's memory is rebuilt from the new text.
 *  - edit BELOW `fromFloor` → 'keep'. Those floors are the refill's frozen BASE state (below the cut);
 *    their staleness is memory.maintain's domain, not this refill's — and unlike a cut, they still exist,
 *    so nothing here is invalidated by INDEX.
 *  - edit ABOVE `completedUntil` → 'keep'. Nothing is committed there yet; a still-live chunk that read
 *    the old text is caught by the epoch fence in `commitChunk`/finalize.
 * This composes with the cut-widening in `startRefill`: the clamped resume goes back through `startRefill`,
 * which widens the cutpoint further DOWN if `editFloor` bisects a committed batch's stored span.
 */
export const refillProgressAfterEdit = (
  row: { fromFloor: number; completedUntil: number },
  editFloor: number
): 'keep' | { completedUntil: number } =>
  editFloor >= row.fromFloor && editFloor <= row.completedUntil
    ? { completedUntil: editFloor - 1 }
    : 'keep'

// ---- guard-lease heartbeat (extracted so the interval logic is fake-timer testable) -----------

/**
 * How often the refill renews its write lease. < `WRITE_GUARD_MS`/2 (= 60s) so two beats always fall
 * inside one 120s window — the lease can never lapse across a single pending model call.
 */
export const REFILL_HEARTBEAT_MS = 45_000

/**
 * The guard-lease heartbeat wiring, extracted PURE over an injected `renew` fn so the interval logic is
 * unit-testable with fake timers (the async `runRefill` body it lives in is alias-mock-untestable). Renews
 * the token-owned write lease every `REFILL_HEARTBEAT_MS` while the run is alive so a single batch's model
 * call — up to `retries` API re-tries + SQL-corrective re-asks, routinely > `WRITE_GUARD_MS` — can't let
 * the lease expire mid-await (which would read `isTableWriteBusy` false and hand the slot to a probe, or
 * let the run's own now-expired-but-identity-owned token renew fine and publish stale schema).
 *
 * The latch guards lease CONTINUITY, not merely reclaim. Two ways the lease is lost:
 *   1. A `renew()` returns false — the 120s expiry lapsed and another writer reclaimed the token.
 *   2. A wall-clock GAP ≥ `guardMs` opened since the last SUCCESSFUL renew — even if `renew()` still
 *      succeeds. This is the event-loop-starvation hole: if timers starve past `WRITE_GUARD_MS`, a
 *      destructive PROBE (the structure migration's `isTableWriteBusy` pre-check) can observe the
 *      expired lease and proceed WITHOUT claiming; the heartbeat's next `renew()` then succeeds because
 *      `renewTableWrite` checks token IDENTITY, not expiry — which would LAUNDER the lapse and let the
 *      refill commit over the migration. So a proven gap latches lost regardless of renew success, and
 *      `last` only advances on a renew that did NOT already lapse.
 *
 * `lost()` recomputes freshly (`guardLost || gap ≥ guardMs`) so the pre-commit backstop also catches a
 * stall that lands BETWEEN the last tick and the commit, before any timer has fired. `stop()` clears the
 * interval. `guardMs` defaults to `WRITE_GUARD_MS` (the real expiry window); the param exists so the
 * fake-timer tests can drive the gap logic without depending on the imported constant. Crash-safety is
 * unaffected — the guard map is in-memory and dies with the process; a hung run stays visible +
 * cancellable in the rail (cancel's finally releases).
 */
export const startGuardHeartbeat = (
  renew: () => boolean,
  guardMs = WRITE_GUARD_MS
): { stop: () => void; lost: () => boolean } => {
  let guardLost = false
  let last = Date.now()
  const handle = setInterval(() => {
    // A gap ≥ guardMs means the lease provably lapsed at some point in this interval — a probe could
    // have seen the slot free — so a subsequent successful renew must NOT launder it.
    if (Date.now() - last >= guardMs) guardLost = true
    if (!renew()) guardLost = true
    else if (!guardLost) last = Date.now()
  }, REFILL_HEARTBEAT_MS)
  return {
    stop: () => clearInterval(handle),
    // Recompute so a stall between the last tick and this call (no timer fired yet) is still caught.
    lost: () => guardLost || Date.now() - last >= guardMs
  }
}

// ---- refill-progress store (app DB) — untestable stance (alias-mocked better-sqlite3) ---------

export interface RefillProgressRow {
  selected: string[]
  fromFloor: number
  completedUntil: number
  status: string
}

/** The persisted refill-progress row for a chat, or null when no refill is in flight/interrupted. */
export const getRefillProgress = (chatId: string): RefillProgressRow | null => {
  const row = getDb()
    .prepare(
      'SELECT selected_json, from_floor, completed_until, status FROM table_refill_progress WHERE chat_id = ?'
    )
    .get(chatId) as
    | { selected_json: string; from_floor: number; completed_until: number; status: string }
    | undefined
  if (!row) return null
  let selected: string[] = []
  try {
    const parsed = JSON.parse(row.selected_json)
    if (Array.isArray(parsed)) selected = parsed.filter((s): s is string => typeof s === 'string')
  } catch {
    selected = []
  }
  return {
    selected,
    fromFloor: row.from_floor,
    completedUntil: row.completed_until,
    status: row.status
  }
}

const upsertRefillProgress = (
  chatId: string,
  selected: string[],
  fromFloor: number,
  completedUntil: number,
  status: string
): void => {
  getDb()
    .prepare(
      `INSERT INTO table_refill_progress (chat_id, selected_json, from_floor, completed_until, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         selected_json = excluded.selected_json,
         from_floor = excluded.from_floor,
         completed_until = excluded.completed_until,
         status = excluded.status,
         updated_at = excluded.updated_at`
    )
    .run(chatId, JSON.stringify(selected), fromFloor, completedUntil, status, new Date().toISOString())
}

const deleteRefillProgress = (chatId: string): void => {
  getDb().prepare('DELETE FROM table_refill_progress WHERE chat_id = ?').run(chatId)
}

// ---- in-memory run state ---------------------------------------------------------------------

export interface RefillFailure {
  span: BatchSpan
  reason: string
}

/** In-memory run state, readable for view re-mounts (`getRefillState`). Not persisted — the DURABLE
 *  resume state is the `table_refill_progress` row; this is only the live progress a mounted view shows. */
export interface RefillRunState {
  running: boolean
  batchIndex: number
  batchCount: number
  span: BatchSpan | null
  completedUntil: number
  droppedOutOfScope: number
  failures: RefillFailure[]
}

const runs = new Map<string, { controller: AbortController; state: RefillRunState }>()

/** Snapshot the live run state (or null when no refill is mounted) + the persisted resume row. */
export const getRefillState = (
  chatId: string
): { run: RefillRunState | null; persisted: RefillProgressRow | null } => ({
  run: runs.get(chatId)?.state ?? null,
  persisted: getRefillProgress(chatId)
})

/** Cancel a running refill (between-batch effect; a batch in flight finishes/fails). Committed chunks
 *  stay; the progress row survives for a later Resume. */
export const cancelRefill = (chatId: string): void => {
  runs.get(chatId)?.controller.abort()
}

/** Discard an interrupted refill's resume record + shadow file (committed chunks are kept — valid
 *  regenerated history). Rejects while a refill is actively running for the chat. */
export const discardRefill = (profileId: string, chatId: string): void => {
  if (runs.get(chatId)?.state.running) throw new Error('tables.refillRunning')
  deleteRefillProgress(chatId)
  removeShadow(profileId, chatId)
}

// The refill race (owner pass 2026-07-14): floors truncated (regenerate / delete) while a refill is
// live or interrupted. Proactive layer — abort the live run NOW (its in-flight LLM call stops instead
// of paying for a batch the epoch fence would drop) and fix the persisted resume row per
// `refillProgressAfterCut` so a later Resume never claims floors beyond the cut. The epoch fence in
// `commitChunk`/finalize is the correctness backstop if this signal loses the race; the run's own
// unwind rebuilds the live sandbox (truncateFloors' guarded rebuild self-skips while we hold the
// guard) and removes the shadow. Registered via floorService's listener seam (no import cycle).
onTranscriptCut((profileId, chatId, cutFloor) => {
  const live = runs.get(chatId)
  if (live?.state.running) live.controller.abort()
  const row = getRefillProgress(chatId)
  if (!row || row.status !== 'in_progress') return
  const next = refillProgressAfterCut(row, cutFloor)
  if (next === 'delete') {
    deleteRefillProgress(chatId)
    // The live run still needs its shadow to unwind; with no run, the orphan file can go now.
    if (!live?.state.running) removeShadow(profileId, chatId)
  } else if (next !== 'keep') {
    upsertRefillProgress(chatId, row.selected, row.fromFloor, next.completedUntil, row.status)
  }
})

// The refill race, part 2 (owner pass 2026-07-14): an existing floor's TEXT edited / a swipe switched
// while a refill is live or interrupted. The floor indices survive (no delete), but the committed memory
// for the edited floor is now stale. Proactive layer — abort the live run NOW (stop paying for a batch the
// epoch fence would drop) and clamp the persisted resume row back to just before the edited floor per
// `refillProgressAfterEdit` so a later Resume regenerates it (its cut drops the stale committed ops, then
// startRefill's widener pulls the cut further down if the edit bisects a stored span). Never delete the row
// and never remove the shadow (an edit invalidates content, not indices; the live run still needs the
// shadow to unwind). The epoch fence in `commitChunk`/finalize is the correctness backstop if this signal
// loses the race. Registered via floorService's edit-listener seam (no import cycle).
onTranscriptEdited((_profileId, chatId, editFloor) => {
  const live = runs.get(chatId)
  if (live?.state.running) live.controller.abort()
  const row = getRefillProgress(chatId)
  if (!row || row.status !== 'in_progress') return
  const next = refillProgressAfterEdit(row, editFloor)
  if (next !== 'keep') {
    upsertRefillProgress(chatId, row.selected, row.fromFloor, next.completedUntil, row.status)
  }
})

// ---- options -------------------------------------------------------------------------------

export interface RefillOpts {
  /** The sqlNames to regenerate; empty/unset = ALL template tables. */
  tables?: string[]
  /** The 0-based start cutpoint; unset = the clamped earliest-un-maintained default (`defaultRefillFrom`). */
  fromFloor?: number
  /** An optional extra instruction folded into the maintainer prompt. */
  extraHint?: string
  /** A saved api_preset id to run the maintainer against; unset = the active connection. */
  apiPresetId?: string
  /** Auto-retry budget per batch (0–5): API errors AND SQL-error corrective re-calls. */
  retries?: number
  /** Floors per maintainer batch (each batch = one commit chunk). Default 3. */
  batchSize?: number
}

// ---- effective cutpoint (shared engine ↔ UI) ------------------------------------------------

/**
 * The cutpoint a refill would ACTUALLY use for `(selected, requestedFrom)`: the default fill →
 * clamp → widen-onto-a-stored-span-boundary pipeline, resolved from the live floors / progress /
 * op log. `requestedFrom` unset ⇒ the clamped `defaultRefillFrom`; a number ⇒ clamped to
 * `[0, latest]`; either way the result is WIDENED DOWN via `earliestSpanStart` so it never bisects a
 * multi-floor maintainer batch. Widening is ITERATED to a fixed point (spans can chain, e.g. [0,2]→[2,4],
 * and one widen step only clears the span overlapping its argument), so the result is transitively closed:
 * no stored span among `selected` straddles it. This is the ONE place the requested→effective mapping lives so the
 * engine (`startRefill`) and the confirm-dialog preview (`chat-tables-refill-effective-from` IPC)
 * can never drift. NOT pure (reads floors/progress/ops); the pure pieces it composes
 * (`defaultRefillFrom`, `widenedRefillFrom`) are unit-tested. An empty chat (`latest < 0`) ⇒ 0.
 * The baseline gate stays in `startRefill` — this computes only the cutpoint.
 */
export const effectiveRefillFrom = (
  profileId: string,
  chatId: string,
  selected: string[],
  requestedFrom: number | undefined
): number => {
  const latest = getAllFloors(profileId, chatId).length - 1
  if (latest < 0) return 0
  const requested =
    typeof requestedFrom === 'number'
      ? requestedFrom
      : defaultRefillFrom(getProgress(profileId, chatId), selected, latest)
  const clamped = Math.max(0, Math.min(requested, latest))
  // Iterate the pure widen step to a FIXED POINT. `widenedRefillFrom` only widens onto the span that
  // overlaps its argument, but spans CHAIN (op A [0,2] at floor 2, op B [2,4] at floor 4): a request of
  // 3 widens to 2, but the cut at 2 would delete op A while regeneration starts at 2, losing floors 0-1.
  // Re-widening from 2 pulls the cut to 0. Each iteration strictly decreases (widen only ever lowers) and
  // is bounded below by 0, so it terminates. Result is transitively closed: no stored span straddles it.
  let cur = clamped
  for (;;) {
    const next = widenedRefillFrom(cur, earliestSpanStart(chatId, selected, cur))
    if (next === cur) return cur
    cur = next
  }
}

// ---- orchestrator --------------------------------------------------------------------------

/**
 * Start a refill for a chat. Validates + builds synchronously (rejects if one is already running, no
 * template, an unknown preset, an empty chat, no valid tables, or the baseline gate trips), claims the
 * token-owned write guard, writes the `in_progress` progress row, then runs ASYNCHRONOUSLY — progress
 * streams via `notifyBackfillProgress` (`kind:'refill'`). Returns once the run has started.
 */
export const startRefill = async (
  profileId: string,
  chatId: string,
  opts: RefillOpts = {}
): Promise<void> => {
  if (runs.get(chatId)?.state.running) throw new Error('tables.refillAlreadyRunning')

  const templateId = getChatTableTemplateId(profileId, chatId)
  if (!templateId) throw new Error('tables.refillNoTemplate')
  const template = getTableTemplateById(profileId, templateId)
  if (!template) throw new Error('tables.refillNoTemplate')

  const allNames = template.tables.map((t) => t.sqlName)
  const requestedTables = opts.tables && opts.tables.length ? new Set(opts.tables) : null
  const selected = requestedTables ? allNames.filter((n) => requestedTables.has(n)) : allNames
  if (!selected.length) throw new Error('tables.refillNoTables')

  const floors = getAllFloors(profileId, chatId)
  const latest = floors.length - 1
  if (latest < 0) throw new Error('tables.refillNoFloors')
  // Staleness fence: the epoch of the floors snapshot the WHOLE run composes from (same sync block as
  // the read). Checked at every chunk commit + finalize — the awaits on the batch LLM calls are the
  // only points a truncate/edit/swipe can interleave.
  const epoch0 = transcriptEpoch(chatId)

  // The requested→effective cutpoint (default → clamp → widen onto a stored span boundary) is ONE
  // shared helper so the confirm-dialog preview (chat-tables-refill-effective-from) and this engine
  // never drift. Widening happens BEFORE the baseline gate + progress-row write: widening to 0 turns a
  // baseline-blocked partial into an allowed full refill.
  const from = effectiveRefillFrom(profileId, chatId, selected, opts.fromFloor)
  // Diagnostic: note when the cut widened DOWN off the naive requested floor onto a span boundary.
  const requestedFrom = Math.max(
    0,
    Math.min(
      typeof opts.fromFloor === 'number'
        ? opts.fromFloor
        : defaultRefillFrom(getProgress(profileId, chatId), selected, latest),
      latest
    )
  )
  if (from < requestedFrom) {
    log('info', `refill widened cutpoint ${requestedFrom} → ${from} (chat ${chatId}) — a stored span crossed the cut`)
  }

  if (refillBaselineBlocked(from, hasBaselineOps(profileId, chatId, selected))) {
    throw new Error('tables.refillNeedsFull')
  }

  const token = beginTableWrite(chatId)
  if (!token) throw new Error('tables.refillBusy')

  // Everything between the successful claim and the async kickoff is fenced (F2): a throw here (gen
  // build, a bad preset, an app-DB error in the progress upsert) must release the guard token AND
  // unregister the just-set `runs` entry — a leaked `running: true` entry would otherwise make every
  // future startRefill throw refillAlreadyRunning until app restart.
  const controller = new AbortController()
  const entry: { controller: AbortController; state: RefillRunState } = {
    controller,
    state: {
      running: true,
      batchIndex: -1,
      batchCount: 0,
      span: null,
      completedUntil: -1,
      droppedOutOfScope: 0,
      failures: []
    }
  }
  try {
    let gen: GenContext = buildGenContext(profileId, chatId, '')
    if (opts.apiPresetId) {
      const swapped = withPreset(gen, opts.apiPresetId)
      if (!swapped) throw new Error('tables.backfillBadPreset')
      gen = swapped
    }

    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 3))
    // Default retry budget = 5 (owner directive 2026-07-14) — refill batches are side calls where a
    // transient failure otherwise stops the whole run (stop-and-resume semantics).
    const retries = Math.max(0, Math.min(5, opts.retries ?? 5))
    const spans = planBatches(latest + 1, latest - from + 1, batchSize)
    entry.state.batchCount = spans.length

    runs.set(chatId, entry)
    upsertRefillProgress(chatId, selected, from, -1, 'in_progress')

    // Kick off the async run; do NOT await it (the IPC caller returns immediately). An async call
    // never throws synchronously, so nothing after this point needs the fence.
    void runRefill(
      profileId,
      chatId,
      gen,
      template,
      floors,
      selected,
      from,
      latest,
      spans,
      retries,
      opts.extraHint,
      token,
      entry.state,
      controller.signal,
      epoch0
    )
  } catch (error) {
    endTableWrite(chatId, token) // never leak the guard on a start-time failure
    if (runs.get(chatId) === entry) runs.delete(chatId) // only OUR entry, never a successor's
    throw error
  }
}

/** Commit ONE chunk atomically: check the interleave watermark, cut the tail (first committed chunk
 *  only), insert the chunk's ops, advance the progress row. Returns the post-commit watermark. */
const commitChunk = (
  profileId: string,
  chatId: string,
  cut: { tables: string[]; fromFloor: number } | null,
  floorOps: FloorOp[],
  selected: string[],
  fromFloor: number,
  toFloor: number,
  lastKnownMax: number,
  expectEpoch: number
): number => {
  transact(() => {
    // Staleness fence (the refill race): the batch just awaited its LLM call — the one point a
    // truncate/edit/swipe can interleave. A moved epoch means the transcript this chunk was composed
    // from no longer exists as read → drop the chunk instead of committing ops for dead floors.
    if (transcriptEpoch(chatId) !== expectEpoch) throw new Error('tables.refillTranscriptChanged')
    const observed = opsWatermark(chatId)
    if (watermarkMoved(observed, lastKnownMax)) throw new Error('tables.refillInterleaved')
    if (cut) deleteOpsFor(profileId, chatId, cut.tables, cut.fromFloor)
    appendOpsAt(chatId, floorOps, 'refill')
    upsertRefillProgress(chatId, selected, fromFloor, toFloor, 'in_progress')
  })
  return opsWatermark(chatId)
}

const emit = (p: {
  chatId: string
  batchIndex: number
  batchCount: number
  span: BatchSpan | null
  status: 'running' | 'batch-ok' | 'batch-failed' | 'done' | 'cancelled' | 'error'
  message?: string
  completedUntil: number
}): void => notifyBackfillProgress({ kind: 'refill', ...p })

/** The async refill body: shadow build → ascending batches, each its own commit chunk + publish. */
const runRefill = async (
  profileId: string,
  chatId: string,
  gen: GenContext,
  template: TableTemplate,
  floors: FloorFile[],
  selected: string[],
  from: number,
  latest: number,
  spans: BatchSpan[],
  retries: number,
  extraHint: string | undefined,
  token: string,
  state: RefillRunState,
  signal: AbortSignal,
  epoch0: number
): Promise<void> => {
  const selectedSet = new Set(selected)
  const shadow = refillShadowPath(profileId, chatId)
  const globalDefault = getSettings(profileId).tables?.default_update_frequency ?? 3
  const selectedDisplay = template.tables
    .filter((t) => selectedSet.has(t.sqlName))
    .map((t) => t.displayName)
  const allowed = templateSqlNames(template)

  emit({ chatId, batchIndex: -1, batchCount: spans.length, span: null, status: 'running', completedUntil: -1 })

  let cutDone = false
  let lastKnownMax = 0
  // Set when a batch exhausts its retries — STOPS the run (F1): the tail is already cut, so skipping
  // past a failed span would finalize over a permanent hole. See `refillRunOutcome`.
  let failedReason: string | null = null

  // Guard-lease HEARTBEAT (§0b-2, the >120s-batch hole). The token-owned write lease must NOT lapse
  // mid-batch: one batch's `await runMaintainerBatch` can span up to `retries` API re-tries PLUS
  // SQL-corrective re-asks — routinely longer than WRITE_GUARD_MS (120s) — and the per-batch renew at
  // the loop top fires BEFORE that await. Without a heartbeat the lease expires mid-await, `isTableWriteBusy`
  // reads false, and a destructive PROBE (the structure migration's pre-check, a template delete/assign)
  // could hand the slot away — or, if nobody reclaims it, the run's OWN expired token still renews fine
  // afterward (`renewTableWrite` checks token IDENTITY, not expiry) and the run publishes over stale
  // schema. `startGuardHeartbeat` renews on an interval well under half of WRITE_GUARD_MS; see its doc.
  const heartbeat = startGuardHeartbeat(() => renewTableWrite(chatId, token))

  try {
    // SHADOW BUILD — instantiate the temp file + replay every op EXCEPT the selected tables' tail.
    removeShadow(profileId, chatId)
    instantiateAt(shadow, template, `${chatId} (refill shadow)`)
    const ops: TableOpWithTarget[] = listOpsForReplay(chatId)
    const survivors = ops.filter((o) => shouldReplayIntoShadow(o, selectedSet, from))
    replayOpsInto(shadow, template, survivors)
    lastKnownMax = opsWatermark(chatId)

    for (let i = 0; i < spans.length; i++) {
      if (signal.aborted) break
      const span = spans[i]
      state.batchIndex = i
      state.span = span

      // Guard heartbeat: never outlive the 120s stale expiry. A lost slot stops before the next commit.
      if (!renewTableWrite(chatId, token)) throw new Error('tables.refillGuardLost')

      // Render the maintainer's tables block FROM THE SHADOW (all tables = full context).
      const reads = readAllTablesAt(shadow, template)
      const block = composeTablesBlock(template, reads, globalDefault)
      const transcript = buildBatchTranscript(floors, span.from, span.to)
      const system = refillMaintainerPrompt(block, transcript, span.from, span.to, selectedDisplay, extraHint)
      const messages: ChatMessage[] = [{ role: 'system', content: system }]

      // Apply to the SHADOW, filtered to selected tables; record the executed statements.
      let recorded: string[] = []
      const apply = (sql: string): void => {
        recorded = []
        if (!sql.trim()) return
        const validated = validateBatch(sql, allowed) // throws TableSqlError → corrective re-ask
        const { kept, dropped } = partitionBySelected(validated, selectedSet)
        state.droppedOutOfScope += dropped.length
        if (dropped.length) {
          log('info', `refill dropped ${dropped.length} out-of-scope statement(s) (chat ${chatId})`)
        }
        if (kept.length) {
          const res = applySqlBatchAt(shadow, template, kept.join(';\n'))
          recorded = res.statements
        }
      }

      let applied: boolean
      try {
        applied = await runMaintainerBatch(gen, messages, retries, signal, apply)
      } catch (error) {
        // Exhausted retries / API give-up: STOP the run (stop-and-resume, NOT backfill's continue —
        // the tail is already cut, so a skipped span would become a permanent, non-resumable hole).
        // Committed chunks + the 'in_progress' row stay; Resume retries exactly this span.
        const reason = error instanceof Error ? error.message : String(error)
        state.failures.push({ span, reason })
        failedReason = reason
        log('info', `refill batch ${span.from}-${span.to} failed (chat ${chatId}): ${reason}`)
        emit({
          chatId,
          batchIndex: i,
          batchCount: spans.length,
          span,
          status: 'batch-failed',
          message: reason,
          completedUntil: state.completedUntil
        })
        break
      }
      if (!applied) break // cancelled mid-batch: leave uncommitted

      // Commit-ordering backstop: if the heartbeat EVER reported a lost slot during the await above,
      // STOP before writing — this iteration's commitChunk would otherwise run before the next loop-top
      // renew check could catch it. `lost()` recomputes freshly, so this genuinely catches the
      // event-loop-starvation case: timers starved past WRITE_GUARD_MS so a probe could have seen the
      // lease free, yet the run's identity-owned token would still renew fine — the proven renewal gap
      // trips here even if no timer fired between the last tick and this commit. Reuses the guard-lost key.
      if (heartbeat.lost()) throw new Error('tables.refillGuardLost')

      // COMMIT this chunk (= this batch) + PUBLISH the shadow over the live sandbox.
      const plan = planChunkCommit(cutDone, selected, from, recorded, span.to, span.from)
      lastKnownMax = Math.max(
        lastKnownMax,
        commitChunk(
          profileId,
          chatId,
          plan.cut,
          plan.floorOps,
          selected,
          from,
          span.to,
          lastKnownMax,
          epoch0
        )
      )
      if (plan.cut) cutDone = true
      state.completedUntil = span.to

      try {
        publishShadow(profileId, chatId)
      } catch (pubErr) {
        // Publish (file copy) failed — the ops are already committed, so an unguarded op-log rebuild
        // reproduces the same live state (we hold the guard, so the GUARDED rebuild would self-skip).
        log('info', `refill publish failed (chat ${chatId}); rebuilding from op log: ${pubErr}`)
        rebuildSandboxUnguarded(profileId, chatId, template)
      }

      emit({
        chatId,
        batchIndex: i,
        batchCount: spans.length,
        span,
        status: 'batch-ok',
        completedUntil: span.to
      })
    }

    state.running = false
    // Finalize guard (the refill race): a cut/edit that landed AFTER the last commit but before this
    // point (or aborted the run via the onTranscriptCut hook) must not finalize — advancing pointers
    // to the STALE `latest` would overshoot the clamp truncateFloors just applied. Routed as a
    // failure so the rail states the reason; the (already-clamped) resume row makes Resume sound.
    if (failedReason == null && transcriptEpoch(chatId) !== epoch0) {
      failedReason = 'tables.refillTranscriptChanged'
    }
    const outcome = refillRunOutcome(signal.aborted, failedReason)
    if (!outcome.finalize) {
      // Failed batch or cancel: committed chunks + the 'in_progress' progress row STAY (completedUntil
      // = the last GOOD chunk; pointers untouched) so Resume retries exactly what didn't commit.
      // Only the shadow is dropped. A failed batch MUST NOT fall through into FINALIZE.
      removeShadow(profileId, chatId)
      emit({
        chatId,
        batchIndex: state.batchIndex,
        batchCount: spans.length,
        span: state.span,
        status: outcome.status,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
        completedUntil: state.completedUntil
      })
      return
    }

    // FINALIZE (clean full run only): refilled ⇒ current; drop the resume record + shadow.
    advanceProgress(profileId, chatId, selected, latest)
    deleteRefillProgress(chatId)
    removeShadow(profileId, chatId)
    emit({
      chatId,
      batchIndex: state.batchIndex,
      batchCount: spans.length,
      span: state.span,
      status: 'done',
      completedUntil: state.completedUntil
    })
  } catch (error) {
    // FAILURE/ABORT: committed chunks + the 'in_progress' progress row STAY (paid work is never thrown
    // away — Resume starts from completed_until + 1); drop the shadow.
    state.running = false
    removeShadow(profileId, chatId)
    const reason = error instanceof Error ? error.message : String(error)
    log('info', `refill run failed (chat ${chatId}): ${reason}`)
    emit({
      chatId,
      batchIndex: state.batchIndex,
      batchCount: spans.length,
      span: state.span,
      status: 'error',
      message: reason,
      completedUntil: state.completedUntil
    })
  } finally {
    heartbeat.stop() // stop the guard heartbeat before the token release below.
    // The refill race: floors were truncated mid-run → truncateFloors' own guarded rebuild SELF-SKIPPED
    // (we held the guard), leaving the live sandbox at the last published shadow while the op log was
    // already cut. Rebuild from the (truncated) op log while we STILL hold the guard, then release.
    if (transcriptEpoch(chatId) !== epoch0) {
      try {
        rebuildSandboxUnguarded(profileId, chatId, template)
      } catch (rebuildErr) {
        log('info', `refill post-cut sandbox rebuild failed (chat ${chatId}): ${rebuildErr}`)
      }
    }
    endTableWrite(chatId, token) // token-checked release — never frees a successor's claim
  }
}

/**
 * Resume an interrupted refill: read the persisted `in_progress` row and start a fresh refill for the
 * SAME tables from `completed_until + 1` (the op-log composes exactly). Rejects when there is no
 * interrupted refill to resume or one is already running. `extra` may override the api preset / retries.
 */
export const resumeRefill = async (
  profileId: string,
  chatId: string,
  extra: { apiPresetId?: string; retries?: number; extraHint?: string; batchSize?: number } = {}
): Promise<void> => {
  const row = getRefillProgress(chatId)
  if (!row || row.status !== 'in_progress') throw new Error('tables.refillNothingToResume')
  await startRefill(profileId, chatId, {
    tables: row.selected,
    fromFloor: resumeRefillFrom(row.fromFloor, row.completedUntil),
    ...extra
  })
}
