import Database from 'better-sqlite3'
import fs from 'fs'
import { getDb } from './db'
import { log } from './logService'
import * as tableDbService from './tableDbService'
import { replayOneOp, validateBatch, TableSqlError } from './tableSql'
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

// ---- op-log CRUD (app DB) --------------------------------------------------------------------

/** Append a batch of statements as ops at `floor`, continuing the per-(chat,floor) `seq` counter. */
export const appendOps = (
  _profileId: string,
  chatId: string,
  floor: number,
  sqls: string[]
): void => {
  if (!sqls.length) return
  const db = getDb()
  const row = db
    .prepare('SELECT MAX(seq) AS maxSeq FROM table_ops WHERE chat_id = ? AND floor = ?')
    .get(chatId, floor) as { maxSeq: number | null } | undefined
  let seq = (row?.maxSeq ?? -1) + 1
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'INSERT INTO table_ops (chat_id, floor, seq, sql, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const insertAll = db.transaction(() => {
    for (const sql of sqls) stmt.run(chatId, floor, seq++, sql, now)
  })
  insertAll()
}

/** All ops for a chat, ordered by (floor, seq) — the replay order. */
export const listOps = (_profileId: string, chatId: string): TableOp[] =>
  getDb()
    .prepare('SELECT floor, seq, sql FROM table_ops WHERE chat_id = ? ORDER BY floor, seq')
    .all(chatId) as TableOp[]

/** Drop every op at/after `fromFloor` (rewind cut). Returns the number of rows deleted. */
export const deleteOpsFrom = (_profileId: string, chatId: string, fromFloor: number): number =>
  getDb()
    .prepare('DELETE FROM table_ops WHERE chat_id = ? AND floor >= ?')
    .run(chatId, fromFloor).changes

/** Drop the chat's entire op log (template (re)assignment — stale ops must never replay). */
export const deleteAllOps = (_profileId: string, chatId: string): void => {
  getDb().prepare('DELETE FROM table_ops WHERE chat_id = ?').run(chatId)
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
