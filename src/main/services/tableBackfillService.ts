import { getChatTableTemplateId } from './chatService'
import { getTableTemplateById } from './tableTemplateService'
import { getAllFloors } from './floorService'
import { readAllTables } from './tableDbService'
import { composeTablesBlock, backfillMaintainerPrompt } from './tableMaintenance'
import { applySqlBatch, TableSqlError } from './tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from './tableOpsService'
import { advanceProgress } from './tableProgressService'
import { getSettings } from './settingsService'
import { buildGenContext } from './generation/genContext'
import { withPreset } from './generation/resilientCall'
import { runMaintainerBatch } from './tableMaintainerLoop'
import { stripThinking } from '../parsers/contentParser'
import { notifyBackfillProgress } from './tableBackfillEvents'
import { log } from './logService'
import { ChatMessage } from './promptBuilder'
import { FloorFile } from '../types/chat'
import { GenContext } from './generation/types'

/**
 * Manual backfill engine for SQL-table memory (issue 07): fill the tables from PAST chat history on
 * demand. The player picks a scope (last X floors, or all) processed in ASCENDING batches of Y floors;
 * each batch is treated as ONE 交互 (纪要表 gains exactly one row), runs a SINGLE maintainer LLM pass
 * over ALL template tables, and its `<TableEdit>` SQL is applied through the EXACT SAME op-logged write
 * path AI/hand writes take — the per-chat write lock → `applySqlBatch` → `appendOps` at the batch's
 * LAST floor → `advanceProgress`. No second write surface.
 *
 * The run is sequential + cancellable BETWEEN batches (a batch in flight finishes or fails; applied
 * batches stay applied). Optional auto-retry: API errors ride `callModelResilient`'s retry machinery,
 * SQL errors re-call the model with the failure fed back (a corrective attempt), capped at the same
 * retry count; exhausted retries mark the batch failed and the run CONTINUES (fail-open) — the failed
 * span stays visible as unprocessed. One backfill per chat at a time.
 */

export interface BackfillOpts {
  /** How many trailing floors to process, or 'all' for the whole chat. */
  lastFloors: number | 'all'
  /** Floors per batch (Y); each batch is one 交互 for 纪要 purposes. */
  batchSize: number
  /** A saved api_preset id to run the maintainer call against; unset = the active connection. */
  apiPresetId?: string
  /** Auto-retry budget per batch (0–5, 0 = off): API errors AND SQL-error corrective re-calls. */
  retries: number
}

/** A batch's floor span (0-based, inclusive). */
export interface BatchSpan {
  from: number
  to: number
}

export interface BackfillFailure {
  span: BatchSpan
  reason: string
}

/** In-memory run state, readable for view re-mounts (`getBackfillState`). Not persisted — a restart
 *  just lets the player start again (the progress pointers persist). */
export interface BackfillState {
  running: boolean
  batchIndex: number
  batchCount: number
  span: BatchSpan | null
  failures: BackfillFailure[]
}

// One AbortController + live state per chat with a backfill in flight (or just finished, for re-mount).
const runs = new Map<string, { controller: AbortController; state: BackfillState }>()

/** READ-ONLY: is a manual table backfill mid-job? (Classic Narrator plan, Milestone 4 — one of the
 *  sources unioned into `hasActiveBackgroundWork()`.) A backfill is a long-running multi-batch LLM
 *  job that writes memory tables and reaches the provider through `callModelResilient`, which never
 *  registers in `activeControllers` — so no other source can see it. Reads `state.running`, NOT the
 *  map size: a finished run's entry is kept so a re-mounted view can still read its final state. */
export const hasActiveBackfill = (): boolean => {
  for (const entry of runs.values()) if (entry.state.running) return true
  return false
}

/**
 * PURE (unit-tested): the ascending batch spans over the chosen scope. `totalFloors` is the chat's
 * floor COUNT; scope = the last X floors (`start = max(0, N - X)`, or 0 for 'all'), split into
 * ascending batches of `batchSize` (last batch partial). Empty chat / zero scope / non-positive
 * batchSize → []. Spans are 0-based inclusive `{ from, to }`.
 */
export const planBatches = (
  totalFloors: number,
  lastFloors: number | 'all',
  batchSize: number
): BatchSpan[] => {
  if (totalFloors <= 0 || batchSize <= 0) return []
  const scope = lastFloors === 'all' ? totalFloors : Math.max(0, Math.min(totalFloors, lastFloors))
  if (scope <= 0) return []
  const start = totalFloors - scope
  const spans: BatchSpan[] = []
  for (let from = start; from < totalFloors; from += batchSize) {
    spans.push({ from, to: Math.min(from + batchSize - 1, totalFloors - 1) })
  }
  return spans
}

