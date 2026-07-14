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
 *
 * `fromFloor` is the batch-wide SPAN START — the earliest floor whose content this batch summarizes
 * (ops are keyed to the batch's LAST floor via `floor`, so a multi-floor span's start would otherwise
 * be lost, and a refill cut that lands inside the span could bisect it). `undefined` ⇒ stored NULL =
 * "single-floor op" (`earliestSpanStart` COALESCEs NULL → `floor`, so legacy rows never widen a cut).
 */
export const appendOps = (
  _profileId: string,
  chatId: string,
  floor: number,
  sqls: string[],
  source?: TableOpSource,
  fromFloor?: number
): void => {
  if (!sqls.length) return
  const db = getDb()
  const row = db
    .prepare('SELECT MAX(seq) AS maxSeq FROM table_ops WHERE chat_id = ? AND floor = ?')
    .get(chatId, floor) as { maxSeq: number | null } | undefined
  let seq = (row?.maxSeq ?? -1) + 1
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'INSERT INTO table_ops (chat_id, floor, seq, sql, created_at, target_table, source, from_floor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const insertAll = db.transaction(() => {
    for (const sql of sqls)
      stmt.run(chatId, floor, seq++, sql, now, opTargetTable(sql), source ?? null, fromFloor ?? null)
  })
  insertAll()
}

/**
 * A single op at a specific floor, for the refill engine's floor-distributed attribution. Unlike
 * `appendOps` (one floor, a batch of statements), refill records each regenerated batch's statements
 * against that batch's `span.to` floor, so it inserts ops spanning MANY floors in one call.
 */
export interface FloorOp {
  floor: number
  sql: string
  /** The SPAN START of the batch that produced this op (its earliest source floor). Stamped into
   *  `from_floor` so a later refill can widen its cutpoint down and never bisect this span. */
  fromFloor: number
}

/**
 * Insert refill-produced ops, each at its OWN floor, continuing the per-(chat,floor) `seq` counter and
 * stamping `target_table` (classified per statement), `source` (the refill provenance), and `from_floor`
 * (the batch's SPAN START, so a later refill widens its cut down and never bisects the span). All rows
 * land in one transaction. A no-op when `floorOps` is empty. The floor-distributed counterpart to
 * `appendOps`: attribution is per BATCH (all of a batch's statements share the batch's `span.to` floor
 * and `span.from` start), so a later partial refill from a middle cutpoint widens onto a span boundary
 * and drops exactly the tail, never bisecting a collapsed batch.
 */
