import fs from 'fs'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { log } from './logService'
import {
  TableTemplate,
  TableDef,
  TableExportConfigSchema
} from '../types/tableTemplate'
import { getTableTemplateById, saveTableTemplate } from './tableTemplateService'
import { sandboxDbPath, instantiate } from './tableDbService'
import { deleteAllOps, appendOps } from './tableOpsService'
import { getDb } from './db'
import { listChatIdsForTableTemplate } from './chatService'
import { isSafeSqlIdentifier, parseDdlColumnNames } from '../parsers/chatSheetsParser'

/**
 * STRUCTURAL editing of a table template + safe migration of every bound chat (Memory-Manager WP4a).
 *
 * The non-structural template surface (`applyTemplatePatch`/`updateTableTemplate`) can NEVER touch a
 * table's `ddl`/`sqlName`/`headers`/`initialRows` — DDL only executes at sandbox instantiation, so a
 * naive edit would desync every chat. This module is the ONLY path that rewrites those fields, and it
 * keeps the op-log/rewind invariant intact with a STRICT ordering so a mid-way failure can't leave a
 * half-migrated chat:
 *   1. validate the whole batch of high-level ops against the current template (reject → no-op),
 *   2. derive the NEW canonical DDL from a THROWAWAY in-memory DB (apply `ALTER/CREATE/DROP`, read
 *      back `sqlite_master`) — NO real sandbox is touched, so a derivation failure leaves everything
 *      (template + all sandboxes) untouched,
 *   3. `saveTableTemplate` ONCE (only after derivation succeeds), then
 *   4. migrate each bound chat one at a time — apply the SAME `ALTER/CREATE/DROP` to its live sandbox
 *      in an OPEN transaction, read the migrated rows on that same handle, RE-BASELINE its op log
 *      (drop it + append a floor-0 `DELETE FROM t` + one `INSERT` per row) ATOMICALLY, and only THEN
 *      commit the sandbox. On any failure the sandbox rolls back to the OLD schema + OLD op-log (the
 *      chat is recoverable, reported in `failedChats`), while the template + other chats stay migrated.
 *      The baseline reproduces the migrated rows when replayed on `instantiate(newDDL + initialRows)`,
 *      so a later `rebuildSandbox`/rewind reconstructs the migrated state instead of losing it.
 *
 * The raw `ALTER/CREATE/DROP` runs on the migration's OWN db handle, bypassing the LLM write-path
 * guard (`tableSql.classifyStatement` rejects ALTER) — intended: this is trusted, in-process schema
 * evolution, not model-emitted SQL. The re-baseline ops themselves are ordinary INSERT/DELETE that
 * pass `validateBatch`, so replay accepts them.
 */

// ---- op contract (shared main-side type; the IPC layer + preload mirror this shape) ----------

export type StructureOp =
  | { kind: 'addTable'; sqlName: string; displayName?: string; columns: { name: string; type?: string }[] }
  | { kind: 'dropTable'; uid: string }
  | { kind: 'renameTable'; uid: string; sqlName: string; displayName?: string }
  | { kind: 'addColumn'; uid: string; name: string; type?: string }
  | { kind: 'renameColumn'; uid: string; from: string; to: string }
  | { kind: 'dropColumn'; uid: string; name: string }

export interface StructureReport {
  ok: true
  /** Count of table-level ops (addTable / dropTable / renameTable). */
  tablesChanged: number
  /** Count of column-level ops (addColumn / renameColumn / dropColumn). */
  columnsChanged: number
  /** Number of bound chats whose sandbox + op log were migrated. */
  chatsMigrated: number
  /**
   * Chats whose migration FAILED and was rolled back — each is left on the PREVIOUS schema + its
   * OLD op-log (internally consistent, recoverable), NOT half-migrated. The template + every other
   * chat still migrated. WP4b surfaces these so the user can re-sync/retry that chat.
   */
  failedChats: { chatId: string; reason: string }[]
  /** Non-fatal advisories (e.g. a node prompt still names a renamed/dropped column). */
  warnings: string[]
}
export interface StructureError {
  ok: false
  /** A localizable `tables.structure*` key (WP4b localizes/toasts it). */
  error: string
}

