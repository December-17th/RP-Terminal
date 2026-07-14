import Database from 'better-sqlite3'
import fs from 'fs'
import { TableTemplate } from '../types/tableTemplate'
import { isSafeSqlIdentifier } from '../parsers/chatSheetsParser'
import { sandboxDbPath, templateSqlNames } from './tableDbService'
import { withLock } from './asyncLock'

/** Per-chat table-memory write lock key (agent-packs WP1.5; ADR 0003). The table DATA lives in a
 *  per-chat sandbox file (`sandboxDbPath(profileId, chatId)`) and the op log is keyed by `chat_id`,
 *  so a chat is the write-serialization scope — shared by every table writer (`table.apply`, the
 *  Tables-view hand edit, the manual backfill). */
export const tableLockKey = (chatId: string): string => `table:${chatId}`

/**
 * SQL WRITE PATH for SQL-table memory (issue 03) — the security-critical slice.
 *
 * LLM-emitted SQL never touches the app DB. It runs ONLY against a chat's per-chat sandbox file
 * (`tableDbService.sandboxDbPath`), and ONLY after every statement in the batch passes a strict
 * head-keyword + registered-table allowlist. The splitter/classifier/validateBatch helpers are PURE
 * and exhaustively unit-tested; `applySqlBatch` is the runtime wrapper (no-op under the vitest
 * better-sqlite3 alias mock — the native binary can't load under plain Node, so there is no
 * real-SQLite integration test; see docs/sdk/table-templates.md + the plan's Testing note).
 *
 * The ONLY statement kinds that ever execute at runtime are INSERT / UPDATE / DELETE whose target
 * table is registered in the assigned template. Every other head (SELECT at the top level, CREATE,
 * DROP, ALTER, ATTACH, DETACH, PRAGMA, BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE, WITH, EXPLAIN,
 * VACUUM, REINDEX, CREATE TRIGGER, …) is rejected by `classifyStatement` with a typed error naming
 * the head. Subqueries INSIDE an allowed statement are fine — the sandbox contains only template
 * tables and ATTACH is blocked at the head, so no other file is reachable.
 */

/** Thrown when a batch statement is rejected or fails; carries the offending statement index. */
export class TableSqlError extends Error {
  /** 0-based index of the statement in the batch that was rejected/failed (−1 = batch-level). */
  index: number
  constructor(message: string, index = -1) {
    super(message)
    this.name = 'TableSqlError'
    this.index = index
  }
}

export interface StatementInfo {
  kind: 'insert' | 'update' | 'delete'
  table: string
}

/**
 * Strip the non-SQL wrappers an LLM (especially a reasoning model) commonly leaves around a batch,
 * so a valid INSERT/UPDATE/DELETE isn't rejected as head `(unknown)`:
 *  - `<think>…</think>` reasoning blocks (any that leaked inside the emitted text),
 *  - a single fenced code block: an opening ```` ```sql ````/```` ``` ```` line + its closing ```` ``` ````.
 * We only unwrap when the WHOLE (trimmed) batch is one fenced block — a defensive, reversible transform
 * that leaves already-clean SQL untouched (no fence ⇒ returned as-is). Comment/quote-aware splitting +
 * the head allowlist still run afterwards, so this widens acceptance without weakening the sandbox.
 */
export const sanitizeSqlBatch = (text: string): string => {
  let s = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
  s = s.trim()
  // Unwrap a leading ```lang fence + trailing ``` (the most common LLM SQL wrapper).
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s)
  if (fence) s = fence[1].trim()
  return s
}

/**
 * Split a batch on `;` OUTSIDE string literals / comments. A small char-scanner tracks:
 *  - `'…'` single-quoted string literals with `''` escape,
 *  - `"…"` double-quoted identifiers with `""` escape,
 *  - `--` line comments (to end of line),
 *  - `/* … *␦/` block comments.
 * So semicolons and CJK text inside literals survive intact (the templates' SQL carries CJK strings
 * and may contain `;` inside literals). Trailing whitespace-only segments are dropped; each returned
 * statement is trimmed. Statement terminators (`;`) are NOT included in the returned segments.
 */
