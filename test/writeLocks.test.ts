import { describe, it, expect } from 'vitest'

// Write-lock serialization for tables + floor variables (agent-packs WP1.5; ADR 0003).
//
// These pin the COORDINATION contract the write services expose, not the SQLite/file I/O (that stays
// alias-mocked elsewhere). The hazard ADR 0003 names is a read-modify-write that interleaves at an
// `await` between two concurrent engine runs (a turn vs. a headless run), losing an update. A caller
// wraps its whole critical section in `withLock(<scope key>, …)`; we prove that:
//   - two interleaved async read-modify-writes on the SAME scope key serialize → both writes land, in
//     submission order (no lost update), and
//   - the SAME two writers on DIFFERENT scope keys do NOT serialize (they interleave freely).
// We use the REAL scope-key builders the services lock on (`tableLockKey`, `varsLockKey`) so a drift in
// those keys would break these tests.

import { withLock, _lockedKeyCount } from '../src/main/services/asyncLock'
import { tableLockKey } from '../src/main/services/tableSql'
import { varsLockKey } from '../src/main/services/floorService'

/** A deferred, to force a precise interleaving (read happens, THEN we release the write). */
const deferred = <T>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * A read-modify-write against a shared record, with a caller-controlled pause BETWEEN the read and the
 * write — the exact shape of `getAllFloors → (await LLM) → saveFloor` / `getChatCardVars → mutate →
 * setChatCardVars`. Without a lock, two of these interleaving would each read the SAME base and the
 * second write would clobber the first (lost update).
 */
const readModifyWrite = async (
  store: Record<string, number>,
  key: string,
  add: number,
  pause: Promise<void>
): Promise<void> => {
  const base = store[key] ?? 0 // READ
  await pause // an await between read and write — the interleaving window
  store[key] = base + add // WRITE (clobbers if it read a stale base)
}

describe('write-lock serialization (same scope → no lost update, submission order)', () => {
  it('vars: two interleaved writers on the same chat key serialize; both writes land in order', async () => {
    const store: Record<string, number> = { total: 0 }
    const applied: number[] = []
    const g1 = deferred<void>()
    const g2 = deferred<void>()
    const key = varsLockKey('chatA')

    // Two writers submitted concurrently on the SAME key. Each does read → await → write. We resolve
    // the SECOND writer's pause FIRST to try to force a stale-read clobber — the lock must prevent it.
    const w1 = withLock(key, async () => {
      await readModifyWrite(store, 'total', 10, g1.promise)
      applied.push(10)
    })
    const w2 = withLock(key, async () => {
      await readModifyWrite(store, 'total', 3, g2.promise)
      applied.push(3)
    })

    // Release in reverse order: if the lock were absent, w2 would read base=0 and w1 base=0, and the
    // last write would win (lost update). With the lock, w2 can't even START until w1 fully commits.
    g2.resolve()
    g1.resolve()
    await Promise.all([w1, w2])

    expect(store.total).toBe(13) // 10 + 3 — NEITHER write lost
    expect(applied).toEqual([10, 3]) // submission order preserved
  })

  it('tables: two interleaved writers on the same chat key serialize; both writes land in order', async () => {
    const store: Record<string, number> = { rows: 0 }
    const applied: number[] = []
    const g1 = deferred<void>()
    const g2 = deferred<void>()
    const key = tableLockKey('chatT')

    const w1 = withLock(key, async () => {
      await readModifyWrite(store, 'rows', 2, g1.promise)
      applied.push(2)
    })
    const w2 = withLock(key, async () => {
      await readModifyWrite(store, 'rows', 5, g2.promise)
      applied.push(5)
    })

    g2.resolve()
    g1.resolve()
    await Promise.all([w1, w2])

    expect(store.rows).toBe(7) // 2 + 5 — no lost update
    expect(applied).toEqual([2, 5])
  })

  it('different scopes (different chats) do NOT serialize — the writers interleave', async () => {
    const store: Record<string, number> = { a: 0, b: 0 }
    const order: string[] = []
    const gA = deferred<void>()

    // Writer A (chatA) blocks on gate gA AFTER its read; writer B (chatB) has no gate. If the two keys
    // serialized, B would have to wait for A. They must NOT: B completes while A is still parked.
    const a = withLock(varsLockKey('chatA'), async () => {
      const base = store.a
      await gA.promise
      store.a = base + 1
      order.push('A')
    })
    const b = withLock(varsLockKey('chatB'), async () => {
      store.b = store.b + 1
      order.push('B')
    })

    await b // resolves without A having to unblock — proves independence
    expect(order).toEqual(['B'])

    gA.resolve()
    await a
    expect(order).toEqual(['B', 'A'])
    expect(store).toEqual({ a: 1, b: 1 })
  })

  it('a table key and a vars key for the SAME chat are independent scopes', async () => {
    // table:<chat> and vars:<chat> are DIFFERENT resources — a table write must not block a vars write.
    const order: string[] = []
    const gTable = deferred<void>()

    const t = withLock(tableLockKey('c'), async () => {
      await gTable.promise
      order.push('table')
    })
    const v = withLock(varsLockKey('c'), async () => {
      order.push('vars')
    })

    await v
    expect(order).toEqual(['vars']) // vars ran despite the table lock being held
    gTable.resolve()
    await t
    expect(order).toEqual(['vars', 'table'])
    // sanity: the keys really are distinct strings
    expect(tableLockKey('c')).not.toBe(varsLockKey('c'))
  })

  it('scope keys leave no residue after draining', async () => {
    await Promise.all([
      withLock(varsLockKey('z'), async () => {}),
      withLock(tableLockKey('z'), async () => {})
    ])
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(_lockedKeyCount()).toBe(0)
  })
})
