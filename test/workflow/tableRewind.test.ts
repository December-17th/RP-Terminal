import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// History-rewind op-log tests (Memory-Manager WP3). better-sqlite3 is alias-mocked to a no-op (the
// native binary can't load under plain Node), so the REAL sandbox rows aren't observable — the same
// constraint tableOps.test.ts / tableNodes.test.ts call out. We instead fake ONLY the `table_ops`
// store (the four queries tableOpsService issues) and pin the observable rewind mechanism: appended
// ops list in replay order, a mid-point cut TRUNCATES the log, and the survivors are EXACTLY the
// earlier state's ordered ops (so rebuildSandbox — instantiate + ordered replay — reconstructs the
// earlier rows). The display projection's newest-first + kind/table/timestamp shape is pinned too.

const dbMock = vi.hoisted(() => {
  interface Row {
    chat_id: string
    floor: number
    seq: number
    sql: string
    created_at: string
  }
  let store: Row[] = []
  const reset = (): void => {
    store = []
  }
  const fakeDb = {
    prepare(sql: string) {
      if (sql.includes('MAX(seq)')) {
        return {
          get: (chatId: string, floor: number) => {
            const seqs = store
              .filter((r) => r.chat_id === chatId && r.floor === floor)
              .map((r) => r.seq)
            return { maxSeq: seqs.length ? Math.max(...seqs) : null }
          }
        }
      }
      if (sql.startsWith('INSERT INTO table_ops')) {
        return {
          run: (
            chat_id: string,
            floor: number,
            seq: number,
            sqlText: string,
            created_at: string
          ) => {
            store.push({ chat_id, floor, seq, sql: sqlText, created_at })
            return { changes: 1 }
          }
        }
      }
      // Display projection (newest-first) — must be matched BEFORE the plain listOps SELECT below.
      if (sql.startsWith('SELECT floor, seq, sql, created_at')) {
        return {
          all: (chatId: string) =>
            store
              .filter((r) => r.chat_id === chatId)
              .sort((a, b) => b.floor - a.floor || b.seq - a.seq)
              .map((r) => ({ floor: r.floor, seq: r.seq, sql: r.sql, created_at: r.created_at }))
        }
      }
      if (sql.startsWith('SELECT floor, seq, sql')) {
        return {
          all: (chatId: string) =>
            store
              .filter((r) => r.chat_id === chatId)
              .sort((a, b) => a.floor - b.floor || a.seq - b.seq)
              .map((r) => ({ floor: r.floor, seq: r.seq, sql: r.sql }))
        }
      }
      // Rewind cut — must be matched BEFORE the delete-all query (both share the same prefix).
      if (sql.includes('floor >=')) {
        return {
          run: (chatId: string, fromFloor: number) => {
            const before = store.length
            store = store.filter((r) => !(r.chat_id === chatId && r.floor >= fromFloor))
            return { changes: before - store.length }
          }
        }
      }
      if (sql.startsWith('DELETE FROM table_ops WHERE chat_id = ?')) {
        return {
          run: (chatId: string) => {
            const before = store.length
            store = store.filter((r) => r.chat_id !== chatId)
            return { changes: before - store.length }
          }
        }
      }
      return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }
    },
    transaction<T extends (...a: unknown[]) => unknown>(fn: T): T {
      return ((...a: unknown[]) => fn(...a)) as T
    }
  }
  return { getDb: () => fakeDb, reset }
})

vi.mock('../../src/main/services/db', () => ({ getDb: dbMock.getDb }))

// The sandbox side of a rebuild can't run under the better-sqlite3 alias mock; stub tableDbService so the
// guard-claim/release behaviour of rewindTables is observable without touching a real sandbox file. The
// template=null rewind path (removeSandbox) is enough to exercise claim → body → release.
vi.mock('../../src/main/services/tableDbService', () => ({
  instantiate: vi.fn(),
  removeSandbox: vi.fn(),
  sandboxDbPath: vi.fn(() => '/nonexistent'),
  templateSqlNames: vi.fn(() => new Set<string>())
}))

import {
  appendOps,
  listOps,
  listOpsForDisplay,
  deleteOpsFrom,
  replayPlan,
  rewindTables,
  beginTableWrite,
  renewTableWrite,
  endTableWrite
} from '../../src/main/services/tableOpsService'
import * as tableDbService from '../../src/main/services/tableDbService'

const P = 'prof'
const C = 'chatX'