/**
 * PURE: render floors `from..to` as a `User:`/`Assistant:` transcript (the context.history convention:
 * assistant content thinking-stripped, both sides trimmed, empties skipped). `floors` is the full
 * ordered floor list; `from`/`to` are 0-based indices into it.
 */
export const buildBatchTranscript = (floors: FloorFile[], from: number, to: number): string => {
  const lines: string[] = []
  for (let i = from; i <= to && i < floors.length; i++) {
    const f = floors[i]
    const user = (f?.user_message?.content ?? '').trim()
    if (user) lines.push(`User: ${user}`)
    const assistant = stripThinking(f?.response?.content ?? '').trim()
    if (assistant) lines.push(`Assistant: ${assistant}`)
  }
  return lines.join('\n')
}

/** Snapshot the run's public state (readable for a view re-mount). */
export const getBackfillState = (chatId: string): BackfillState | null =>
  runs.get(chatId)?.state ?? null

/** Cancel a running backfill (between-batch effect; the batch in flight finishes/fails). */
export const cancelBackfill = (_profileId: string, chatId: string): void => {
  runs.get(chatId)?.controller.abort()
}

/**
 * Apply a batch's `<TableEdit>` SQL through the shared write path, attributed to the batch's LAST
 * floor (`toFloor`) and carrying the batch's SPAN START (`fromFloor` = `span.from`) as `from_floor`
 * provenance so a later refill widens its cut onto the span boundary rather than bisecting it. Returns
 * true on apply (or an empty no-op), throws `TableSqlError` on a validation/exec failure (so the caller
 * can run the SQL-error corrective retry), and treats a busy write lock as a retryable failure (throws a
 * `TableSqlError` the corrective loop re-attempts).
 */
const applyBatch = (
  profileId: string,
  chatId: string,
  template: NonNullable<ReturnType<typeof getTableTemplateById>>,
  sql: string,
  fromFloor: number,
  toFloor: number,
  allTables: string[]
): void => {
  if (!sql.trim()) {
    // Empty tag → no-op apply; still advance progress so the span counts as processed.
    advanceProgress(profileId, chatId, allTables, toFloor)
    return
  }
  if (!tryBeginTableWrite(chatId)) {
    throw new TableSqlError('a table write is already in flight for this chat')
  }
  try {
    const result = applySqlBatch(profileId, chatId, template, sql)
    if (result.statements.length)
      appendOps(profileId, chatId, toFloor, result.statements, 'backfill', fromFloor)
    advanceProgress(profileId, chatId, allTables, toFloor)
  } finally {
    endTableWrite(chatId)
  }
}

/**
 * Start a backfill for a chat. Rejects (throws) if one is already running for the chat, no template is
 * assigned, or the chosen api_preset id is unknown. Runs asynchronously (the caller does not await the
 * whole run) — progress reaches the view through `notifyBackfillProgress`. Returns once validated + the
 * run has started.
 */
export const startBackfill = async (
  profileId: string,
  chatId: string,
  opts: BackfillOpts
): Promise<void> => {
  if (runs.get(chatId)?.state.running) throw new Error('tables.backfillAlreadyRunning')

  const templateId = getChatTableTemplateId(profileId, chatId)
  if (!templateId) throw new Error('tables.backfillNoTemplate')
  const template = getTableTemplateById(profileId, templateId)
  if (!template) throw new Error('tables.backfillNoTemplate')

  const floors = getAllFloors(profileId, chatId)
  const spans = planBatches(floors.length, opts.lastFloors, opts.batchSize)

  // Build the gen context once; swap to the chosen preset if given (unknown id fails at start).
  let gen = buildGenContext(profileId, chatId, '')
  if (opts.apiPresetId) {
    const swapped = withPreset(gen, opts.apiPresetId)
    if (!swapped) throw new Error('tables.backfillBadPreset')
    gen = swapped
  }

  const controller = new AbortController()
  const state: BackfillState = {
    running: true,
    batchIndex: -1,
    batchCount: spans.length,
    span: null,
    failures: []
  }
  runs.set(chatId, { controller, state })

  const allTables = template.tables.map((t) => t.sqlName)
  const retries = Math.max(0, Math.min(5, opts.retries))

  // Kick off the async run; do NOT await it here (the IPC caller returns immediately).
  void runBatches(
    profileId,
    chatId,
    gen,
    template,
    floors,
    spans,
    allTables,
    retries,
    state,
    controller.signal
  )
}

