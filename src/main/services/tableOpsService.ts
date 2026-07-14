import Database from 'better-sqlite3'
import fs from 'fs'
import { getDb } from './db'
import { log } from './logService'
import * as tableDbService from './tableDbService'
import { replayOneOp, validateBatch, TableSqlError, classifyStatement } from './tableSql'
import { templateSqlNames, sandboxDbPath } from './tableDbService'
import { TableTemplate } from '../types/tableTemplate'

/**
 * Floor-keyed op log + rewind replay for SQL-table memory (issue 03).
 *
 * Every applied write batch is appended to `table_ops (chat_id, floor, seq, sql)` in the APP DB.
 * When floors are truncated (regenerate/swipe/delete-from), ops at/after the cut floor are dropped
 * and the per-chat sandbox is rebuilt: instantiate from the template's DDL, then replay the
 * surviving ops IN ORDER (deterministic — single-writer, the pure `replayPlan` helper pins the
 * order/attribution). A per-chat write lock (`tableDbService` sandbox is single-writer) serializes
 * concurrent graph writes — the same claim/release slot pattern the removed compactionService used.
 *
 * Replay is FAIL-OPEN: an op that now fails (e.g. a template change altered a column) is logged and
 * skipped, never bricking the chat. The pure `replayPlan` is unit-tested; DB I/O + real SQL replay
 * are not (better-sqlite3 is alias-mocked; see docs/sdk/table-templates.md + the plan's Testing note).
 */

export interface TableOp {
  floor: number
  seq: number
  sql: string
}

/**
 * Provenance label stored in `table_ops.source`, identifying which write path produced an op.
 * Legacy rows (logged before this column existed) carry NULL — provenance is not reconstructable.
 * `'baseline'` marks a structural re-baseline (see `tableStructureService.rewriteOpLog`), which the
 * refill baseline-gate reads via `hasBaselineOps`.
 */
export type TableOpSource = 'maintain' | 'backfill' | 'edit' | 'baseline' | 'refill'

// ---- pure classification helper (unit-tested) ------------------------------------------------

/**
 * The target table an op writes to, for `target_table` attribution — the same single-table classifier
 * the write path validates against. Every logged statement was `validateBatch`-gated, so this is
 * deterministic in practice; `'*'` is the defensive fallback for a statement that no longer classifies
 * (e.g. a raw op predating the column). `'*'` rows are the always-replay tail: they are NEVER dropped
 * by the table-scoped `deleteOpsFor` cut.
 */
export const opTargetTable = (sql: string): string => {
  try {
    return classifyStatement(sql).table
  } catch {
    return '*'
  }
}

// ---- op-log CRUD (app DB) --------------------------------------------------------------------

/**
 * Append a batch of statements as ops at `floor`, continuing the per-(chat,floor) `seq` counter.
 * Each statement is classified internally to stamp `target_table` (the write scope was just
 * `validateBatch`-gated, so this is deterministic; `'*'` fallback). `source` records the write path
 * that produced the batch (`undefined` ⇒ stored NULL — kept for callers that don't attribute).
 */
export const appendOps = (
  _profileId: string,
  chatId: string,
  floor: number,
  sqls: string[],
  source?: TableOpSource
): void => {
  if (!sqls.length) return
  const db = getDb()
  const row = db
    .prepare('SELECT MAX(seq) AS maxSeq FROM table_ops WHERE chat_id = ? AND floor = ?')
    .get(chatId, floor) as { maxSeq: number | null } | undefined
  let seq = (row?.maxSeq ?? -1) + 1
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'INSERT INTO table_ops (chat_id, floor, seq, sql, created_at, target_table, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const insertAll = db.transaction(() => {
    for (const sql of sqls) stmt.run(chatId, floor, seq++, sql, now, opTargetTable(sql), source ?? null)
  })
  insertAll()
}

/** All ops for a chat, ordered by (floor, seq) — the replay order. */
export const listOps = (_profileId: string, chatId: string): TableOp[] =>
  getDb()
    .prepare('SELECT floor, seq, sql FROM table_ops WHERE chat_id = ? ORDER BY floor, seq')
    .all(chatId) as TableOp[]

/** One op as shown in the History surface (Memory-Manager WP3). The rewind CUT target is `floor`
 *  (deleteOpsFrom drops that floor and everything after — floor is the rewind granularity). */