describe('table history op-log + rewind', () => {
  beforeEach(() => dbMock.reset())

  it('appends ops with a continuing per-(floor) seq and lists them in replay order', () => {
    appendOps(P, C, 0, ['INSERT INTO t VALUES (1)', "UPDATE t SET x=1 WHERE row_id=1"])
    appendOps(P, C, 1, ['INSERT INTO t VALUES (2)'])
    appendOps(P, C, 2, ['DELETE FROM t WHERE row_id=1'])
    expect(listOps(P, C).map((o) => [o.floor, o.seq])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [2, 0]
    ])
  })

  it('a mid-point rewind (deleteOpsFrom) truncates the op-log to floors before the cut', () => {
    appendOps(P, C, 0, ['INSERT INTO t VALUES (1)'])
    appendOps(P, C, 1, ['INSERT INTO t VALUES (2)'])
    appendOps(P, C, 2, ['INSERT INTO t VALUES (3)'])
    const dropped = deleteOpsFrom(P, C, 1)
    expect(dropped).toBe(2) // floors 1 and 2
    expect(listOps(P, C).map((o) => o.floor)).toEqual([0])
  })

  it("the survivors of a cut are exactly the earlier state's ordered ops (rebuild reconstructs it)", () => {
    // The op-sequence a fresh chat accrues through floor < cut IS the earlier state (rebuildSandbox
    // = instantiate + ordered replay of these). Rewinding a fuller history to the same cut must yield
    // that identical ordered op set.
    const early = 'earlyChat'
    appendOps(P, early, 0, ["INSERT INTO t VALUES ('a')"])
    appendOps(P, early, 1, ["UPDATE t SET x='b' WHERE row_id=1"])
    const earlierOps = listOps(P, early).map((o) => o.sql)

    appendOps(P, C, 0, ["INSERT INTO t VALUES ('a')"])
    appendOps(P, C, 1, ["UPDATE t SET x='b' WHERE row_id=1"])
    appendOps(P, C, 2, ['DELETE FROM t WHERE row_id=1']) // the later state we rewind away

    deleteOpsFrom(P, C, 2)
    expect(listOps(P, C).map((o) => o.sql)).toEqual(earlierOps)
    // replayPlan (the pure survivor helper rebuildSandbox relies on) agrees with the truncated log.
    expect(replayPlan(listOps(P, C), 99).map((o) => o.sql)).toEqual(earlierOps)
  })

  it('is per-chat: a rewind on one chat leaves another chat untouched', () => {
    appendOps(P, C, 0, ['INSERT INTO t VALUES (1)'])
    appendOps(P, 'other', 0, ['INSERT INTO t VALUES (9)'])
    appendOps(P, 'other', 1, ['INSERT INTO t VALUES (10)'])
    deleteOpsFrom(P, C, 0)
    expect(listOps(P, C)).toEqual([])
    expect(listOps(P, 'other').map((o) => o.floor)).toEqual([0, 1])
  })

  it('listOpsForDisplay projects the log newest-first with kind + table + a timestamp', () => {
    appendOps(P, C, 0, ['INSERT INTO chronicle VALUES (1)'])
    appendOps(P, C, 1, ["UPDATE roleplay_guide SET g='x' WHERE row_id=1"])
    const view = listOpsForDisplay(P, C)
    expect(view.map((v) => v.floor)).toEqual([1, 0]) // newest-first
    expect(view[0]).toMatchObject({ kind: 'update', table: 'roleplay_guide' })
    expect(view[1]).toMatchObject({ kind: 'insert', table: 'chronicle' })
    expect(typeof view[0].createdAt).toBe('string')
  })
})

// rewindTables now CLAIMS the per-chat write guard itself (P1 fix): a rewind mid-refill must busy-reject
// instead of deleting ops that the refill's guarded rebuild would then skip (leaving a stale shadow).
describe('rewindTables write-guard fencing', () => {
  const GC = 'guardChat'
  beforeEach(() => {
    dbMock.reset()
  })
  afterEach(() => {
    // Release any slot a test left held so the module-level guard Map doesn't leak across tests.
    endTableWrite(GC)
  })

  it('busy-rejects (throws tables.memoryWriteBusy) while another token holds the guard, dropping no ops', () => {
    const holder = beginTableWrite(GC) // stand in for a live refill owning the slot
    expect(holder).not.toBeNull()
    appendOps(P, GC, 0, ['INSERT INTO t VALUES (1)'])
    appendOps(P, GC, 1, ['INSERT INTO t VALUES (2)'])

    expect(() => rewindTables(P, GC, 1, null)).toThrow('tables.memoryWriteBusy')
    // The ops survive — the reject fired before any deleteOpsFrom.
    expect(listOps(P, GC).map((o) => o.floor)).toEqual([0, 1])
    // The refill's claim was neither stolen nor freed by the rejected rewind.
    expect(renewTableWrite(GC, holder!)).toBe(true)
    endTableWrite(GC, holder!)
  })

  it('releases its own claim on success (a later claim then succeeds)', () => {
    appendOps(P, GC, 0, ['INSERT INTO t VALUES (1)'])
    appendOps(P, GC, 1, ['INSERT INTO t VALUES (2)'])

    const dropped = rewindTables(P, GC, 1, null)
    expect(dropped).toBe(1)
    expect(tableDbService.removeSandbox).toHaveBeenCalled() // null template ⇒ removeSandbox path
    // Guard released: the slot is free again.
    const tok = beginTableWrite(GC)
    expect(tok).not.toBeNull()
    endTableWrite(GC, tok!)
  })

  it('releases its own claim even when the rebuild throws', () => {
    vi.mocked(tableDbService.removeSandbox).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    appendOps(P, GC, 0, ['INSERT INTO t VALUES (1)'])

    expect(() => rewindTables(P, GC, 0, null)).toThrow('boom')
    // The failing rebuild still freed the slot via the finally, so a fresh claim works.
    const tok = beginTableWrite(GC)
    expect(tok).not.toBeNull()
    endTableWrite(GC, tok!)
  })
})
