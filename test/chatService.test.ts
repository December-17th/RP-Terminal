import { describe, it, expect } from 'vitest'
import { parseLorebookIds } from '../src/main/services/chatService'

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