// ---- SQL literal / identifier helpers --------------------------------------------------------

/** Quote an identifier for interpolation (`"` doubled). Names are pre-validated safe, so this is
 *  belt-and-suspenders. */
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** A conservative SQL column type: a word (optionally with a `(n)` / `(n,m)` size). Default TEXT. */
const isSafeSqlType = (type: string): boolean =>
  /^[A-Za-z][A-Za-z0-9 ]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?$/.test(type.trim())

/** Serialize a JS cell value to a SQL literal for a baseline op string (raw SQL, no bound params). */
const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

// ---- validation + plan (PURE; unit-tested) ---------------------------------------------------

interface WorkTable {
  uid: string
  isNew: boolean
  /** The table's ORIGINAL sqlName (existing tables only) — used to locate its old TableDef. */
  origSqlName?: string
  sqlName: string
  displayName: string
  /** Current column names in DDL order. */
  columns: string[]
  /** current column name → the OLD column name it came from (null = column added by this batch). */
  originOf: Map<string, string | null>
  dropped: boolean
  /** New-table column defs (name + resolved type) — used to emit its CREATE. */
  newColumnDefs?: { name: string; type: string }[]
}

export interface StructurePlan {
  ok: true
  /** Ordered `CREATE/DROP/ALTER` statements to run against a sandbox. */
  statements: string[]
  byUid: Map<string, WorkTable>
  /** New tables in add order (appended to the template after surviving tables). */
  newTables: WorkTable[]
  tablesChanged: number
  columnsChanged: number
}

const err = (error: string): StructureError => ({ ok: false, error })

/**
 * PURE: validate the op batch against `template` and produce the ordered SQL + a per-table plan.
 * Reject the WHOLE batch on the first invalid op (return `{ ok:false, error }`) — nothing is applied.
 * Tables are addressed by `uid`; `addTable` mints a new uid. Statement target names track renames so
 * an `addColumn` after a `renameTable` on the same uid targets the new name.
 */