export interface TableOpView {
  floor: number
  seq: number
  /** Statement kind, derived from the op SQL via the same classifier the write path uses. */
  kind: 'insert' | 'update' | 'delete' | 'other'
  /** Target table name, derived from the op SQL (null when the raw SQL no longer classifies). */
  table: string | null
  /** ISO timestamp the op was appended (`table_ops.created_at`); null if the row predates it. */
  createdAt: string | null
  /** Write-path provenance (`table_ops.source`); null for legacy rows logged before the column. */
  source: TableOpSource | null
}

/**
 * Display projection of the op log, NEWEST-FIRST, for the History surface (Memory-Manager WP3).
 * `table_ops` has no author column, so ops are labelled by STATEMENT (kind + target table) derived
 * from the stored SQL — NOT by maintenance-vs-hand-edit (that provenance isn't recorded). Read-only;
 * the rewind cut is keyed to each entry's `floor`.
 */
export const listOpsForDisplay = (_profileId: string, chatId: string): TableOpView[] => {
  const rows = getDb()
    .prepare(
      'SELECT floor, seq, sql, created_at, source FROM table_ops WHERE chat_id = ? ORDER BY floor DESC, seq DESC'
    )
    .all(chatId) as Array<{
    floor: number
    seq: number
    sql: string
    created_at: string | null
    source: TableOpSource | null
  }>
  return rows.map((r) => {
    let kind: TableOpView['kind'] = 'other'
    let table: string | null = null
    try {
      const info = classifyStatement(r.sql)
      kind = info.kind
      table = info.table
    } catch {
      // Accepted ops always classify; a stored statement that no longer does → labelled 'other'.
    }
    return {
      floor: r.floor,
      seq: r.seq,
      kind,
      table,
      createdAt: r.created_at ?? null,
      source: r.source ?? null
    }
  })
}

/** Drop every op at/after `fromFloor` (rewind cut). Returns the number of rows deleted. */
export const deleteOpsFrom = (_profileId: string, chatId: string, fromFloor: number): number =>
  getDb()
    .prepare('DELETE FROM table_ops WHERE chat_id = ? AND floor >= ?')
    .run(chatId, fromFloor).changes

/** Drop the chat's entire op log (template (re)assignment — stale ops must never replay). */
export const deleteAllOps = (_profileId: string, chatId: string): void => {
  getDb().prepare('DELETE FROM table_ops WHERE chat_id = ?').run(chatId)
}

/**
 * Drop ops at/after `fromFloor` whose `target_table` is in `tables` (the refill tail cut, scoped to the
 * regenerated tables). `'*'` rows (unclassifiable / always-replay) are NEVER matched by the IN-list, so
 * they survive — do not pass `'*'` in `tables`. A no-op when `tables` is empty. Returns rows deleted.
 */
export const deleteOpsFor = (
  _profileId: string,
  chatId: string,
  tables: string[],
  fromFloor: number
): number => {
  if (!tables.length) return 0
  const placeholders = tables.map(() => '?').join(', ')
  return getDb()
    .prepare(
      `DELETE FROM table_ops WHERE chat_id = ? AND floor >= ? AND target_table IN (${placeholders})`
    )
    .run(chatId, fromFloor, ...tables).changes
}

/**
 * True when any of `tables` carries a structural re-baseline op (`source='baseline'`, floor-0 full-data
 * INSERTs written by `tableStructureService.rewriteOpLog`). A partial refill of such a table would
 * re-duplicate content, so the refill engine (WS2) gates on this. A no-op ⇒ false when `tables` empty.
 * Legacy NULL-source baselines (logged before the `source` column) are undetectable — documented risk.
 */
export const hasBaselineOps = (_profileId: string, chatId: string, tables: string[]): boolean => {
  if (!tables.length) return false
  const placeholders = tables.map(() => '?').join(', ')
  const row = getDb()
    .prepare(
      `SELECT 1 FROM table_ops WHERE chat_id = ? AND source = 'baseline' AND target_table IN (${placeholders}) LIMIT 1`
    )
    .get(chatId, ...tables)
  return row !== undefined
}

// ---- pure replay helper (unit-tested) --------------------------------------------------------

/**
 * The ops that SURVIVE a cut at `fromFloor` (i.e. floor < fromFloor), in replay order (floor, seq).
 * This is what the rewind AC pins under the alias mock — live state-equality lands in the owner's
 * manual pass. Input need not be pre-sorted; the output is (floor, seq)-ordered.
 */
