import { describe, it, expect } from 'vitest'
import { encodeNodeState, decodeNodeState } from '../src/main/services/nodeStateService'

// The DB layer is a no-op stub under Node (test/mocks/better-sqlite3.ts), so we test the pure
// JSON codec — the SQL wrappers are exercised at runtime (same pattern as memoryStore).
describe('node-state codec', () => {
  it('round-trips objects, arrays, and primitives', () => {
    for (const v of [{ last: '3月' }, [1, 2], 'x', 42, true, null]) {
      expect(decodeNodeState(encodeNodeState(v))).toEqual(v)
    }
  })

  it('undefined encodes to null (row cleared) and decodes back to undefined', () => {
    expect(encodeNodeState(undefined)).toBeNull()
    expect(decodeNodeState(null)).toBeUndefined()
    expect(decodeNodeState(undefined)).toBeUndefined()
  })

  it('corrupt stored JSON decodes to undefined instead of throwing', () => {
    expect(decodeNodeState('{oops')).toBeUndefined()
  })
})