export const planStructureOps = (
  template: TableTemplate,
  ops: StructureOp[]
): StructurePlan | StructureError => {
  const byUid = new Map<string, WorkTable>()
  for (const t of template.tables) {
    const cols = parseDdlColumnNames(t.ddl)
    byUid.set(t.uid, {
      uid: t.uid,
      isNew: false,
      origSqlName: t.sqlName,
      sqlName: t.sqlName,
      displayName: t.displayName,
      columns: [...cols],
      originOf: new Map(cols.map((c) => [c, c])),
      dropped: false
    })
  }
  const newTables: WorkTable[] = []
  const statements: string[] = []
  let tablesChanged = 0
  let columnsChanged = 0

  const activeSqlNames = (exclude?: WorkTable): Set<string> =>
    new Set(
      [...byUid.values()].filter((w) => !w.dropped && w !== exclude).map((w) => w.sqlName)
    )

  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof (op as { kind?: unknown }).kind !== 'string') {
      return err('tables.structureBadOp')
    }
    switch (op.kind) {
      case 'addTable': {
        if (!isSafeSqlIdentifier(op.sqlName)) return err('tables.structureBadName')
        if (activeSqlNames().has(op.sqlName)) return err('tables.structureTableExists')
        if (!Array.isArray(op.columns) || op.columns.length === 0) {
          return err('tables.structureNoColumns')
        }
        const seen = new Set<string>()
        const colDefs: { name: string; type: string }[] = []
        for (const c of op.columns) {
          if (!c || !isSafeSqlIdentifier(c.name)) return err('tables.structureBadName')
          if (seen.has(c.name)) return err('tables.structureColumnExists')
          seen.add(c.name)
          const type = c.type && c.type.trim() ? c.type.trim() : 'TEXT'
          if (!isSafeSqlType(type)) return err('tables.structureBadType')
          colDefs.push({ name: c.name, type })
        }
        const uid = randomUUID()
        const work: WorkTable = {
          uid,
          isNew: true,
          sqlName: op.sqlName,
          displayName: op.displayName || op.sqlName,
          columns: colDefs.map((c) => c.name),
          originOf: new Map(colDefs.map((c) => [c.name, null])),
          dropped: false,
          newColumnDefs: colDefs
        }
        byUid.set(uid, work)
        newTables.push(work)
        statements.push(
          `CREATE TABLE ${q(op.sqlName)} (${colDefs.map((c) => `${q(c.name)} ${c.type}`).join(', ')})`
        )
        tablesChanged++
        break
      }
      case 'dropTable': {
        const w = byUid.get(op.uid)
        if (!w || w.dropped) return err('tables.structureUnknownTable')
        statements.push(`DROP TABLE ${q(w.sqlName)}`)
        w.dropped = true
        tablesChanged++
        break
      }
      case 'renameTable': {
        const w = byUid.get(op.uid)
        if (!w || w.dropped) return err('tables.structureUnknownTable')
        if (!isSafeSqlIdentifier(op.sqlName)) return err('tables.structureBadName')
        if (activeSqlNames(w).has(op.sqlName)) return err('tables.structureTableExists')
        if (op.sqlName !== w.sqlName) {
          statements.push(`ALTER TABLE ${q(w.sqlName)} RENAME TO ${q(op.sqlName)}`)
          w.sqlName = op.sqlName
        }
        if (op.displayName !== undefined) w.displayName = op.displayName
        tablesChanged++
        break
      }
      case 'addColumn': {
        const w = byUid.get(op.uid)
        if (!w || w.dropped) return err('tables.structureUnknownTable')
        if (!isSafeSqlIdentifier(op.name)) return err('tables.structureBadName')
        if (w.columns.includes(op.name)) return err('tables.structureColumnExists')
        const type = op.type && op.type.trim() ? op.type.trim() : 'TEXT'
        if (!isSafeSqlType(type)) return err('tables.structureBadType')
        statements.push(`ALTER TABLE ${q(w.sqlName)} ADD COLUMN ${q(op.name)} ${type}`)
        w.columns.push(op.name)
        w.originOf.set(op.name, null)
        columnsChanged++
        break
      }
      case 'renameColumn': {
        const w = byUid.get(op.uid)
        if (!w || w.dropped) return err('tables.structureUnknownTable')
        if (!w.columns.includes(op.from)) return err('tables.structureUnknownColumn')
        if (!isSafeSqlIdentifier(op.to)) return err('tables.structureBadName')
        if (op.to !== op.from && w.columns.includes(op.to)) return err('tables.structureColumnExists')
        if (op.to !== op.from) {
          statements.push(`ALTER TABLE ${q(w.sqlName)} RENAME COLUMN ${q(op.from)} TO ${q(op.to)}`)
          const origin = w.originOf.get(op.from) ?? null
          w.originOf.delete(op.from)
          w.originOf.set(op.to, origin)
          w.columns = w.columns.map((c) => (c === op.from ? op.to : c))
        }
        columnsChanged++
        break
      }
      case 'dropColumn': {
        const w = byUid.get(op.uid)
        if (!w || w.dropped) return err('tables.structureUnknownTable')
        if (!w.columns.includes(op.name)) return err('tables.structureUnknownColumn')
        if (w.columns.length <= 1) return err('tables.structureLastColumn')
        statements.push(`ALTER TABLE ${q(w.sqlName)} DROP COLUMN ${q(op.name)}`)
        w.columns = w.columns.filter((c) => c !== op.name)
        w.originOf.delete(op.name)
        columnsChanged++
        break
      }
      default:
        return err('tables.structureBadOp')
    }
  }

  return { ok: true, statements, byUid, newTables, tablesChanged, columnsChanged }
}

// ---- template derivation (PURE given the new DDL) --------------------------------------------

