/**
 * Stub for the native better-sqlite3 (built for Electron's ABI, unloadable under
 * plain Node). Only needs to be importable — the pure helpers under test never
 * instantiate or query a database. A `getDb()` call would throw, which is fine.
 */
class Statement {
  get(): undefined {
    return undefined
  }
  all(): unknown[] {
    return []
  }
  run(): void {}
}

export default class Database {
  pragma(): void {}
  exec(): void {}
  close(): void {}
  prepare(): Statement {
    return new Statement()
  }
  // Mirror better-sqlite3's transaction(fn) → a function that runs fn (immediately, no real tx).
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return ((...args: unknown[]) => fn(...args)) as T
  }
}