export const splitSqlStatements = (text: string): string[] => {
  const out: string[] = []
  let buf = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const next = i + 1 < n ? text[i + 1] : ''

    // -- line comment: skip to end of line (kept out of the statement text).
    if (c === '-' && next === '-') {
      i += 2
      while (i < n && text[i] !== '\n') i++
      continue
    }
    // /* block comment */: skip to the closing */ (kept out of the statement text).
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2 // consume the closing */
      continue
    }
    // Single-quoted string literal (with '' escape).
    if (c === "'") {
      buf += c
      i++
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") {
          buf += "''"
          i += 2
          continue
        }
        if (text[i] === "'") {
          buf += "'"
          i++
          break
        }
        buf += text[i]
        i++
      }
      continue
    }
    // Double-quoted identifier (with "" escape).
    if (c === '"') {
      buf += c
      i++
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') {
          buf += '""'
          i += 2
          continue
        }
        if (text[i] === '"') {
          buf += '"'
          i++
          break
        }
        buf += text[i]
        i++
      }
      continue
    }
    // Statement terminator at the top level.
    if (c === ';') {
      const stmt = buf.trim()
      if (stmt) out.push(stmt)
      buf = ''
      i++
      continue
    }
    buf += c
    i++
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out
}

/** Strip leading `-- line` and `/* block *␦/` comments + whitespace so we can read the head keyword. */
const stripLeading = (sql: string): string => {
  let s = sql
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n')
      s = nl === -1 ? '' : s.slice(nl + 1)
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/')
      s = end === -1 ? '' : s.slice(end + 2)
    }
    if (s === before) break
  }
  return s
}

/** Unquote a `"quoted"` table identifier (with `""` escape) or return a bare one unchanged. */
const unquoteIdent = (raw: string): string =>
  raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
    ? raw.slice(1, -1).replace(/""/g, '"')
    : raw

/**
 * Classify ONE statement by its head keyword (case-insensitive, after stripping leading comments).
 * Accepts only INSERT / UPDATE / DELETE and extracts the target table (bare or `"quoted"`),
 * validated with `isSafeSqlIdentifier`. Every other head throws a `TableSqlError` naming the head —
 * including SELECT (top level), CREATE, DROP, ALTER, ATTACH, DETACH, PRAGMA,
 * BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE, VACUUM, REINDEX, WITH (a CTE head hides the real verb),
 * EXPLAIN. `<table>` for INSERT is `INTO <t>`; for UPDATE it is the token right after UPDATE (after
 * an optional `OR …` conflict clause); for DELETE it is `FROM <t>`.
 */
export const classifyStatement = (sql: string): StatementInfo => {
  const s = stripLeading(sql)
  if (!s) throw new TableSqlError('Empty statement')

  // A quoted-or-bare identifier fragment for the target table.
  const ident = `("[^"]+(?:""[^"]*)*"|[A-Za-z_][A-Za-z0-9_$]*)`

  const insert = new RegExp(`^insert\\s+(?:or\\s+\\w+\\s+)?into\\s+${ident}`, 'i').exec(s)
  if (/^insert\b/i.test(s)) {
    if (!insert) throw new TableSqlError('Malformed INSERT (no INTO <table>)')
    return { kind: 'insert', table: assertTable(insert[1]) }
  }

  const update = new RegExp(`^update\\s+(?:or\\s+\\w+\\s+)?${ident}`, 'i').exec(s)
  if (/^update\b/i.test(s)) {
    if (!update) throw new TableSqlError('Malformed UPDATE (no target table)')
    return { kind: 'update', table: assertTable(update[1]) }
  }

  const del = new RegExp(`^delete\\s+from\\s+${ident}`, 'i').exec(s)
  if (/^delete\b/i.test(s)) {
    if (!del) throw new TableSqlError('Malformed DELETE (no FROM <table>)')
    return { kind: 'delete', table: assertTable(del[1]) }
  }

  // Anything else: name the rejected head keyword (first word) for the caller.
  const head = /^([A-Za-z]+)/.exec(s)?.[1]?.toUpperCase() ?? '(unknown)'
  throw new TableSqlError(`Rejected statement head "${head}" (only INSERT/UPDATE/DELETE allowed)`)
}

