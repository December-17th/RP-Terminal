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
  /**
   * SQLite `rowid` of each row, aligned 1:1 to `rows` (issue 06). The edit path (`tableEditService`)
   * targets a row by its rowid — stable within a sandbox and REPLAY-DETERMINISTIC here: instantiate
   * + ordered op replay re-assigns the same rowids (SQLite max+1, single writer, ordered ops), so a
   * rowid the view captured survives a rewind rebuild. Empty when there is no sandbox / on read error.
   */
  rowids: number[]
}

// ---- pure helpers (unit-tested) --------------------------------------------------------------

/**
 * Which column labels the view shows for a table (issue 06 — the "display-header unification" the
 * 02 review flagged). When the template's DISPLAY headers line up 1:1 with the sandbox's real column
 * count, show the headers (e.g. 人物名称) for BOTH empty and populated tables; otherwise fall back to
 * the sandbox column names (`sqlCols`). Pure so every `TableRead` consumer inherits the same choice.
 */
export const unifyDisplayColumns = (headers: string[], sqlCols: string[]): string[] =>
  headers.length && headers.length === sqlCols.length ? headers : sqlCols.length ? sqlCols : headers

/** The sandbox (table-memory) DB file path for a chat. Lives in the chat's per-session store folder
 *  (`profiles/<id>/chats/<chatId>/table.sqlite`) alongside session.sqlite/notes.md — one folder = one
 *  save (decentralize-save-system §B1). Migrated from the legacy `table-dbs/<chatId>.sqlite` in §B5. */
export const sandboxDbPath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chats', chatId, 'table.sqlite')

/**
 * The SHADOW sandbox path for a chat's in-flight refill (table-refill WS2): a sibling temp file next to
 * the live sandbox. The refill builds "state as of fromFloor-1 for selected tables" here, regenerates
 * into it, and PUBLISHES it over the live file per committed chunk — the live sandbox is never mutated
 * in place mid-refill. A distinct suffix so it can't collide with a real `${chatId}.sqlite`.
 */
export const refillShadowPath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chats', chatId, 'table.refill.sqlite')

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
 * Positional INSERT for a table's initial rows: `INSERT INTO "t" VALUES (?, …)` with one
 * placeholder per header column. chatSheets rows are POSITIONAL — `content[0]` headers are
 * DISPLAY names (e.g. 人物名称), NOT the DDL's column names, so a name-based insert would misbind
 * or drop columns wholesale. The row width must therefore match the DDL's column count, which
 * holds for well-formed templates (the header row mirrors the DDL, `row_id` included); a mismatch
 * surfaces as a SQLite error at instantiation. Short rows are padded with NULL, long rows
 * truncated. An empty string in the first position is bound as NULL when that slot follows the
 * `row_id` convention, letting INTEGER PRIMARY KEY auto-assign (other cells keep '' as-is —
 * NOT NULL TEXT columns accept '' but reject NULL). Returns null when there are no rows.
 */