/** Remap one surviving table's non-DDL fields onto the new column layout. Returns the def + warnings. */
const remapExistingTable = (
  oldDef: TableDef,
  work: WorkTable,
  newDdl: string
): { def: TableDef; warnings: string[] } => {
  const warnings: string[] = []
  const oldCols = parseDdlColumnNames(oldDef.ddl)
  const finalCols = parseDdlColumnNames(newDdl) // authoritative order from SQLite

  // old column name → its display header (only when headers line up 1:1 with the old DDL columns).
  const oldHeaderByCol = new Map<string, string>()
  if (oldDef.headers.length === oldCols.length) {
    oldCols.forEach((c, i) => oldHeaderByCol.set(c, oldDef.headers[i]))
  }
  // old column name → its surviving new name (absent = dropped). Identity for untouched columns.
  const colRename = new Map<string, string>()
  for (const c of finalCols) {
    const origin = work.originOf.get(c) ?? null
    if (origin) colRename.set(origin, c)
  }
  /** Map a token that MIGHT be an old column: renamed→new, dropped→undefined, non-column→unchanged. */
  const mapCol = (token: string): string | undefined =>
    oldCols.includes(token) ? colRename.get(token) : token

  const headers = finalCols.map((c) => {
    const origin = work.originOf.get(c) ?? null
    return origin ? (oldHeaderByCol.get(origin) ?? c) : c
  })

  const droppedCols = oldCols.filter((oc) => !colRename.has(oc))
  let droppedValues = 0
  const initialRows = oldDef.initialRows.map((row) => {
    for (const dc of droppedCols) {
      const i = oldCols.indexOf(dc)
      if (i >= 0 && i < row.length && row[i] !== '') droppedValues++
    }
    return finalCols.map((c) => {
      const origin = work.originOf.get(c) ?? null
      if (!origin) return '' // added column
      const oi = oldCols.indexOf(origin)
      return oi >= 0 && oi < row.length ? row[oi] : ''
    })
  })
  if (droppedValues > 0) {
    warnings.push(`Table "${work.sqlName}": ${droppedValues} initialRows value(s) dropped`)
  }

  // exportConfig column references (all store COLUMN-NAME strings) remapped by the rename map.
  const ec = oldDef.exportConfig
  const keywords = ec.keywords
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(mapCol)
    .filter((x): x is string => !!x)
    .join(',')
  const extraIndexColumns = ec.extraIndexColumns
    .map(mapCol)
    .filter((x): x is string => !!x)
  const extraIndexColumnModes: Record<string, 'both' | 'index_only'> = {}
  for (const [col, mode] of Object.entries(ec.extraIndexColumnModes)) {
    const mapped = mapCol(col)
    if (mapped) extraIndexColumnModes[mapped] = mode
  }
  const exportConfig = TableExportConfigSchema.parse({
    ...ec,
    keywords,
    extraIndexColumns,
    extraIndexColumnModes
  })

  // Freeform node prose is NOT auto-rewritten — just flag references to renamed / dropped columns.
  const changedOldCols = [
    ...oldCols.filter((oc) => colRename.get(oc) && colRename.get(oc) !== oc), // renamed
    ...droppedCols // dropped
  ]
  const prose = [oldDef.note, oldDef.initNode, oldDef.insertNode, oldDef.updateNode, oldDef.deleteNode]
    .filter(Boolean)
    .join('\n')
  for (const oc of changedOldCols) {
    if (new RegExp(`\\b${oc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(prose)) {
      warnings.push(`Table "${work.sqlName}": a node prompt still references column "${oc}"`)
    }
  }

  const def: TableDef = {
    ...oldDef,
    sqlName: work.sqlName,
    displayName: work.displayName,
    ddl: newDdl,
    headers,
    initialRows,
    exportConfig
  }
  return { def, warnings }
}

/** Build the new-table TableDef (empty rows, default nodes/exportConfig; headers = column names). */
const buildNewTableDef = (work: WorkTable, newDdl: string): TableDef => ({
  uid: work.uid,
  displayName: work.displayName || work.sqlName,
  sqlName: work.sqlName,
  ddl: newDdl,
  headers: parseDdlColumnNames(newDdl),
  initialRows: [],
  note: '',
  initNode: '',
  insertNode: '',
  updateNode: '',
  deleteNode: '',
  updateFrequency: -1,
  exportConfig: TableExportConfigSchema.parse({})
})

// ---- sandbox helpers (runtime wrappers; real SQLite) -----------------------------------------

/**
 * Derive the new canonical DDL on a THROWAWAY DB: seed it with the current tables (`seedDdls`), apply
 * the structural statements, then read each final table's `CREATE TABLE` back from `sqlite_master`.
 * Always called with `:memory:` so NO real sandbox is touched during derivation/validation. Throws
 * (rolled back) if any statement fails — the caller maps that to `structureDeriveFailed`.
 */
const migrateAndDeriveDdl = (
  file: string,
  statements: string[],
  finalSqlNames: string[],
  seedDdls?: string[]
): Record<string, string> => {
  const db = new Database(file)
  try {
    return db.transaction(() => {
      if (seedDdls) for (const ddl of seedDdls) db.exec(ddl)
      for (const s of statements) db.exec(s)
      const out: Record<string, string> = {}
      const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      for (const name of finalSqlNames) {
        const row = stmt.get(name) as { sql: string } | undefined
        if (row?.sql) out[name] = row.sql
      }
      return out
    })() as Record<string, string>
  } finally {
    db.close()
  }
}

/** Read one table's rows + rowids on an ALREADY-OPEN handle (so uncommitted `ALTER`s are visible —
 *  `readAllTables` opens a separate connection that can't see an in-flight transaction). */
const readTableOnHandle = (
  db: Database.Database,
  sqlName: string
): { rows: unknown[][]; rowids: number[] } => {
  if (!isSafeSqlIdentifier(sqlName)) return { rows: [], rowids: [] }
  const stmt = db.prepare(`SELECT rowid AS __rid, * FROM ${q(sqlName)}`)
  const raw = (stmt.raw?.().all() as unknown[][]) ?? []
  return { rows: raw.map((r) => r.slice(1)), rowids: raw.map((r) => Number(r[0])) }
}

/**
 * Build the floor-0 re-baseline op set (`DELETE FROM t` + one literal `INSERT` per current row) that
 * reproduces the MIGRATED rows when replayed on `instantiate(new DDL + new initialRows)`. Rows are
 * read on the OPEN migration handle. rowids are reproduced via the `row_id` PK value (the memory
 * convention) or an explicit `rowid` column otherwise.
 */
const buildBaselineOps = (db: Database.Database, newTemplate: TableTemplate): string[] => {
  const baseline: string[] = []
  for (const t of newTemplate.tables) {
    baseline.push(`DELETE FROM ${q(t.sqlName)}`)
    const cols = parseDdlColumnNames(t.ddl)
    if (!cols.length) continue
    const { rows, rowids } = readTableOnHandle(db, t.sqlName)
    const hasRowId = cols.includes('row_id') // the PK alias convention (buildInitialInsert relies on it)
    const colList = (hasRowId ? cols.map(q) : ['rowid', ...cols.map(q)]).join(', ')
    rows.forEach((row, i) => {
      const values = hasRowId ? row : [rowids[i], ...row]
      baseline.push(
        `INSERT INTO ${q(t.sqlName)} (${colList}) VALUES (${values.map(sqlLiteral).join(', ')})`
      )
    })
  }
  return baseline
}

/** Atomically rewrite a chat's op log (one app-DB transaction): drop the old ops, then append the
 *  new floor-0 baseline — so the old ops are NEVER dropped without the new baseline landing. */
const rewriteOpLog = (profileId: string, chatId: string, baseline: string[]): void => {
  getDb().transaction(() => {
    deleteAllOps(profileId, chatId)
    if (baseline.length) appendOps(profileId, chatId, 0, baseline, 'baseline')
  })()
}

/**
 * Migrate ONE bound chat, gating the op-log rewrite on the ALTER succeeding. The sandbox `ALTER`s run
 * in an open transaction; the migrated rows are read on that same (uncommitted) handle to build the
 * baseline; the op log is rewritten ATOMICALLY; and only THEN is the sandbox committed. If ANY step
 * throws, the sandbox is rolled back (and the op-log rewrite either never ran or rolled back itself),
 * leaving the chat on the OLD schema + OLD op-log — internally consistent + recoverable, never
 * half-migrated. Throws on failure so the caller records it in `failedChats`.
 */
const migrateChat = (
  profileId: string,
  chatId: string,
  file: string,
  statements: string[],
  newTemplate: TableTemplate
): void => {
  const db = new Database(file)
  try {
    db.exec('BEGIN')
    try {
      for (const s of statements) db.exec(s)
      const baseline = buildBaselineOps(db, newTemplate)
      rewriteOpLog(profileId, chatId, baseline)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore rollback failure */
      }
      throw e
    }
  } finally {
    db.close()
  }
}

// ---- orchestrator ----------------------------------------------------------------------------

/**
 * Structurally edit a template and migrate every bound chat. Returns a report or a localizable
 * `{ ok:false, error }`; on validation failure NOTHING is written (template + sandboxes untouched).
 */
export const applyStructureOps = (
  profileId: string,
  templateId: string,
  ops: StructureOp[]
): StructureReport | StructureError => {
  const template = getTableTemplateById(profileId, templateId)
  if (!template) return err('tables.structureNoTemplate')

  if (!Array.isArray(ops) || ops.length === 0) {
    return {
      ok: true,
      tablesChanged: 0,
      columnsChanged: 0,
      chatsMigrated: 0,
      failedChats: [],
      warnings: []
    }
  }

  const plan = planStructureOps(template, ops)
  if (!plan.ok) return plan

  // Final tables (surviving in original order, then new) + their sqlNames for DDL read-back.
  const surviving = template.tables
    .map((t) => ({ oldDef: t, work: plan.byUid.get(t.uid)! }))
    .filter((x) => x.work && !x.work.dropped)
  const finalSqlNames = [
    ...surviving.map((x) => x.work.sqlName),
    ...plan.newTables.map((w) => w.sqlName)
  ]

  const chatIds = listChatIdsForTableTemplate(profileId, templateId)

  // 1) Derive new canonical DDL from a THROWAWAY in-memory DB (seeded from the current DDL) — ALWAYS,
  //    whether or not chats are bound. No real sandbox is touched here, so a derivation failure /
  //    guard trip leaves the template AND every sandbox byte-for-byte untouched.
  let newDdlByName: Record<string, string>
  try {
    newDdlByName = migrateAndDeriveDdl(
      ':memory:',
      plan.statements,
      finalSqlNames,
      template.tables.map((t) => t.ddl)
    )
  } catch (e) {
    log('error', `Structure migration failed to derive DDL for template ${templateId}:`, e)
    return err('tables.structureDeriveFailed')
  }
  for (const name of finalSqlNames) {
    if (!newDdlByName[name]) {
      log('error', `Structure migration produced no DDL for table "${name}"`)
      return err('tables.structureDeriveFailed')
    }
  }

  // 2) Build + persist the new template (ONCE, same id) — only AFTER derivation succeeded.
  const warnings: string[] = []
  const survivingDefs = surviving.map(({ oldDef, work }) => {
    const { def, warnings: w } = remapExistingTable(oldDef, work, newDdlByName[work.sqlName])
    warnings.push(...w)
    return def
  })
  const newDefs = plan.newTables.map((w) => buildNewTableDef(w, newDdlByName[w.sqlName]))
  const newTemplate: TableTemplate = { ...template, tables: [...survivingDefs, ...newDefs] }
  saveTableTemplate(profileId, newTemplate, templateId)

  // 3) NOW migrate each bound chat's live sandbox + re-baseline its op log, one at a time. Each chat's
  //    migrate+re-baseline is gated: on any failure it rolls back to the OLD schema + OLD op-log and is
  //    reported in `failedChats` (recoverable), while the template + other chats stay migrated.
  let migrated = 0
  const failedChats: { chatId: string; reason: string }[] = []
  for (const chatId of chatIds) {
    const file = sandboxDbPath(profileId, chatId)
    try {
      if (!fs.existsSync(file)) {
        // No sandbox yet (bound but never instantiated) — start fresh on the new schema.
        instantiate(profileId, chatId, newTemplate)
        deleteAllOps(profileId, chatId)
        migrated++
        continue
      }
      migrateChat(profileId, chatId, file, plan.statements, newTemplate)
      migrated++
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      log('error', `Structure migration failed for chat ${chatId} (left on previous schema):`, e)
      failedChats.push({ chatId, reason })
    }
  }

  return {
    ok: true,
    tablesChanged: plan.tablesChanged,
    columnsChanged: plan.columnsChanged,
    chatsMigrated: migrated,
    failedChats,
    warnings
  }
}