export const replayPlan = (ops: TableOp[], fromFloor: number): TableOp[] =>
  ops
    .filter((o) => o.floor < fromFloor)
    .sort((a, b) => (a.floor - b.floor) || (a.seq - b.seq))

// ---- per-chat write lock (compaction-slot pattern) -------------------------------------------

// Chats with an in-flight table write. The sandbox is single-writer; a rapid second graph write for
// the same chat must serialize. Time-stamped with a stale expiry so a chain that dies mid-write
// (aborted graph / crash) can't lock a chat out forever.
const writing = new Map<string, number>()
const WRITE_GUARD_MS = 120_000

/** Claim the per-chat write slot; false while another write is in flight (unexpired). */
export const tryBeginTableWrite = (chatId: string): boolean => {
  const started = writing.get(chatId)
  if (started !== undefined && Date.now() - started < WRITE_GUARD_MS) return false
  writing.set(chatId, Date.now())
  return true
}

/** Release the per-chat write slot (from the completing OR failing path — always via finally). */
export const endTableWrite = (chatId: string): void => {
  writing.delete(chatId)
}

// ---- rewind rebuild --------------------------------------------------------------------------

/**
 * Rebuild a chat's sandbox from scratch: instantiate the template (DDL + initial rows), then replay
 * every logged op in (floor, seq) order. A replay op that now fails is logged and SKIPPED (fail-open
 * — never brick a chat). No-op when no template is assigned (just removes the sandbox). Takes the
 * per-chat write lock; a busy chat is skipped (the caller — truncateFloors — is best-effort).
 *
 * `template` is resolved by the caller (chatService already has `getChatTableTemplateId` +
 * `getTableTemplateById`) so this module needn't import chatService — avoiding a load-time cycle.
 */
export const rebuildSandbox = (
  profileId: string,
  chatId: string,
  template: TableTemplate | null
): void => {
  if (!template) {
    tableDbService.removeSandbox(profileId, chatId)
    return
  }
  if (!tryBeginTableWrite(chatId)) {
    log('info', `Skipped sandbox rebuild for chat ${chatId} — a write is in flight`)
    return
  }
  try {
    tableDbService.instantiate(profileId, chatId, template)
    const ops = listOps(profileId, chatId)
    if (!ops.length) return
    replaySandbox(profileId, chatId, template, ops)
  } finally {
    endTableWrite(chatId)
  }
}

/**
 * History rewind (Memory-Manager WP3): roll a chat's tables back to BEFORE `fromFloor` by dropping
 * every op at/after it and rebuilding the sandbox from the survivors. This is the SAME two-step
 * `truncateFloors` runs for a floor cut (chatService), MINUS the floor deletion — DATA-ONLY: the chat
 * messages AND the per-table maintenance progress pointer (`tableProgressService`) are untouched, so a
 * rewound floor is NOT auto-re-maintained by the cadence gate (an accepted v1 gap — the "undo stays
 * undone" semantic; re-run maintenance/backfill to catch up). `rebuildSandbox` takes the per-chat
 * write lock ITSELF, so this is serialized against a concurrent rebuild without an outer lock (an outer
 * `tryBeginTableWrite` here would make rebuildSandbox's own claim fail and silently skip). Returns the
 * number of ops dropped. Reuses `deleteOpsFrom` + `rebuildSandbox` verbatim — no new rewind logic.
 */
export const rewindTables = (
  profileId: string,
  chatId: string,
  fromFloor: number,
  template: TableTemplate | null
): number => {
  const dropped = deleteOpsFrom(profileId, chatId, fromFloor)
  rebuildSandbox(profileId, chatId, template)
  return dropped
}

/** Open the freshly-instantiated sandbox and replay ops one by one (NOT one transaction — a
 *  failing op is logged and skipped while the rest still apply, the fail-open contract). */
const replaySandbox = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  ops: TableOp[]
): void => {
  const file = sandboxDbPath(profileId, chatId)
  if (!fs.existsSync(file)) return
  // Pre-validate against the (possibly changed) template registry; keep only replayable ops.
  const allowed = templateSqlNames(template)
  const db = new Database(file)
  try {
    for (const op of ops) {
      try {
        validateBatch(op.sql, allowed) // reject before executing (template may have changed)
        replayOneOp(db, template, op.sql)
      } catch (error) {
        const reason = error instanceof TableSqlError ? error.message : String(error)
        log('info', `Skipped replay op (chat ${chatId}, floor ${op.floor}, seq ${op.seq}): ${reason}`)
      }
    }
  } finally {
    db.close()
  }
}