export const buildInitialInsert = (table: TableDef): { sql: string; rows: unknown[][] } | null => {
  if (!table.initialRows.length || !table.headers.length) return null
  if (!isSafeSqlIdentifier(table.sqlName)) return null
  const width = table.headers.length
  const placeholders = new Array(width).fill('?').join(', ')
  const sql = `INSERT INTO "${table.sqlName}" VALUES (${placeholders})`
  const rowIdFirst = table.headers[0] === 'row_id'
  const rows = table.initialRows.map((row) =>
    Array.from({ length: width }, (_, i) => {
      const v = i < row.length ? row[i] : null
      return rowIdFirst && i === 0 && v === '' ? null : v
    })
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
  instantiateAt(sandboxDbPath(profileId, chatId), template, chatId)
}

/**
 * Instantiate a sandbox at an ARBITRARY file path (table-refill WS2): the same DDL + initial-row seed as
 * `instantiate`, parameterized so the refill engine can build its temp SHADOW file at `refillShadowPath`
 * without touching the live sandbox. `label` is only for the log line.
 */
export const instantiateAt = (file: string, template: TableTemplate, label = ''): void => {
  const plan = buildDdlPlan(template) // throws before we touch the filesystem if the template is bad
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
  log('info', `Instantiated table sandbox at ${label || file} (${plan.length} tables)`)
}

/** Read every table of the assigned template (read-only view). Missing sandbox → empty rows. */
export const readAllTables = (
  profileId: string,
  chatId: string,
  template: TableTemplate
): TableRead[] => readAllTablesAt(sandboxDbPath(profileId, chatId), template)

/**
 * Read every table of `template` from the sandbox at an ARBITRARY `file` (table-refill WS2): the refill
 * maintainer renders its tables block from the SHADOW file, not the live one, so the read path is
 * parameterized. A missing file → all-empty rows (same as the live reader).
 */
export const readAllTablesAt = (file: string, template: TableTemplate): TableRead[] => {
  const exists = fs.existsSync(file)
  const db = exists ? new Database(file, { readonly: true }) : null
  try {
    return template.tables.map((t) => readOne(db, t))
  } finally {
    db?.close()
  }
}

/**
 * Read one table by name, guarded against the template registry. Selects `rowid AS __rid, *` so each
 * data row carries its SQLite rowid (issue 06 edit identity); the `__rid` column is sliced off the
 * front of every row (and out of `columns`), so `rows`/`columns` stay data-only and POSITIONAL — no
 * downstream consumer (tableExportService, table.read/query) changes. Columns are unified onto the
 * template's DISPLAY headers when their width matches the sandbox's (`unifyDisplayColumns`).
 */
const readOne = (db: Database.Database | null, table: TableDef): TableRead => {
  const base: TableRead = {
    sqlName: table.sqlName,
    displayName: table.displayName,
    columns: table.headers,
    rows: [],
    rowids: []
  }
  // Guard: never interpolate a name that isn't a safe identifier from the template.
  if (!db || !isSafeSqlIdentifier(table.sqlName)) return base
  try {
    // `rowid AS __rid` is the FIRST result column; for tables with `row_id INTEGER PRIMARY KEY` it
    // aliases that key (harmless — we slice it away). `*` then yields the real data columns.
    const stmt = db.prepare(`SELECT rowid AS __rid, * FROM "${table.sqlName}"`)
    const allCols = (stmt.columns?.() ?? []).map((c: { name: string }) => c.name)
    const sqlCols = allCols.slice(1) // drop the __rid column
    const raw = (stmt.raw?.().all() as unknown[][]) ?? []
    const rowids = raw.map((r) => Number(r[0]))
    const rows = raw.map((r) => r.slice(1))
    return { ...base, columns: unifyDisplayColumns(table.headers, sqlCols), rows, rowids }
  } catch (error) {
    log('info', `Failed to read table "${table.sqlName}" for chat:`, error)
    return base
  }
}

/**
 * The REAL sandbox column names for a table, in DDL order (issue 06 edit path). The Tables view sends
 * only a column INDEX; the IPC layer maps it to the real column name through THIS list — never a
 * column-name string the renderer supplied — then hands the resolved name to `tableEditService`,
 * which re-validates it with `isSafeSqlIdentifier`. `sqlName` must be a registered template table
 * (the caller validates against the registry); a missing sandbox / read failure yields `[]`.
 */
export const sandboxColumns = (profileId: string, chatId: string, sqlName: string): string[] => {
  if (!isSafeSqlIdentifier(sqlName)) return []
  const file = sandboxDbPath(profileId, chatId)
  if (!fs.existsSync(file)) return []
  const db = new Database(file, { readonly: true })
  try {
    const stmt = db.prepare(`SELECT * FROM "${sqlName}" LIMIT 0`)
    return (stmt.columns?.() ?? []).map((c: { name: string }) => c.name)
  } catch (error) {
    log('info', `Failed to read columns for table "${sqlName}":`, error)
    return []
  } finally {
    db.close()
  }
}

/** Remove a sandbox DB file + its WAL sidecars (idempotent, best-effort). */
const removeDbFile = (file: string): void => {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  for (const ext of ['-wal', '-shm']) {
    const side = `${file}${ext}`
    if (fs.existsSync(side)) fs.rmSync(side, { force: true })
  }
}

/** Close/remove the sandbox DB file for a chat (unassign / chat deletion). Idempotent. */
export const removeSandbox = (profileId: string, chatId: string): void => {
  try {
    removeDbFile(sandboxDbPath(profileId, chatId))
  } catch (error) {
    log('info', `Failed to remove table sandbox for chat ${chatId}:`, error)
  }
}

/** Remove a chat's refill SHADOW file + sidecars (idempotent). Called on refill finalize/abort/discard,
 *  and defensively before a shadow build to clear a stale temp from a crashed run. */
export const removeShadow = (profileId: string, chatId: string): void => {
  try {
    removeDbFile(refillShadowPath(profileId, chatId))
  } catch (error) {
    log('info', `Failed to remove refill shadow for chat ${chatId}:`, error)
  }
}

/**
 * PUBLISH a refill chunk (table-refill WS2 §0b-1): snapshot the SHADOW sandbox over the chat's LIVE
 * sandbox file so the committed live state is BYTE-IDENTICAL to what the model validated. NOT
 * `rebuildSandbox` — that self-claims the write guard the refill already holds and would silently skip.
 * Checkpoints the shadow's WAL into its main file (so a plain file copy is a consistent snapshot), then
 * replaces the live file + clears the live WAL sidecars. Throws on failure so the caller can fall back
 * to an unguarded op-log rebuild. The shadow file is left intact for the next chunk.
 */
export const publishShadow = (profileId: string, chatId: string): void => {
  const shadow = refillShadowPath(profileId, chatId)
  const live = sandboxDbPath(profileId, chatId)
  if (!fs.existsSync(shadow)) throw new Error('refill shadow file missing')
  // Fold the shadow WAL into its main file so copying just the .sqlite is a consistent snapshot.
  const db = new Database(shadow)
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  ensureDir(path.dirname(live))
  // Clear the live sidecars first (a stale live -wal would otherwise shadow the freshly copied file).
  for (const ext of ['-wal', '-shm']) {
    const side = `${live}${ext}`
    if (fs.existsSync(side)) fs.rmSync(side, { force: true })
  }
  fs.copyFileSync(shadow, live)
}