/** Unquote + validate a captured table identifier; throws if it isn't a safe identifier. */
const assertTable = (raw: string): string => {
  const name = unquoteIdent(raw)
  if (!isSafeSqlIdentifier(name)) {
    throw new TableSqlError(`Unsafe table identifier "${name}"`)
  }
  return name
}

export interface ValidatedStatement extends StatementInfo {
  sql: string
}

/**
 * Split + classify a batch, then assert every target table is in `allowedTables` (the template's
 * registry). Throws a `TableSqlError` (with the failing statement index) on the first violation.
 * Returns the validated statements in order. A blank/whitespace/comment-only batch → [].
 */
export const validateBatch = (text: string, allowedTables: Set<string>): ValidatedStatement[] => {
  const statements = splitSqlStatements(sanitizeSqlBatch(text))
  return statements.map((sql, index) => {
    let info: StatementInfo
    try {
      info = classifyStatement(sql)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new TableSqlError(msg, index)
    }
    if (!allowedTables.has(info.table)) {
      throw new TableSqlError(`Unregistered target table "${info.table}"`, index)
    }
    return { ...info, sql }
  })
}

/**
 * Split a validated batch by write scope: statements whose target table is in `selected` are KEPT
 * (applied + recorded), the rest are DROPPED (counted + logged — out-of-scope writes the model emitted
 * despite the "only update: <selected>" directive). Preserves order within each partition. PURE.
 *
 * The ONE shared write-scope filter: the manual REFILL engine (`tableRefillService`, which re-exports
 * this) and the AUTOMATIC due-set gate (`memory.maintain` via `applyTableEdit`) both partition through
 * it, so auto/manual never drift (table-refill WS2/WS3 plan requirement). Lives here — next to
 * `validateBatch`/`ValidatedStatement` it consumes — so both callers import a leaf, not each other.
 */
export const partitionBySelected = (
  validated: ValidatedStatement[],
  selected: Set<string>
): { kept: string[]; dropped: string[] } => {
  const kept: string[] = []
  const dropped: string[] = []
  for (const v of validated) (selected.has(v.table) ? kept : dropped).push(v.sql)
  return { kept, dropped }
}

export interface ApplyResult {
  applied: number
  changes: number
  /** The exact statements that ran (validated + trimmed), in order — what the caller logs as ops. */
  statements: string[]
}

/**
 * Runtime wrapper — validate then execute a batch against a chat's sandbox in ONE transaction.
 * VALIDATION RUNS FIRST (throws before we touch the DB). The sandbox file must already exist
 * (template instantiated) — a missing file throws. All statements run in a single `db.transaction`,
 * summing `run().changes`; if the running total exceeds `maxChanges` (default 500) we throw INSIDE
 * the transaction so EVERYTHING rolls back. Any statement error rolls the whole batch back and is
 * rethrown as a `TableSqlError` carrying the statement index. The DB handle is always closed in
 * `finally`. Not unit-tested (no-op under the alias mock) — same stance as `tableDbService`.
 */
export const applySqlBatch = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  sqlText: string,
  opts?: { maxChanges?: number }
): ApplyResult => runApplySqlBatch(profileId, chatId, template, sqlText, opts)

/**
 * The synchronous batch-apply body, serialized per chat through the table lock (WP1.5 / ADR 0003).
 * A single writer runs on the lock's fast path SYNCHRONOUSLY, so `applySqlBatch` keeps its synchronous
 * `ApplyResult` return and every caller (the `table.apply` node, the Tables-view hand edit
 * `tableEditService.applyEdit`, the manual backfill `tableBackfillService`) is unaffected in the
 * single-writer case; only genuinely concurrent table writes on the same chat serialize. The result
 * is captured out of the fast-path closure so it can be returned synchronously; the lock's promise is
 * not awaited (there is no `await` in the body, so the fast path always completes before we read
 * `captured`). NOTE the op-log `appendOps` that follows a batch lives in each caller — a headless
 * runner that must keep batch+append atomic wraps both in `withLock(tableLockKey(chatId), …)`. */
