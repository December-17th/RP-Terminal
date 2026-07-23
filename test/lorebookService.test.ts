import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  matchEntries,
  matchAcross,
  normalizeLorebookData,
  saveLorebookById,
  getLorebookById
} from '../src/main/services/lorebookService'
import { getAppDir } from '../src/main/services/storageService'
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
    const lb = book([{ keys: ['king'], secondary_keys: ['throne'], content: 'x', selective: true }])
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

  it('gates a matched entry on probability via the injected rng', () => {
    const lb = book([{ keys: ['a'], content: 'maybe', probability: 50 }])
    expect(matchEntries(lb, 'a', () => 0.9)).toHaveLength(0) // 90 >= 50 -> fails
    expect(matchEntries(lb, 'a', () => 0.1)).toHaveLength(1) // 10 < 50 -> fires
  })

  it('probability 100 always fires, 0 never fires', () => {
    const always = book([{ keys: ['a'], content: 'x', probability: 100 }])
    const never = book([{ keys: ['a'], content: 'x', probability: 0 }])
    expect(matchEntries(always, 'a', () => 0.999)).toHaveLength(1)
    expect(matchEntries(never, 'a', () => 0)).toHaveLength(0)
  })

  it('applies probability to constant entries too', () => {
    const lb = book([{ content: 'c', constant: true, probability: 30 }])
    expect(matchEntries(lb, 'anything', () => 0.5)).toHaveLength(0)
    expect(matchEntries(lb, 'anything', () => 0.2)).toHaveLength(1)
  })
})

describe('normalizeLorebookData', () => {
  it('maps ST aliases: object-keyed entries, key/keysecondary, order, position→depth, probability', () => {
    const lb = normalizeLorebookData(
      {
        name: 'World',
        entries: {
          '0': {
            key: ['dragon'],
            keysecondary: ['fire'],
            content: 'lore',
            order: 5,
            position: 4,
            depth: 3,
            probability: 80,
            selective: true
          }
        }
      },
      'fallback'
    )
    expect(lb).not.toBeNull()
    expect(lb!.name).toBe('World')
    const e = lb!.entries[0]
    expect(e.keys).toEqual(['dragon'])
    expect(e.secondary_keys).toEqual(['fire'])
    expect(e.insertion_order).toBe(5)
    expect(e.insertion_depth).toBe(3) // ST position 4 = at depth
    expect(e.probability).toBe(80)
    expect(e.selective).toBe(true)
  })

  it('leaves insertion_depth null when the entry is not positioned at depth', () => {
    const lb = normalizeLorebookData({ entries: [{ keys: ['x'], content: 'y', position: 0 }] }, 'f')
    expect(lb!.entries[0].insertion_depth).toBeNull()
  })

  it('returns null when there are no usable entries', () => {
    expect(normalizeLorebookData({ entries: {} }, 'f')).toBeNull()
    expect(normalizeLorebookData(null, 'f')).toBeNull()
  })

  it('preserves the source uid as id (numeric uid stringified)', () => {
    const lb = normalizeLorebookData(
      { entries: [{ uid: 7, keys: ['a'], content: 'x' }] },
      'f'
    )
    expect(lb!.entries[0].id).toBe('7')
  })

  it('falls back to the source id when there is no uid, and leaves id unset when neither is present', () => {
    const withId = normalizeLorebookData({ entries: [{ id: 'abc', keys: ['a'], content: 'x' }] }, 'f')
    expect(withId!.entries[0].id).toBe('abc')
    const none = normalizeLorebookData({ entries: [{ keys: ['a'], content: 'x' }] }, 'f')
    expect(none!.entries[0].id).toBeUndefined()
  })

  it('merges the source extensions object into extra', () => {
    const lb = normalizeLorebookData(
      { entries: [{ keys: ['a'], content: 'x', extensions: { cw_project_id: 'p1', foo: 42 } }] },
      'f'
    )
    expect(lb!.entries[0].extra).toMatchObject({ cw_project_id: 'p1', foo: 42 })
  })

  it('captures unconsumed source fields under extra.st_source for a sticky/cooldown/position entry', () => {
    const lb = normalizeLorebookData(
      {
        entries: [
          {
            keys: ['a'],
            content: 'x',
            sticky: 3,
            cooldown: 2,
            position: 1,
            group: 'g1',
            match_whole_words: true,
            scan_depth: 5
          }
        ]
      },
      'f'
    )
    const st = lb!.entries[0].extra!.st_source
    expect(st).toMatchObject({
      sticky: 3,
      cooldown: 2,
      position: 1,
      group: 'g1',
      matchWholeWords: true,
      scanDepth: 5
    })
  })

  it('omits extra entirely (and st_source) for a plain entry with no metadata', () => {
    const lb = normalizeLorebookData({ entries: [{ keys: ['a'], content: 'x' }] }, 'f')
    expect(lb!.entries[0].extra).toBeUndefined()
  })

  it('leaves normalize output otherwise identical to a plain entry (no behavior fields changed)', () => {
    const lb = normalizeLorebookData(
      { entries: [{ keys: ['a'], secondary_keys: ['b'], content: 'x', order: 42, selective: true }] },
      'f'
    )
    expect(lb!.entries[0]).toEqual({
      keys: ['a'],
      secondary_keys: ['b'],
      content: 'x',
      enabled: true,
      insertion_order: 42,
      insertion_depth: null,
      case_sensitive: false,
      constant: false,
      selective: true,
      probability: 100,
      exclude_recursion: false,
      prevent_recursion: false,
      comment: ''
    })
  })
})

