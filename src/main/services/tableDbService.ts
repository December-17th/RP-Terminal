import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { getAppDir, ensureDir } from './storageService'
import { log } from './logService'
import { TableTemplate, TableDef } from '../types/tableTemplate'
import { extractCreateTableName, isSafeSqlIdentifier } from '../parsers/chatSheetsParser'

/**
 * Per-chat SANDBOX SQLite for SQL-table memory (issue 02).
 *
 * A chat's table data lives in its OWN database file — `profiles/<id>/table-dbs/<chatId>.sqlite`,
 * NEVER the app DB (`rpterminal.db`). Assigning a template instantiates that file by executing each
 * table's validated `CREATE TABLE` DDL; that init is the ONLY moment any DDL runs. At runtime we
 * only ever `SELECT`/insert against `sqlName`s that appear in the assigned template's registry —
 * never an interpolated, unvalidated name (issues 03+ add the write path; this slice is read-only
 * plus instantiation).
 *
 * The SQL wrappers here are runtime-validated only: vitest stubs better-sqlite3 to a no-op
 * (test/mocks/better-sqlite3.ts), so `new Database()` does nothing under test. The PURE helpers
 * (path building, DDL/registry checks, row shaping) are unit-tested; the wrappers are not — same
 * stance as floorService. See docs/sdk/table-templates.md.
 */

export interface TableRead {
  sqlName: string
  displayName: string
  columns: string[]
  rows: unknown[][]
}

// ---- pure helpers (unit-tested) --------------------------------------------------------------

/** The sandbox DB file path for a chat. Kept in its own `table-dbs/` dir, apart from the app DB. */
export const sandboxDbPath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'table-dbs', `${chatId}.sqlite`)

/**
 * Build the ordered, validated instantiation plan from a template: for each table, its sqlName
 * (re-extracted from the DDL and cross-checked against the stored `sqlName`) plus the DDL to run.
 * Throws if a table's DDL is not a single CREATE TABLE, or its parsed name disagrees with the
 * stored `sqlName` (defense in depth — the name we execute must be the name we'll later query).
 */
export const buildDdlPlan = (template: TableTemplate): Array<{ sqlName: string; ddl: string }> =>
  template.tables.map((t) => {
    const parsed = extractCreateTableName(t.ddl) // re-validates single-CREATE at instantiation
    if (parsed !== t.sqlName) {
      throw new Error(
        `Template table "${t.displayName}" DDL name "${parsed}" != registered sqlName "${t.sqlName}"`
      )
    }
    if (!isSafeSqlIdentifier(t.sqlName)) {
      throw new Error(`Unsafe table name in template: "${t.sqlName}"`)
    }
    return { sqlName: t.sqlName, ddl: t.ddl }
  })

/** The set of table names a template legitimately owns (the interpolation allowlist). */
export const templateSqlNames = (template: TableTemplate): Set<string> =>
  new Set(template.tables.map((t) => t.sqlName))

/**
 * Positional INSERT for a table's initial rows. Returns the parameterized SQL and the row arrays to
 * bind, using only header column names (which come from the template, never user SQL). Rows longer
 * than the header are truncated; shorter rows are left-aligned and the rest bound as NULL.
 * Returns null when there are no initial rows to insert.
 */
export const buildInitialInsert = (table: TableDef): { sql: string; rows: unknown[][] } | null => {
  if (!table.initialRows.length || !table.headers.length) return null
  if (!isSafeSqlIdentifier(table.sqlName)) return null
  // Keep the ORIGINAL header index of each safe column so row values stay aligned to their column
  // even when an unsafe header name is dropped from the middle.
  const cols = table.headers.map((h, idx) => ({ h, idx })).filter(({ h }) => isSafeSqlIdentifier(h))
  if (cols.length === 0) return null
  const placeholders = cols.map(() => '?').join(', ')
  const colList = cols.map(({ h }) => `"${h}"`).join(', ')
  const sql = `INSERT INTO "${table.sqlName}" (${colList}) VALUES (${placeholders})`
  const rows = table.initialRows.map((row) =>
    cols.map(({ idx }) => (idx < row.length ? row[idx] : null))
  )
  return { sql, rows }
}

// ---- SQL wrappers (runtime-validated only; no-op under the vitest mock) -----------------------

/**
 * (Re)create the sandbox DB for a chat from a template: delete any existing file, then execute each
 * validated DDL and seed initial rows in one transaction. Destructive — the caller (chat template
 * (re)assignment) confirms first. Silent-safe: a template with no tables just yields an empty DB.
 */
export const instantiate = (profileId: string, chatId: string, template: TableTemplate): void => {
  const plan = buildDdlPlan(template) // throws before we touch the filesystem if the template is bad
  const file = sandboxDbPath(profileId, chatId)
  ensureDir(path.dirname(file))
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })

  const db = new Database(file)
  try {
    db.pragma('journal_mode = WAL')
    const seedByName = new Map(template.tables.map((t) => [t.sqlName, t]))
    db.transaction(() => {
      for (const { sqlName, ddl } of plan) {
        db.exec(ddl)
        const table = seedByName.get(sqlName)
        const insert = table ? buildInitialInsert(table) : null
        if (insert) {
          const stmt = db.prepare(insert.sql)
          for (const row of insert.rows) stmt.run(...row)
        }
      }
    })()
  } finally {
    db.close()
  }
  log('info', `Instantiated table sandbox for chat ${chatId} (${plan.length} tables)`)
}

/** Read every table of the assigned template (read-only view). Missing sandbox → empty rows. */
export const readAllTables = (
  profileId: string,
  chatId: string,
  template: TableTemplate
): TableRead[] => {
  const file = sandboxDbPath(profileId, chatId)
  const exists = fs.existsSync(file)
  const db = exists ? new Database(file, { readonly: true }) : null
  try {
    return template.tables.map((t) => readOne(db, t))
  } finally {
    db?.close()
  }
}

/** Read one table by name, guarded against the template registry. */
const readOne = (db: Database.Database | null, table: TableDef): TableRead => {
  const base: TableRead = {
    sqlName: table.sqlName,
    displayName: table.displayName,
    columns: table.headers,
    rows: []
  }
  // Guard: never interpolate a name that isn't a safe identifier from the template.
  if (!db || !isSafeSqlIdentifier(table.sqlName)) return base
  try {
    const stmt = db.prepare(`SELECT * FROM "${table.sqlName}"`)
    const cols = (stmt.columns?.() ?? []).map((c: { name: string }) => c.name)
    const rows = (stmt.raw?.().all() as unknown[][]) ?? []
    return { ...base, columns: cols.length ? cols : table.headers, rows }
  } catch (error) {
    log('info', `Failed to read table "${table.sqlName}" for chat:`, error)
    return base
  }
}

/** Close/remove the sandbox DB file for a chat (unassign / chat deletion). Idempotent. */
export const removeSandbox = (profileId: string, chatId: string): void => {
  const file = sandboxDbPath(profileId, chatId)
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    // WAL sidecar files.
    for (const ext of ['-wal', '-shm']) {
      const side = `${file}${ext}`
      if (fs.existsSync(side)) fs.rmSync(side, { force: true })
    }
  } catch (error) {
    log('info', `Failed to remove table sandbox for chat ${chatId}:`, error)
  }
}
