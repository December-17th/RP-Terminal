// Persisted workflow run history (agent-packs plan WP2.3; ADR 0003 — the Runs timeline shows every
// run, turn + headless, attributed to pack + trigger).
//
// WHAT THIS DOES. Every workflow run — a player turn's effective-graph run, a headless trigger run, a
// manual run — is broadcast LIVE to the debug trace panel today (workflowEvents.notifyWorkflowTrace),
// but that broadcast is EPHEMERAL (the renderer keeps only the latest trace per chat). This store is
// the DURABLE record the phase-3 Runs timeline (WP3.3) reads: a per-chat, ring-capped (last
// RUN_HISTORY_CAP) log of StoredRunRecord (shared/workflow/trace.ts) — the full trace annotated with
// origin / packIds / trigger. Newest-first cursor paging via `beforeSeq`.
//
// STORAGE STAYS FAITHFUL. We store the trace EXACTLY as broadcast — including a headless run's
// synthetic `__headless_seed_*` nodes (headlessRunService). Filtering those out of the DISPLAY is
// WP3.3's job (plan Amendment "after WP2.1–2.2"); the store never mutates the trace.
//
// PERSISTENCE NEVER AFFECTS A RUN. The two call sites (generationService turn path,
// headlessRunService headless/manual path) invoke appendRun on a DETACHED path, wrapped in try/catch
// there; the store additionally never throws from a caught position. A failed insert loses one
// history row — it must NEVER break the turn or the headless run (ADR 0003).
//
// SQLITE STANCE. Like the other main stores (tableProgressService, agentPackStore, nodeStateService),
// the native better-sqlite3 binary can't load under plain Node, so the SQL wrappers are
// runtime-validated only. The PURE logic that decides paging + ring-cap pruning is exported
// (pageNewestFirst, overflowSeqs, rowToRecord) and unit-tested directly (test/runHistoryStore.test.ts).

import { getDb } from './db'
import { StoredRunRecord, WorkflowRunTrace } from '../../shared/workflow/trace'

/** Ring cap: how many run-history rows to keep PER CHAT. The oldest beyond this are pruned on insert.
 *  A module constant (plan WP2.3: "keep the most recent 200 per chat"). */
export const RUN_HISTORY_CAP = 200

// ── Pure helpers (unit-tested directly under the sqlite mock) ─────────────────────────────────────

/** A raw agent-run-history DB row (the columns as stored). Exported for the row-mapping test. */
export interface RunHistoryRow {
  chat_id: string
  seq: number
  run_id: string
  started_at: number
  origin: string
  pack_ids: string
  trigger: string | null
  /** WP-D run attribution: JSON array of firing trigger-node ids; NULL for turns + pre-WP-D rows. */
  trigger_node_ids: string | null
  ok: number
  aborted: number
  duration_ms: number
  trace: string
}

/** Parse a raw DB row into a StoredRunRecord. The trace/pack_ids blobs are JSON; a corrupt blob is a
 *  real defect (appendRun only ever writes JSON.stringify output), so JSON.parse throwing here is
 *  acceptable — the caller (listRuns) is a read path with no run to protect. */
export const rowToRecord = (row: RunHistoryRow): StoredRunRecord => {
  const trace = JSON.parse(row.trace) as WorkflowRunTrace
  const packIds = JSON.parse(row.pack_ids) as string[]
  // WP-D: trigger_node_ids is additive + nullable — a pre-WP-D row (or a turn run) has none.
  const triggerNodeIds =
    row.trigger_node_ids != null ? (JSON.parse(row.trigger_node_ids) as string[]) : null
  return {
    runId: row.run_id,
    seq: row.seq,
    origin: row.origin as StoredRunRecord['origin'],
    packIds: Array.isArray(packIds) ? packIds : [],
    ...(row.trigger != null ? { trigger: row.trigger } : {}),
    ...(Array.isArray(triggerNodeIds) && triggerNodeIds.length > 0 ? { triggerNodeIds } : {}),
    trace
  }
}

/** PURE: given ALL of a chat's stored seqs (any order) and a cap, return the seqs to DELETE to keep
 *  only the most recent `cap` (the smallest seqs beyond the cap). Empty when at/under the cap. This is
 *  the ring-cap decision, expressed independently of SQL so it is unit-testable (the SQL wrapper does
 *  the equivalent as a single DELETE keyed on the threshold seq). */
export const overflowSeqs = (seqs: number[], cap: number): number[] => {
  if (seqs.length <= cap) return []
  // Keep the `cap` largest; everything below the threshold is overflow.
  const sorted = [...seqs].sort((a, b) => a - b)
  return sorted.slice(0, sorted.length - cap)
}

