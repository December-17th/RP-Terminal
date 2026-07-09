/**
 * A REAL (not no-op) better-sqlite3-compatible adapter backed by Node's built-in `node:sqlite`
 * (`DatabaseSync`), for tests that must observe actual SQLite behavior — the table-structure
 * migration + op-log rebuild-consistency suite (`test/workflow/tableStructure.test.ts`).
 *
 * The default no-op mock (`test/mocks/better-sqlite3.ts`, wired via the vitest alias) is enough for
 * the pure-helper suites, but a migration DERIVES canonical DDL from SQLite (`ALTER … ; SELECT sql
 * FROM sqlite_master`) and the rebuild-consistency AC needs the sandbox rows to be observable. The
 * production native better-sqlite3 (built for Electron's ABI) can't load under plain Node, so this
 * shim mirrors JUST the surface the table-memory code touches on top of the real `node:sqlite`:
 *   pragma / exec / prepare(→ get, all, run, raw, columns) / transaction / close.
 *
 * Only used by suites that opt in via `vi.mock('better-sqlite3', () => import('./betterSqlite3Node'))`.
 */
import { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

class Stmt {
  private stmt: ReturnType<DatabaseSync['prepare']>
  private rawMode = false
  constructor(stmt: ReturnType<DatabaseSync['prepare']>) {
    this.stmt = stmt
  }
  /** better-sqlite3 mutates + returns the same statement; `.all()` then yields positional arrays. */
  raw(): this {
    this.rawMode = true
    return this
  }
  columns(): { name: string }[] {
    return (this.stmt.columns() as { name: string }[]).map((c) => ({ name: c.name }))
  }
  get(...params: unknown[]): unknown {
    // node:sqlite rejects `undefined`; the callers never bind it, but coerce defensively.
    return (this.stmt.get as (...a: unknown[]) => unknown)(...params)
  }
  all(...params: unknown[]): unknown[] {
    const rows = (this.stmt.all as (...a: unknown[]) => Row[])(...params)
    if (!this.rawMode) return rows
    const cols = (this.stmt.columns() as { name: string }[]).map((c) => c.name)
    return rows.map((r) => cols.map((c) => r[c]))
  }
  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const info = (this.stmt.run as (...a: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(
      ...params
    )
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) }
  }
}

export default class Database {
  private db: DatabaseSync
  /** Transaction nesting depth — better-sqlite3 nests via SAVEPOINT, so we mirror that here. */
  private depth = 0
  constructor(file: string, opts?: { readonly?: boolean }) {
    this.db = opts?.readonly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file)
  }
  /** No-op: the real host sets WAL; tests keep the default rollback journal (no -wal/-shm sidecars). */
  pragma(_source: string): unknown[] {
    return []
  }
  exec(sql: string): void {
    this.db.exec(sql)
  }
  prepare(sql: string): Stmt {
    return new Stmt(this.db.prepare(sql))
  }
  /**
   * Mirror better-sqlite3 `transaction(fn)`: the OUTER call runs fn in one BEGIN/COMMIT; a NESTED call
   * (transaction inside transaction, e.g. an atomic op-log rewrite that also calls `appendOps`) uses a
   * SAVEPOINT — just as better-sqlite3 does — so nested `db.transaction(...)()` doesn't error.
   */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return ((...args: unknown[]) => {
      const top = this.depth === 0
      const sp = `sp_${this.depth}`
      this.db.exec(top ? 'BEGIN' : `SAVEPOINT ${sp}`)
      this.depth++
      try {
        const r = fn(...args)
        this.depth--
        this.db.exec(top ? 'COMMIT' : `RELEASE ${sp}`)
        return r
      } catch (e) {
        this.depth--
        try {
          this.db.exec(top ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
        } catch {
          /* ignore rollback failure */
        }
        throw e
      }
    }) as T
  }
  close(): void {
    this.db.close()
  }
}