const runApplySqlBatch = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  sqlText: string,
  opts?: { maxChanges?: number }
): ApplyResult => {
  let captured: ApplyResult | undefined
  let thrown: unknown
  let didThrow = false
  void withLock(tableLockKey(chatId), () => {
    try {
      captured = applySqlBatchSync(profileId, chatId, template, sqlText, opts)
    } catch (err) {
      // Re-surface synchronously below: `withLock` would otherwise fold this into a (voided) rejected
      // promise and callers depend on a SYNCHRONOUS throw (e.g. tableEditService catches TableSqlError).
      didThrow = true
      thrown = err
    }
  })
  // The body is synchronous with no `await`, so the fast path has already run by the time we get here:
  // either `captured` is set or the body threw and we re-throw it on this same synchronous call.
  if (didThrow) throw thrown
  return captured as ApplyResult
}

/**
 * Apply a batch against an ARBITRARY sandbox file (table-refill WS2): the same validate-then-execute-in-
 * one-transaction body as `applySqlBatch`, but keyed to a file PATH (the refill engine applies to its
 * temp SHADOW file) and WITHOUT the per-chat lock — the shadow is private to one sequential refill run,
 * so there is no concurrent writer to serialize against. Throws `TableSqlError` on a validation/exec
 * failure (so the refill's SQL-error corrective loop can re-ask). The live-path `applySqlBatch` is
 * unchanged.
 */
export const applySqlBatchAt = (
  file: string,
  template: TableTemplate,
  sqlText: string,
  opts?: { maxChanges?: number }
): ApplyResult => applySqlBatchToFile(file, template, sqlText, opts)

/** The un-serialized batch apply — validate then execute in one transaction. Kept private; the lock
 *  is applied by `runApplySqlBatch`. */
const applySqlBatchSync = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  sqlText: string,
  opts?: { maxChanges?: number }
): ApplyResult => applySqlBatchToFile(sandboxDbPath(profileId, chatId), template, sqlText, opts)

/** Validate + execute a batch against `file` in one transaction (the shared body of the live and
 *  shadow apply paths). No lock — the caller owns serialization. */
const applySqlBatchToFile = (
  file: string,
  template: TableTemplate,
  sqlText: string,
  opts?: { maxChanges?: number }
): ApplyResult => {
  const maxChanges = opts?.maxChanges ?? 500
  const validated = validateBatch(sqlText, templateSqlNames(template))
  if (validated.length === 0) return { applied: 0, changes: 0, statements: [] }

  if (!fs.existsSync(file)) {
    throw new TableSqlError('Table sandbox not instantiated for this chat')
  }

  const db = new Database(file)
  try {
    let changes = 0
    db.transaction(() => {
      validated.forEach((stmt, index) => {
        try {
          const info = db.prepare(stmt.sql).run()
          changes += info.changes
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          throw new TableSqlError(msg, index)
        }
        if (changes > maxChanges) {
          throw new TableSqlError(
            `Batch exceeded the ${maxChanges}-row change cap (rolled back)`,
            index
          )
        }
      })
    })()
    return { applied: validated.length, changes, statements: validated.map((s) => s.sql) }
  } finally {
    db.close()
  }
}

/**
 * Replay ONE already-accepted op against an already-open sandbox handle. Used by rewind rebuild:
 * WITHOUT re-logging and WITHOUT the change cap (this is accepted history). Validation still runs
 * (defense in depth — the op log stores raw SQL). Throws `TableSqlError` on rejection/failure so the
 * caller can log-and-skip (fail-open). Kept separate from `applySqlBatch` so replay can share one
 * transaction across the whole history.
 */
export const replayOneOp = (
  db: Database.Database,
  template: TableTemplate,
  sql: string
): void => {
  const validated = validateBatch(sql, templateSqlNames(template))
  for (const stmt of validated) db.prepare(stmt.sql).run()
}