/** The sequential batch loop (extracted for readability; state is mutated in place + broadcast). */
const runBatches = async (
  profileId: string,
  chatId: string,
  gen: GenContext,
  template: NonNullable<ReturnType<typeof getTableTemplateById>>,
  floors: FloorFile[],
  spans: BatchSpan[],
  allTables: string[],
  retries: number,
  state: BackfillState,
  signal: AbortSignal
): Promise<void> => {
  notifyBackfillProgress({
    chatId,
    batchIndex: -1,
    batchCount: spans.length,
    span: null,
    status: 'running'
  })

  try {
    for (let i = 0; i < spans.length; i++) {
      if (signal.aborted) break
      const span = spans[i]
      state.batchIndex = i
      state.span = span

      try {
        const applied = await processBatch(
          profileId,
          chatId,
          gen,
          template,
          floors,
          span,
          allTables,
          retries,
          signal
        )
        // A cancel that lands mid-batch (inside the corrective loop) leaves the batch UNAPPLIED —
        // don't misreport it as ok; the loop's aborted check ends the run and 'cancelled' follows.
        if (applied) {
          notifyBackfillProgress({
            chatId,
            batchIndex: i,
            batchCount: spans.length,
            span,
            status: 'batch-ok'
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        state.failures.push({ span, reason })
        log(
          'info',
          `table backfill batch ${span.from}-${span.to} failed (chat ${chatId}): ${reason}`
        )
        notifyBackfillProgress({
          chatId,
          batchIndex: i,
          batchCount: spans.length,
          span,
          status: 'batch-failed',
          message: reason
        })
      }
    }

    state.running = false
    notifyBackfillProgress({
      chatId,
      batchIndex: state.batchIndex,
      batchCount: spans.length,
      span: state.span,
      status: signal.aborted ? 'cancelled' : 'done'
    })
  } catch (error) {
    // A run-level failure (e.g. the maintainer give-up on the very first batch when retries are off):
    // surface it and stop. Already-applied batches stay applied.
    state.running = false
    const reason = error instanceof Error ? error.message : String(error)
    notifyBackfillProgress({
      chatId,
      batchIndex: state.batchIndex,
      batchCount: spans.length,
      span: state.span,
      status: 'error',
      message: reason
    })
  }
}

/**
 * Process ONE batch: render the tables block over ALL template tables (current data — state advances
 * batch by batch), build the maintainer messages, call the model (API retry via callModelResilient),
 * extract `<TableEdit>`, and apply. On a SQL error, run up to `retries` corrective re-calls (the failed
 * reply + the error fed back). Exhausting the budget throws — the caller marks the batch failed (fail-
 * open), and progress is NOT advanced for it. An API give-up bubbles up as a throw too.
 * Returns true when the batch APPLIED; false only on a mid-batch cancel (batch left unapplied,
 * progress not advanced — the caller must not report it as ok).
 */
const processBatch = async (
  profileId: string,
  chatId: string,
  gen: GenContext,
  template: NonNullable<ReturnType<typeof getTableTemplateById>>,
  floors: FloorFile[],
  span: BatchSpan,
  allTables: string[],
  retries: number,
  signal: AbortSignal
): Promise<boolean> => {
  // Tables block over ALL template tables, with their CURRENT rows (earlier batches' writes are visible).
  // The backfill treats the WHOLE batch as one 交互 and maintains every table regardless of per-table
  // cadence — the resolved frequency here only shapes the rendered header cadence line (off → 手动维护).
  const globalDefault = getSettings(profileId).tables?.default_update_frequency ?? 3
  const tablesBlock = composeTablesBlock(
    template,
    readAllTables(profileId, chatId, template),
    globalDefault
  )

  const transcript = buildBatchTranscript(floors, span.from, span.to)
  const system = backfillMaintainerPrompt(tablesBlock, transcript, span.from, span.to)
  const messages: ChatMessage[] = [{ role: 'system', content: system }]

  // Model call + SQL-error corrective retries (shared with the refill engine). The apply step writes
  // the live sandbox + advances progress at the batch's LAST floor.
  return runMaintainerBatch(gen, messages, retries, signal, (sql) =>
    applyBatch(profileId, chatId, template, sql, span.from, span.to, allTables)
  )
}
