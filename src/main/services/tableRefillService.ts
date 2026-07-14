import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { getAllFloors, transcriptEpoch, onTranscriptCut } from './floorService'
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
  listOpsForReplay,
  opsWatermark,
  appendOpsAt,
  deleteOpsFor,
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
 *  2. a token-owned write guard renewed per batch (the 120s stale-expiry would silently drop the lock),
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
 * Assemble a chunk's commit plan (PURE): the recorded statements attributed to the batch's LAST floor
 * (`toFloor` = `span.to` — the per-floor attribution FIX), plus the tail cut — present ONLY on the first
 * COMMITTED chunk (`cutDone` false), which deletes the selected tables' ops at/after `fromFloor` so the
 * mid-refill state is base + regenerated-so-far (never a stale/new mix). Later chunks carry no cut.
 */
export const planChunkCommit = (
  cutDone: boolean,
  selected: string[],
  fromFloor: number,
  recorded: string[],
  toFloor: number
): { cut: { tables: string[]; fromFloor: number } | null; floorOps: FloorOp[] } => ({
  cut: cutDone ? null : { tables: selected, fromFloor },
  floorOps: recorded.map((sql) => ({ floor: toFloor, sql }))
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

  const requested =
    typeof opts.fromFloor === 'number'
      ? opts.fromFloor
      : defaultRefillFrom(getProgress(profileId, chatId), selected, latest)
  const from = Math.max(0, Math.min(requested, latest))

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

      // COMMIT this chunk (= this batch) + PUBLISH the shadow over the live sandbox.
      const plan = planChunkCommit(cutDone, selected, from, recorded, span.to)
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