/**
 * PURE validator for the READ-ONLY `table.query` node (issue 05). A query is accepted as EITHER:
 *  - a BARE registered sqlName (a single token that IS a known table name) → rewritten to
 *    `SELECT * FROM "<t>"`, OR
 *  - a SINGLE statement (`splitSqlStatements` length 1, so no multi-statement injection) whose head
 *    keyword is `SELECT` (case-insensitive, after leading comments are stripped).
 *
 * Everything else is rejected — notably `WITH` (a CTE head hides whether the real body reads or
 * writes; documented as out-of-contract), PRAGMA, ATTACH, INSERT/UPDATE/DELETE, and any multi-
 * statement text. Rejection carries the reason for the caller's class-B `bad-query`. A blank/
 * whitespace/comment-only query yields `{ ok: false, reason: 'empty' }` — the caller treats that as
 * a SILENT empty (a read, like table.export), NOT an error.
 *
 * Note the head check is a DEFENSE-IN-DEPTH gate: the runtime wrapper ALSO opens the sandbox
 * `{ readonly: true }` so even a SELECT that somehow reached SQLite could not mutate the file.
 */
export interface ReadQueryPlan {
  ok: boolean
  /** The runnable `SELECT …` SQL (only when `ok`). */
  sql?: string
  /** Rejection reason (only when `!ok`); `'empty'` marks the silent no-op case. */
  reason?: string
}

export const validateReadQuery = (query: string, registered: Set<string>): ReadQueryPlan => {
  const trimmed = (query ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  // A bare registered table name (a single safe identifier that names a known table) → SELECT *.
  if (isSafeSqlIdentifier(trimmed) && registered.has(trimmed)) {
    return { ok: true, sql: `SELECT * FROM "${trimmed}"` }
  }

  const statements = splitSqlStatements(trimmed)
  if (statements.length === 0) return { ok: false, reason: 'empty' }
  if (statements.length > 1) {
    return { ok: false, reason: 'only a single SELECT statement is allowed' }
  }
  const head = /^([A-Za-z]+)/.exec(stripLeading(statements[0]))?.[1]?.toUpperCase() ?? '(unknown)'
  if (head !== 'SELECT') {
    return { ok: false, reason: `rejected query head "${head}" (only SELECT / a bare table name)` }
  }
  return { ok: true, sql: statements[0] }
}

export interface ReadQueryResult {
  /** Column names in result order. */
  columns: string[]
  /** Result rows as positional arrays (better-sqlite3 `.raw().all()`), aligned to `columns`. */
  rows: unknown[][]
}

/**
 * Runtime wrapper for `table.query` — validate (via `validateReadQuery`) then execute the single
 * SELECT against a chat's sandbox opened `{ readonly: true }` (defense in depth behind the head
 * check). Returns column names + positional rows. A missing sandbox file → empty result (the chat
 * has table memory assigned but never instantiated). A rejected query throws `TableSqlError`. A
 * SQLite runtime error is rethrown as a `TableSqlError` carrying SQLite's message. The DB handle is
 * always closed. Not unit-tested (no-op under the vitest alias mock) — same stance as `applySqlBatch`.
 */
export const executeReadQuery = (
  profileId: string,
  chatId: string,
  template: TableTemplate,
  query: string
): ReadQueryResult => {
  const plan = validateReadQuery(query, templateSqlNames(template))
  if (!plan.ok || !plan.sql) {
    throw new TableSqlError(plan.reason ?? 'invalid query')
  }
  const file = sandboxDbPath(profileId, chatId)
  if (!fs.existsSync(file)) return { columns: [], rows: [] }

  const db = new Database(file, { readonly: true })
  try {
    const stmt = db.prepare(plan.sql)
    const columns = (stmt.columns?.() ?? []).map((c: { name: string }) => c.name)
    const rows = (stmt.raw?.().all() as unknown[][]) ?? []
    return { columns, rows }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new TableSqlError(msg)
  } finally {
    db.close()
  }
}