export const appendOpsAt = (chatId: string, floorOps: FloorOp[], source: TableOpSource): void => {
  if (!floorOps.length) return
  const db = getDb()
  const now = new Date().toISOString()
  const seqStmt = db.prepare('SELECT MAX(seq) AS maxSeq FROM table_ops WHERE chat_id = ? AND floor = ?')
  const insStmt = db.prepare(
    'INSERT INTO table_ops (chat_id, floor, seq, sql, created_at, target_table, source, from_floor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const nextSeq = new Map<number, number>()
  const insertAll = db.transaction(() => {
    for (const { floor, sql, fromFloor } of floorOps) {
      let seq = nextSeq.get(floor)
      if (seq === undefined) {
        const row = seqStmt.get(chatId, floor) as { maxSeq: number | null } | undefined
        seq = (row?.maxSeq ?? -1) + 1
      }
      insStmt.run(chatId, floor, seq, sql, now, opTargetTable(sql), source, fromFloor)
      nextSeq.set(floor, seq + 1)
    }
  })
  insertAll()
}

/** All ops for a chat, ordered by (floor, seq) — the replay order. */
export const listOps = (_profileId: string, chatId: string): TableOp[] =>
  getDb()
    .prepare('SELECT floor, seq, sql FROM table_ops WHERE chat_id = ? ORDER BY floor, seq')
    .all(chatId) as TableOp[]

/** An op carrying its stored `target_table`, for the refill shadow-replay filter (needs the attribution
 *  to decide which ops to roll back). Ordered by (floor, seq) — the replay order. */
export interface TableOpWithTarget extends TableOp {
  targetTable: string | null
}

/** All ops for a chat with their `target_table`, ordered by (floor, seq) — the refill shadow builder's
 *  input (it filters out the selected-tables tail, then replays the survivors into the shadow). */
export const listOpsForReplay = (chatId: string): TableOpWithTarget[] =>
  getDb()
    .prepare(
      'SELECT floor, seq, sql, target_table AS targetTable FROM table_ops WHERE chat_id = ? ORDER BY floor, seq'
    )
    .all(chatId) as TableOpWithTarget[]

/**
 * The chat's op-log high-water mark: `MAX(rowid)` over its `table_ops` rows (0 when the chat has none).
 * Since SQLite assigns each new row a rowid above the WHOLE table's current max, a foreign INSERT for
 * this chat (a concurrent auto-maintain that slipped past the guard) pushes this ABOVE a refill's own
 * last-observed value — the refill's per-chunk interleave check (`watermarkMoved`) reads it to abort a
 * commit rather than silently merge. Our own tail DELETEs only lower it, so the check treats only an
 * INCREASE as foreign.
 */
export const opsWatermark = (chatId: string): number => {
  const row = getDb()
    .prepare('SELECT MAX(rowid) AS m FROM table_ops WHERE chat_id = ?')
    .get(chatId) as { m: number | null } | undefined
  return row?.m ?? 0
}

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

/**
 * The earliest SPAN START among the chat's ops that touch `tables` and end at/after `fromFloor`:
 * `MIN(COALESCE(from_floor, floor))` over `floor >= fromFloor AND target_table IN tables`. Null when no
 * such op exists. A refill uses this to WIDEN its requested cutpoint down onto a span boundary so it can
 * never bisect a stored multi-floor batch (deleting the op but only regenerating from the mid-span cut,
 * losing the span's earlier floors). Legacy NULL-`from_floor` rows COALESCE to their own `floor` (which
 * is ≥ `fromFloor` here), so they never widen the cut below the requested point. A no-op ⇒ null when
 * `tables` empty. `'*'` rows are never in `tables`, so they're excluded (they always replay anyway).
 */
export const earliestSpanStart = (
  chatId: string,
  tables: string[],
  fromFloor: number
): number | null => {
  if (!tables.length) return null
  const placeholders = tables.map(() => '?').join(', ')
  const row = getDb()
    .prepare(
      `SELECT MIN(COALESCE(from_floor, floor)) AS m FROM table_ops WHERE chat_id = ? AND floor >= ? AND target_table IN (${placeholders})`
    )
    .get(chatId, fromFloor, ...tables) as { m: number | null } | undefined
  return row?.m ?? null
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
// (aborted graph / crash) can't lock a chat out forever. The slot is TOKEN-OWNED (table-refill §0b-2):
// a claim returns a unique token; release/renew are checked against it so a long refill can't have its
// slot silently handed to a concurrent auto-maintain by the 120s expiry, and a short-hold caller's
// `finally` can't free a DIFFERENT owner's claim.
const writing = new Map<string, { token: string; ts: number }>()
const WRITE_GUARD_MS = 120_000
let tokenSeq = 0

/**
 * Claim the per-chat write slot with a TOKEN-OWNED lease. Returns a fresh token string, or null while
 * another write holds an UNEXPIRED claim. The refill engine keeps the token, `renewTableWrite`s it after
 * every batch (so the 120s expiry never silently frees it mid-run), and releases it by token in a
 * `finally`. Short-hold callers use the `tryBeginTableWrite`/`endTableWrite(chatId)` wrappers below.
 */
export const beginTableWrite = (chatId: string): string | null => {
  const held = writing.get(chatId)
  if (held !== undefined && Date.now() - held.ts < WRITE_GUARD_MS) return null
  const token = `${Date.now()}-${++tokenSeq}`
  writing.set(chatId, { token, ts: Date.now() })
  return token
}

/**
 * Refresh a held claim's expiry IFF `token` still owns the slot. Returns false when the token no longer
 * owns it (the 120s expiry lapsed and another writer claimed it) — the caller must STOP before its next
 * commit rather than race a concurrent writer. A heartbeat the refill engine calls after every batch.
 */
export const renewTableWrite = (chatId: string, token: string): boolean => {
  const held = writing.get(chatId)
  if (!held || held.token !== token) return false
  held.ts = Date.now()
  return true
}

/**
 * Claim the per-chat write slot; false while another write is in flight (unexpired). Legacy wrapper over
 * `beginTableWrite` for the four SHORT-HOLD callers (memoryCore / backfill / edit / structure) that
 * complete well inside the 120s window and release unconditionally in a `finally`.
 */
export const tryBeginTableWrite = (chatId: string): boolean => beginTableWrite(chatId) !== null

/**
 * True while a write claim is held and UNEXPIRED for `chatId`. A pre-flight probe for destructive
 * callers that must REFUSE (rather than silently skip like the guarded `rebuildSandbox`) when a long
 * refill owns the slot — used by `removeTableTemplateIdFromChats` to reject a template delete atomically
 * before unbinding any bound chat. Mirrors `beginTableWrite`'s expiry test without claiming the slot.
 */
export const isTableWriteBusy = (chatId: string): boolean => {
  const held = writing.get(chatId)
  return held !== undefined && Date.now() - held.ts < WRITE_GUARD_MS
}

/**
 * Release the per-chat write slot. With a `token`, release IFF that token still owns the slot (the
 * refill engine's ownership-checked release — never frees a successor's claim). Without a token, the
 * legacy unconditional release the short-hold wrappers use from their `finally`.
 */
export const endTableWrite = (chatId: string, token?: string): void => {
  if (token !== undefined) {
    const held = writing.get(chatId)
    if (!held || held.token !== token) return
  }
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
    rebuildSandboxUnguarded(profileId, chatId, template)
  } finally {
    endTableWrite(chatId)
  }
}

/**
 * Rebuild a chat's LIVE sandbox from the op log WITHOUT taking the per-chat write guard. Two legitimate
 * callers, both of which ALREADY hold the guard by token so the self-claiming `rebuildSandbox` would
 * SILENTLY SKIP: (1) the refill engine's publish-FAILURE fallback — after a chunk's ops are committed the
 * op-log replay equals the shadow state, so a failed shadow file-publish falls back to this; and (2)
 * `rewindTables`, which claims the guard itself, deletes the tail ops, then rebuilds from the survivors.
 * Never call it from an UNGUARDED context — take the guard (or use `rebuildSandbox`).
 */
export const rebuildSandboxUnguarded = (
  profileId: string,
  chatId: string,
  template: TableTemplate
): void => {
  tableDbService.instantiate(profileId, chatId, template)
  const ops = listOps(profileId, chatId)
  if (!ops.length) return
  replaySandbox(profileId, chatId, template, ops)
}

/**
 * History rewind (Memory-Manager WP3): roll a chat's tables back to BEFORE `fromFloor` by dropping
 * every op at/after it and rebuilding the sandbox from the survivors. This is the SAME two-step
 * `truncateFloors` runs for a floor cut (chatService), MINUS the floor deletion — DATA-ONLY: the chat
 * messages AND the per-table maintenance progress pointer (`tableProgressService`) are untouched, so a
 * rewound floor is NOT auto-re-maintained by the cadence gate (an accepted v1 gap — the "undo stays
 * undone" semantic; re-run maintenance/backfill to catch up).
 *
 * This CLAIMS the per-chat write guard by token for the whole delete+rebuild, so it is serialized
 * against a concurrent write (auto-maintain / refill) as an ATOMIC unit: the earlier design ran
 * `deleteOpsFrom` unguarded and then let `rebuildSandbox` self-claim the guard — but a refill holding
 * the guard makes that rebuild SILENTLY SKIP, so the ops vanished while the sandbox kept the refill's
 * stale shadow. Now, if a refill owns the guard, we throw `tables.memoryWriteBusy` and touch nothing.
 * With the guard held we rebuild via the UNGUARDED path (mirroring what guarded `rebuildSandbox` does:
 * replay survivors when a template is bound, else remove the sandbox). Releases by token in `finally`.
 * Returns the number of ops dropped.
 */
export const rewindTables = (
  profileId: string,
  chatId: string,
  fromFloor: number,
  template: TableTemplate | null
): number => {
  const token = beginTableWrite(chatId)
  if (token === null) throw new Error('tables.memoryWriteBusy')
  try {
    const dropped = deleteOpsFrom(profileId, chatId, fromFloor)
    if (template) rebuildSandboxUnguarded(profileId, chatId, template)
    else tableDbService.removeSandbox(profileId, chatId)
    return dropped
  } finally {
    endTableWrite(chatId, token)
  }
}

/** Open the freshly-instantiated sandbox and replay ops one by one (NOT one transaction — a
 *  failing op is logged and skipped while the rest still apply, the fail-open contract). */
const replaySandbox = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  ops: TableOp[]
): void => {
  replayOpsInto(sandboxDbPath(profileId, chatId), template, ops)
}

/**
 * Replay an ordered op list into the sandbox file at `file` (already instantiated), one by one,
 * FAIL-OPEN: an op that no longer validates/executes (a template change, say) is logged and skipped
 * while the rest apply — never bricking the rebuild. Shared by the rewind rebuild (live path) and the
 * refill shadow build (temp path). A missing file is a no-op. `sql` is all the caller needs from each op.
 */
export const replayOpsInto = (
  file: string,
  template: TableTemplate,
  ops: Array<{ sql: string; floor?: number; seq?: number }>
): void => {
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
        log('info', `Skipped replay op (file ${file}, floor ${op.floor}, seq ${op.seq}): ${reason}`)
      }
    }
  } finally {
    db.close()
  }
}