/** PURE: page a chat's records newest-first with an optional `beforeSeq` cursor. Returns the records
 *  with seq STRICTLY LESS THAN `beforeSeq` (absent = from the newest), newest first, capped at
 *  `limit`. The WP3.3 timeline pages backward by passing the smallest seq of the previous page as the
 *  next `beforeSeq`. Input order is irrelevant (we sort). */
export const pageNewestFirst = (
  records: StoredRunRecord[],
  beforeSeq: number | undefined,
  limit: number
): StoredRunRecord[] => {
  const filtered = beforeSeq == null ? records : records.filter((r) => r.seq < beforeSeq)
  return [...filtered].sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, limit))
}

/** Clamp/normalize a requested page limit to a sane range (defends the SQL LIMIT + the renderer). */
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200
export const clampLimit = (limit: number | undefined): number => {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT)
}

// ── SQL wrappers (runtime-validated only; the sqlite mock returns empty rows under Node) ───────────

/** The next per-chat monotonic seq: `MAX(seq)+1` for the chat, or 0 for the first row. */
const nextSeq = (chatId: string): number => {
  const row = getDb()
    .prepare('SELECT MAX(seq) AS maxSeq FROM workflow_run_history WHERE chat_id = ?')
    .get(chatId) as { maxSeq: number | null } | undefined
  return (row?.maxSeq ?? -1) + 1
}

/**
 * Append one run to a chat's history and prune beyond the ring cap. Assigns the per-chat monotonic
 * `seq` (returned on the record). `cap` is injectable (defaults RUN_HISTORY_CAP) so tests can pin a
 * small ring; production always uses the constant. Insert + prune run in one transaction.
 *
 * `record` is the caller's StoredRunRecord WITHOUT a resolved `seq` (the store owns seq); its `seq`
 * field is ignored and re-assigned. Never throws for a "no chat" case — the row is chat-keyed only
 * (no FK), matching the run history's decoupled-from-chat-lifecycle stance.
 */
export const appendRun = (
  _profileId: string,
  record: StoredRunRecord,
  cap: number = RUN_HISTORY_CAP
): StoredRunRecord => {
  const db = getDb()
  const chatId = record.trace.chatId
  const stored: StoredRunRecord = { ...record, seq: nextSeq(chatId) }
  const insert = db.prepare(
    `INSERT INTO workflow_run_history
       (chat_id, seq, run_id, started_at, origin, pack_ids, trigger, trigger_node_ids, ok, aborted, duration_ms, trace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  // Prune: keep only the most recent `cap` — delete rows whose seq is <= (thisSeq - cap). Because seq
  // is per-chat monotonic and dense-ish, "thisSeq - cap" is the largest seq that must be dropped to
  // leave `cap` rows including the one just inserted.
  const prune = db.prepare('DELETE FROM workflow_run_history WHERE chat_id = ? AND seq <= ?')
  db.transaction(() => {
    insert.run(
      chatId,
      stored.seq,
      stored.runId,
      stored.trace.startedAt,
      stored.origin,
      JSON.stringify(stored.packIds),
      stored.trigger ?? null,
      // WP-D run attribution: NULL when absent/empty so pre-WP-D reads and turn runs stay unchanged.
      stored.triggerNodeIds && stored.triggerNodeIds.length > 0
        ? JSON.stringify(stored.triggerNodeIds)
        : null,
      stored.trace.ok ? 1 : 0,
      stored.trace.aborted ? 1 : 0,
      stored.trace.durationMs,
      JSON.stringify(stored.trace)
    )
    prune.run(chatId, stored.seq - cap)
  })()
  return stored
}

/** List a chat's runs newest-first, paging backward from `beforeSeq` (absent = newest). `limit` is
 *  clamped (clampLimit). Reads via SQL ORDER BY seq DESC LIMIT — the pure pageNewestFirst mirrors this
 *  for the unit tests. */
export const listRuns = (
  _profileId: string,
  chatId: string,
  opts: { beforeSeq?: number; limit?: number } = {}
): StoredRunRecord[] => {
  const limit = clampLimit(opts.limit)
  const db = getDb()
  const rows = (
    opts.beforeSeq == null
      ? db
          .prepare(
            'SELECT * FROM workflow_run_history WHERE chat_id = ? ORDER BY seq DESC LIMIT ?'
          )
          .all(chatId, limit)
      : db
          .prepare(
            'SELECT * FROM workflow_run_history WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
          )
          .all(chatId, opts.beforeSeq, limit)
  ) as RunHistoryRow[]
  return rows.map(rowToRecord)
}