describe('saveLorebookById id minting', () => {
  const profileId = `test-${randomUUID()}`
  const profileDir = path.join(getAppDir(), 'profiles', profileId)
  afterAll(() => {
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  it('mints ids for id-less entries once and is stable across re-save', () => {
    const id = randomUUID()
    saveLorebookById(profileId, id, LorebookSchema.parse({
      name: 'B',
      entries: [{ keys: ['a'], content: 'x' }, { id: 'kept', keys: ['b'], content: 'y' }]
    }))
    const first = getLorebookById(profileId, id)!
    expect(first.entries[0].id).toBeTruthy()
    expect(first.entries[1].id).toBe('kept')
    const mintedId = first.entries[0].id

    // Re-saving the already-id'd book changes nothing.
    saveLorebookById(profileId, id, first)
    const second = getLorebookById(profileId, id)!
    expect(second.entries[0].id).toBe(mintedId)
    expect(second.entries[1].id).toBe('kept')
  })
})

describe('regex keys', () => {
  it('a slash-delimited regex primary key matches, and non-matching text does not', () => {
    const lb = book([{ keys: ['/龙(族|人)/'], content: 'dragonkin lore' }])
    expect(matchEntries(lb, '一位龙族战士登场')).toHaveLength(1)
    expect(matchEntries(lb, '一位龙人使者登场')).toHaveLength(1)
    expect(matchEntries(lb, '一位精灵法师登场')).toHaveLength(0)
  })

  it('the regex i flag matches case-insensitively and case_sensitive is ignored for that key', () => {
    const lb = book([{ keys: ['/aria/i'], content: 'x', case_sensitive: true }])
    // case_sensitive:true would block a literal lowercase key, but the regex i flag governs.
    expect(matchEntries(lb, 'ARIA waves')).toHaveLength(1)
    expect(matchEntries(lb, 'aria waves')).toHaveLength(1)
  })

  it('a regex secondary key gates a selective entry', () => {
    const lb = book([
      { keys: ['king'], secondary_keys: ['/thr[o0]ne/'], content: 'x', selective: true }
    ])
    expect(matchEntries(lb, 'the king walks')).toHaveLength(0)
    expect(matchEntries(lb, 'the king on the thr0ne')).toHaveLength(1)
  })

  it('an invalid-regex-looking key falls back to literal matching and does not throw', () => {
    const lb = book([{ keys: ['/foo(/'], content: 'x' }])
    // '/foo(/' fails to compile, so it matches literally (including the slashes).
    expect(() => matchEntries(lb, 'nothing here')).not.toThrow()
    expect(matchEntries(lb, 'the /foo(/ marker')).toHaveLength(1)
    expect(matchEntries(lb, 'plain foo text')).toHaveLength(0)
  })

  it('a regex key triggers a recursion pass', () => {
    const lb = book([
      { keys: ['/dragon/i'], content: 'The dragon guards gold.' },
      { keys: ['gold'], content: 'Gold is treasure.' }
    ])
    const out = matchAcross([lb], 'a DRAGON appears', () => 0, 2)
    expect(out.map((e) => e.content).sort()).toEqual([
      'Gold is treasure.',
      'The dragon guards gold.'
    ])
  })

  it('a g-flagged regex key matches consistently across consecutive matchAcross calls', () => {
    // A cached g-flagged RegExp carries lastIndex; without a reset the 2nd call would miss.
    const lb = book([{ keys: ['/spark/g'], content: 'x' }])
    expect(matchAcross([lb], 'a spark flies', () => 0, 0)).toHaveLength(1)
    expect(matchAcross([lb], 'a spark flies', () => 0, 0)).toHaveLength(1)
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

  const recursionBook = (overrides: { exclude?: boolean; prevent?: boolean } = {}): any =>
    book([
      {
        keys: ['dragon'],
        content: 'The dragon guards gold.',
        prevent_recursion: overrides.prevent === true
      },
      {
        keys: ['gold'],
        content: 'Gold is treasure.',
        exclude_recursion: overrides.exclude === true
      }
    ])

  it('does not recurse when maxRecursion is 0', () => {
    const out = matchAcross([recursionBook()], 'a dragon appears', () => 0, 0)
    expect(out.map((e) => e.content)).toEqual(['The dragon guards gold.'])
  })

  it("recurses: a matched entry's content triggers another entry", () => {
    const out = matchAcross([recursionBook()], 'a dragon appears', () => 0, 2)
    expect(out.map((e) => e.content).sort()).toEqual([
      'Gold is treasure.',
      'The dragon guards gold.'
    ])
  })

  it('exclude_recursion entries are not triggered by a recursive pass', () => {
    const out = matchAcross([recursionBook({ exclude: true })], 'a dragon appears', () => 0, 2)
    expect(out.map((e) => e.content)).toEqual(['The dragon guards gold.'])
  })

  it("prevent_recursion entries don't feed the next pass", () => {
    const out = matchAcross([recursionBook({ prevent: true })], 'a dragon appears', () => 0, 2)
    expect(out.map((e) => e.content)).toEqual(['The dragon guards gold.'])
  })
})
