import { TableTemplate } from '../types/tableTemplate'
import { isSafeSqlIdentifier } from '../parsers/chatSheetsParser'
import { applySqlBatch, TableSqlError } from './tableSql'
import { appendOps, tryBeginTableWrite, endTableWrite } from './tableOpsService'
import { getAllFloors } from './floorService'

/**
 * HAND-EDIT write path for SQL-table memory (issue 06).
 *
 * A manual edit from the Tables view (cell edit / add row / delete row / reset table) becomes
 * LITERAL, replayable SQL routed through the EXACT SAME path AI writes take: pure builders here →
 * the per-chat write lock (`tryBeginTableWrite`) → `applySqlBatch` (validate + execute in one
 * transaction against the chat's sandbox) → `appendOps` at the just-persisted floor
 * (`getAllFloors().length - 1`, clamped ≥0). There is NO second write path and NO unlogged write —
 * a hand edit is indistinguishable from an AI write in the op log, so it survives turns and rolls
 * back on a swipe past its floor exactly like an AI write.
 *
 * SECURITY: the edited COLUMN is never trusted from the renderer. The renderer sends only the column
 * INDEX; the IPC layer maps that index → the real column name off the sandbox's column list and
 * passes the resolved name here, where `buildCellUpdate` re-validates it with `isSafeSqlIdentifier`.
 * The target row is addressed by SQLite `rowid` (replay-deterministic — see `tableDbService`), which
 * must be a safe integer. Constraint violations (CHECK / NOT NULL) surface as an `{ error }` result
 * (SQLite's message) for a renderer toast — never a crash.
 *
 * The pure builders below are exported + unit-tested; `applyEdit` is a thin runtime wrapper (its DB
 * work is no-op under the vitest better-sqlite3 alias mock — same stance as `tableSql`/`tableOps`).
 */

/** Single-quote a SQL string literal, doubling embedded `'` (`o'clock` → `'o''clock'`). */
export const sqlQuote = (v: string): string => `'${v.replace(/'/g, "''")}'`

/** A rowid we will interpolate must be a plain non-negative safe integer (no injection surface). */
const isSafeRowid = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * `UPDATE "t" SET "col" = '<quoted>' WHERE rowid = N`. `sqlColumn` is the REAL sandbox column name
 * (resolved in the IPC layer from the display index) and is re-validated here; `rowid` must be a
 * safe integer. Throws `TableSqlError` on an unsafe table/column/rowid — the value is quoted, so it
 * cannot break out.
 */
export const buildCellUpdate = (
  sqlName: string,
  sqlColumn: string,
  rowid: number,
  value: string
): string => {
  if (!isSafeSqlIdentifier(sqlName)) throw new TableSqlError(`Unsafe table identifier "${sqlName}"`)
  if (!isSafeSqlIdentifier(sqlColumn))
    throw new TableSqlError(`Unsafe column identifier "${sqlColumn}"`)
  if (!isSafeRowid(rowid)) throw new TableSqlError(`Unsafe rowid "${String(rowid)}"`)
  return `UPDATE "${sqlName}" SET "${sqlColumn}" = ${sqlQuote(value)} WHERE rowid = ${rowid}`
}

/**
 * Positional `INSERT INTO "t" VALUES (…)` — one literal per cell, in DDL column order (the
 * `buildInitialInsert` convention). `null` cells become the `NULL` keyword (the empty `row_id` slot,
 * so INTEGER PRIMARY KEY auto-assigns); non-null cells are quoted string literals.
 */
export const buildRowInsert = (sqlName: string, values: (string | null)[]): string => {
  if (!isSafeSqlIdentifier(sqlName)) throw new TableSqlError(`Unsafe table identifier "${sqlName}"`)
  const literals = values.map((v) => (v == null ? 'NULL' : sqlQuote(v)))
  return `INSERT INTO "${sqlName}" VALUES (${literals.join(', ')})`
}

/** `DELETE FROM "t" WHERE rowid = N`. */
export const buildRowDelete = (sqlName: string, rowid: number): string => {
  if (!isSafeSqlIdentifier(sqlName)) throw new TableSqlError(`Unsafe table identifier "${sqlName}"`)
  if (!isSafeRowid(rowid)) throw new TableSqlError(`Unsafe rowid "${String(rowid)}"`)
  return `DELETE FROM "${sqlName}" WHERE rowid = ${rowid}`
}

/**
 * `DELETE FROM "t"` — reset (clear all rows). DELIBERATELY op-logged (not a separate "clear the log"
 * action, per the issue AC): replay stays consistent because instantiate re-seeds the initial rows
 * and the replayed DELETE clears them again, so a chat rebuilt at any later floor matches the live
 * state. Confirmed in the UI before it reaches here.
 */
export const buildTableReset = (sqlName: string): string => {
  if (!isSafeSqlIdentifier(sqlName)) throw new TableSqlError(`Unsafe table identifier "${sqlName}"`)
  return `DELETE FROM "${sqlName}"`
}

/** One hand edit from the Tables view. `column`/`value`/`rowid`/`values` are used per `kind`. */
export interface TableEditOp {
  kind: 'cell' | 'insert' | 'delete' | 'reset'
  table: string
  /** cell: target rowid; delete: target rowid. */
  rowid?: number
  /** cell: the RESOLVED sandbox column name (mapped from a display index in the IPC layer). */
  column?: string
  /** cell: the new cell value. */
  value?: string
  /** insert: one entry per column in DDL order (null = the empty row_id slot → NULL). */
  values?: (string | null)[]
}

export type TableEditResult = { ok: true; changes: number } | { error: string }

/** Build the single SQL statement for a hand edit (pure — throws `TableSqlError` on a bad op). */
export const buildEditSql = (op: TableEditOp): string => {
  switch (op.kind) {
    case 'cell':
      if (op.column == null || op.rowid == null)
        throw new TableSqlError('cell edit requires a column and a rowid')
      return buildCellUpdate(op.table, op.column, op.rowid, op.value ?? '')
    case 'insert':
      return buildRowInsert(op.table, op.values ?? [])
    case 'delete':
      if (op.rowid == null) throw new TableSqlError('row delete requires a rowid')
      return buildRowDelete(op.table, op.rowid)
    case 'reset':
      return buildTableReset(op.table)
  }
}

/**
 * Apply ONE hand edit: build the SQL, take the per-chat write lock (busy → error result), run it
 * through `applySqlBatch` (validated + executed against the sandbox), then log it to the floor-keyed
 * op log at `getAllFloors().length - 1` (clamped ≥0) — the SAME attribution AI writes get. Returns
 * `{ ok, changes }` on success or `{ error }` (SQLite / validation message) for a renderer toast;
 * never throws across the IPC boundary.
 */
export const applyEdit = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  op: TableEditOp
): TableEditResult => {
  let sql: string
  try {
    sql = buildEditSql(op)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  if (!tryBeginTableWrite(chatId)) {
    return { error: 'A table write is already in flight for this chat' }
  }
  try {
    const result = applySqlBatch(profileId, chatId, template, sql)
    if (result.statements.length) {
      const floor = Math.max(0, getAllFloors(profileId, chatId).length - 1)
      appendOps(profileId, chatId, floor, result.statements, 'edit')
    }
    return { ok: true, changes: result.changes }
  } catch (error) {
    const msg = error instanceof TableSqlError ? error.message : String(error)
    return { error: msg }
  } finally {
    endTableWrite(chatId)
  }
}
