import { describe, it, expect, vi, beforeEach } from 'vitest'

// setChatTableTemplateId is DB/fs-bound: mock the `./db` seam to capture prepared SQL, keep the pure
// guard + op-log helpers real (they route through the mocked db), and stub the destructive tableDbService
// side effects (instantiate / removeSandbox / removeShadow) so we can assert them without touching disk.
const preparedSql: string[] = []
vi.mock('../src/main/services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      preparedSql.push(sql)
      return { run: vi.fn(), get: () => undefined, all: () => [] }
    }
  }),
  transact: (fn: () => unknown) => fn()
}))
vi.mock('../src/main/services/tableTemplateService', () => ({
  getTableTemplateById: vi.fn(() => ({ id: 't1', tables: [] }))
}))
vi.mock('../src/main/services/tableDbService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/tableDbService')>()
  return { ...actual, instantiate: vi.fn(), removeSandbox: vi.fn(), removeShadow: vi.fn() }
})

import { parseLorebookIds, setChatTableTemplateId } from '../src/main/services/chatService'
import * as tableDbService from '../src/main/services/tableDbService'

describe('parseLorebookIds', () => {
  it("returns null for a null column (default = character's own book)", () => {
    expect(parseLorebookIds(null)).toBeNull()
  })

  it('parses a JSON string array', () => {
    expect(parseLorebookIds('["a","b"]')).toEqual(['a', 'b'])
  })

  it('returns an empty array (explicit "no lorebooks") distinct from null', () => {
    expect(parseLorebookIds('[]')).toEqual([])
  })

  it('drops non-string members', () => {
    expect(parseLorebookIds('["a",1,null,"b"]')).toEqual(['a', 'b'])
  })

  it('returns null for invalid JSON or a non-array value', () => {
    expect(parseLorebookIds('not json')).toBeNull()
    expect(parseLorebookIds('{"a":1}')).toBeNull()
  })
})

describe('setChatTableTemplateId — reassign discards INTERRUPTED-refill state', () => {
  beforeEach(() => {
    preparedSql.length = 0
    vi.mocked(tableDbService.removeShadow).mockClear()
  })

  it('drops the persisted table_refill_progress row and removes the refill shadow', () => {
    // An interrupted refill leaves a progress row + shadow keyed to the OLD template; if they survive the
    // reassign, the workbench would offer Resume against the NEW template with a stale completedUntil.
    setChatTableTemplateId('p1', 'c1', 't1')
    expect(preparedSql.some((s) => s.includes('DELETE FROM table_refill_progress'))).toBe(true)
    expect(vi.mocked(tableDbService.removeShadow)).toHaveBeenCalledWith('p1', 'c1')
  })
})
