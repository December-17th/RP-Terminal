import { describe, it, expect } from 'vitest'
import { matchEntries, matchAcross } from '../src/main/services/lorebookService'
import { LorebookSchema } from '../src/main/types/character'

const book = (entries: any[]): ReturnType<typeof LorebookSchema.parse> =>
  LorebookSchema.parse({ name: 'Test', entries })

describe('matchEntries', () => {
  it('always injects constant entries and skips disabled ones', () => {
    const lb = book([
      { content: 'always', constant: true },
      { content: 'off', constant: true, enabled: false }
    ])
    const out = matchEntries(lb, 'unrelated text')
    expect(out.map((e) => e.content)).toEqual(['always'])
  })

  it('fires on a keyword hit (case-insensitive by default)', () => {
    const lb = book([{ keys: ['castle'], content: 'the keep' }])
    expect(matchEntries(lb, 'We approach the CASTLE gate')).toHaveLength(1)
    expect(matchEntries(lb, 'no match here')).toHaveLength(0)
  })

  it('respects case_sensitive', () => {
    const lb = book([{ keys: ['Aria'], content: 'x', case_sensitive: true }])
    expect(matchEntries(lb, 'aria waves')).toHaveLength(0)
    expect(matchEntries(lb, 'Aria waves')).toHaveLength(1)
  })

  it('requires a secondary key when selective', () => {
    const lb = book([
      { keys: ['king'], secondary_keys: ['throne'], content: 'x', selective: true }
    ])
    expect(matchEntries(lb, 'the king walks')).toHaveLength(0)
    expect(matchEntries(lb, 'the king on the throne')).toHaveLength(1)
  })

  it('sorts matches by insertion_order ascending', () => {
    const lb = book([
      { keys: ['a'], content: 'second', insertion_order: 50 },
      { keys: ['a'], content: 'first', insertion_order: 10 }
    ])
    expect(matchEntries(lb, 'a').map((e) => e.content)).toEqual(['first', 'second'])
  })

  it('returns nothing for a null/empty book', () => {
    expect(matchEntries(null, 'a')).toEqual([])
    expect(matchEntries(book([]), 'a')).toEqual([])
  })
})

describe('matchAcross', () => {
  it('merges matches from several books, ordered by insertion_order', () => {
    const a = book([{ keys: ['x'], content: 'A', insertion_order: 30 }])
    const b = book([
      { content: 'B-const', constant: true, insertion_order: 10 },
      { keys: ['x'], content: 'B-key', insertion_order: 20 }
    ])
    expect(matchAcross([a, b], 'x marks').map((e) => e.content)).toEqual(['B-const', 'B-key', 'A'])
  })
})
