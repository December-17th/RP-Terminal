import { describe, it, expect } from 'vitest'
import { scoreLoreEntries, DEFAULT_SCORING_PARAMS } from '../src/main/services/loreScoring'
import type { ScoreSegment } from '../src/main/services/loreScoring'
import type { ScoringParams } from '../src/shared/retrievalTrace'
import type { LorebookEntry, Lorebook } from '../src/main/types/character'

/**
 * Pure unit tests for the deterministic lore-scoring PoC (debug-window only). No electron / DB / IPC —
 * the scorer is pure. These pin the formula: recency, idf, pin boost, probability, the selective hard
 * gate, one-hop spreading activation, recursion-flag suppression, constant bypass, top-K tie-break, and
 * regex-key parity through the shared matcher.
 */

const mkEntry = (o: Partial<LorebookEntry>): LorebookEntry => ({
  keys: [],
  secondary_keys: [],
  content: '',
  enabled: true,
  insertion_order: 100,
  insertion_depth: null,
  case_sensitive: false,
  constant: false,
  selective: false,
  probability: 100,
  exclude_recursion: false,
  prevent_recursion: false,
  comment: '',
  ...o
})

const book = (name: string, entries: LorebookEntry[]): { name: string; lorebook: Lorebook } => ({
  name,
  lorebook: { name, entries }
})

const seg = (depth: number, text: string): ScoreSegment => ({ depth, text })
// These tests exercise SCORING/RANKING mechanics, so they default to the old fixed-K selection (no floor,
// no relative cut) unless a test opts in. The adaptive-selection semantics have their own block below.
const params = (o: Partial<ScoringParams> = {}): ScoringParams => ({
  ...DEFAULT_SCORING_PARAMS,
  minScore: 0,
  relCut: 0,
  ...o
})

const row = (rows: ReturnType<typeof scoreLoreEntries>, comment: string): ReturnType<typeof scoreLoreEntries>[number] =>
  rows.find((r) => r.comment === comment)!

describe('scoreLoreEntries — determinism', () => {
  it('two identical calls produce deeply-equal output', () => {
    const books = [
      book('B1', [
        mkEntry({ keys: ['alpha'], content: 'names beta', comment: 'A' }),
        mkEntry({ keys: ['beta'], content: '', comment: 'B' })
      ]),
      book('B2', [mkEntry({ keys: ['gamma'], content: '', comment: 'G', probability: 40 })])
    ]
    const segs = [seg(0, 'alpha now'), seg(2, 'gamma here')]
    const a = scoreLoreEntries(books, segs, '\n[PINS]\nalpha', params())
    const b = scoreLoreEntries(books, segs, '\n[PINS]\nalpha', params())
    expect(a).toEqual(b)
  })
})

describe('scoreLoreEntries — recency', () => {
  it('the same key at depth 0 outscores it at depth 3', () => {
    const books = [
      book('B', [
        mkEntry({ keys: ['x'], content: '', comment: 'near' }),
        mkEntry({ keys: ['y'], content: '', comment: 'far' })
      ])
    ]
    const segs = [seg(0, 'x here'), seg(3, 'y here')]
    const rows = scoreLoreEntries(books, segs, '', params())
    expect(row(rows, 'near').score).toBeGreaterThan(row(rows, 'far').score)
  })
})

describe('scoreLoreEntries — idf', () => {
  it('a key declared by many entries contributes less than a rare key', () => {
    // 'common' is declared + present in five entries' content; 'rare' only in the target.
    const commons = [1, 2, 3, 4, 5].map((n) =>
      mkEntry({ keys: ['common'], content: 'common', comment: `C${n}` })
    )
    const target = mkEntry({ keys: ['common', 'rare'], content: '', comment: 'T' })
    const books = [book('B', [...commons, target])]
    const rows = scoreLoreEntries(books, [seg(0, 'common rare')], '', params())
    const t = row(rows, 'T')
    const commonHit = t.keyHits.find((h) => h.key === 'common')!
    const rareHit = t.keyHits.find((h) => h.key === 'rare')!
    expect(rareHit.idf).toBeGreaterThan(commonHit.idf)
  })
})

describe('scoreLoreEntries — pin boost', () => {
  it('a pin hit beats a deep-transcript recency hit', () => {
    const books = [
      book('B', [
        mkEntry({ keys: ['deep'], content: '', comment: 'deep' }),
        mkEntry({ keys: ['pinned'], content: '', comment: 'pinned' })
      ])
    ]
    const segs = [seg(5, 'deep down')]
    const rows = scoreLoreEntries(books, segs, '\n[PINS]\npinned', params())
    const pinned = row(rows, 'pinned')
    expect(pinned.score).toBeGreaterThan(row(rows, 'deep').score)
    expect(pinned.keyHits[0].pin).toBe(true)
    expect(pinned.keyHits[0].depth).toBeNull()
  })
})

describe('scoreLoreEntries — probability multiplier', () => {
  it('halves the seed score at probability 50', () => {
    const books = [
      book('B', [
        mkEntry({ keys: ['a'], content: '', comment: 'full', probability: 100 }),
        mkEntry({ keys: ['b'], content: '', comment: 'half', probability: 50 })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'a b')], '', params())
    const full = row(rows, 'full')
    const half = row(rows, 'half')
    expect(half.probabilityFactor).toBe(0.5)
    expect(half.seedScore).toBeCloseTo(full.seedScore / 2, 4)
  })
})

describe('scoreLoreEntries — selective hard gate', () => {
  it('disqualifies a selective entry with no secondary match, and blocks it seeding/receiving', () => {
    const books = [
      book('B', [
        mkEntry({
          keys: ['k'],
          secondary_keys: ['absent'],
          selective: true,
          content: 'names neighbor',
          comment: 'S'
        }),
        // Would-be neighbor whose key S's content names — must NOT get a link bonus from disqualified S.
        mkEntry({ keys: ['neighbor'], content: '', comment: 'N' }),
        // A donor whose content names S's key — S must NOT receive a link bonus either.
        mkEntry({ keys: ['donor'], content: 'mentions k', comment: 'D' })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'k donor')], '', params())
    const s = row(rows, 'S')
    expect(s.disqualified).toBe('secondary')
    expect(s.fired).toBe(false)
    expect(s.score).toBe(0)
    expect(s.linkBonus).toBe(0)
    // N has zero direct evidence and its only potential donor (S) is disqualified → not lifted.
    const n = row(rows, 'N')
    expect(n.score).toBe(0)
    expect(n.fired).toBe(false)
  })
})

describe('scoreLoreEntries — one-hop spreading activation', () => {
  it('lifts a zero-evidence neighbor into the ranking with the correct linkFrom', () => {
    const books = [
      book('B', [
        mkEntry({ keys: ['alpha'], content: 'the city of Zephyr', comment: 'A' }),
        mkEntry({ keys: ['Zephyr'], content: '', comment: 'B' })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'alpha here')], '', params())
    const a = row(rows, 'A')
    const b = row(rows, 'B')
    expect(b.seedScore).toBe(0)
    expect(b.linkBonus).toBeGreaterThan(0)
    expect(b.score).toBe(b.linkBonus)
    expect(b.linkFrom).toBe('A')
    expect(b.linkBonus).toBeLessThan(a.score) // hopDecay < 1
    expect(b.fired).toBe(true)
  })

  it('does not propagate past one hop', () => {
    // A (seed) → B (link) → C should get NOTHING (C only reachable via B, one hop only).
    const books = [
      book('B', [
        mkEntry({ keys: ['alpha'], content: 'to bravo', comment: 'A' }),
        mkEntry({ keys: ['bravo'], content: 'to charlie', comment: 'B' }),
        mkEntry({ keys: ['charlie'], content: '', comment: 'C' })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'alpha')], '', params())
    expect(row(rows, 'B').linkBonus).toBeGreaterThan(0)
    expect(row(rows, 'C').score).toBe(0)
  })
})

describe('scoreLoreEntries — recursion flags suppress edges', () => {
  it('prevent_recursion on the donor blocks the outbound edge', () => {
    const books = [
      book('B', [
        mkEntry({ keys: ['alpha'], content: 'names target', comment: 'A', prevent_recursion: true }),
        mkEntry({ keys: ['target'], content: '', comment: 'T' })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'alpha')], '', params())
    expect(row(rows, 'T').score).toBe(0)
  })

  it('exclude_recursion on the receiver blocks the inbound edge', () => {
    const books = [
      book('B', [
        mkEntry({ keys: ['alpha'], content: 'names target', comment: 'A' }),
        mkEntry({ keys: ['target'], content: '', comment: 'T', exclude_recursion: true })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'alpha')], '', params())
    expect(row(rows, 'T').score).toBe(0)
  })
})

describe('scoreLoreEntries — constant bypass', () => {
  it('constants fire without consuming a top-K slot', () => {
    const books = [
      book('B', [
        mkEntry({ content: 'ever-present note', constant: true, comment: 'K' }),
        mkEntry({ keys: ['apple'], content: '', comment: 'A', insertion_order: 10 }),
        mkEntry({ keys: ['mango'], content: '', comment: 'B', insertion_order: 20 })
      ])
    ]
    // Both A and B have identical evidence (df=1, depth 0); A's insertion_order (10) < B's (20) → A wins.
    const rows = scoreLoreEntries(books, [seg(0, 'apple mango')], '', params({ maxK: 1 }))
    expect(rows[0].comment).toBe('K') // constants first
    expect(row(rows, 'K').fired).toBe(true)
    expect(row(rows, 'K').constant).toBe(true)
    expect(row(rows, 'A').fired).toBe(true) // the constant did not eat the top-K=1 slot
    expect(row(rows, 'B').fired).toBe(false)
  })
})

describe('scoreLoreEntries — top-K tie-break', () => {
  it('breaks equal scores by insertion_order then bookName then index', () => {
    // Two entries with identical evidence (same idf via distinct df=1 keys) and equal recency.
    const books = [
      book('B', [
        mkEntry({ keys: ['p'], content: '', comment: 'later', insertion_order: 50 }),
        mkEntry({ keys: ['q'], content: '', comment: 'earlier', insertion_order: 10 })
      ])
    ]
    const rows = scoreLoreEntries(books, [seg(0, 'p q')], '', params({ maxK: 1 }))
    expect(row(rows, 'later').score).toBe(row(rows, 'earlier').score) // equal scores
    expect(row(rows, 'earlier').fired).toBe(true) // lower insertion_order wins the slot
    expect(row(rows, 'later').fired).toBe(false)
  })
})

describe('scoreLoreEntries — regex key parity', () => {
  it('a /pattern/i key matches case-insensitively via the shared helper', () => {
    const books = [book('B', [mkEntry({ keys: ['/fire/i'], content: '', comment: 'R' })])]
    const rows = scoreLoreEntries(books, [seg(0, 'A great FIRE burns')], '', params())
    const r = row(rows, 'R')
    expect(r.score).toBeGreaterThan(0)
    expect(r.keyHits[0].key).toBe('/fire/i')
  })
})

describe('scoreLoreEntries — adaptive selection (minScore floor + relCut)', () => {
  // A deterministic score ladder: 5 entries with unique keys (df=1 ⇒ equal idf = ln(1+5) = 1.7918),
  // each matched at a distinct depth so score = idf · 0.6**depth:
  //   L0 1.7918 · L1 1.0751 · L2 0.6450 · L3 0.3870 · L4 0.2322   (topScore = 1.7918)
  const ladderBook = (): Array<{ name: string; lorebook: Lorebook }> => [
    book(
      'L',
      [0, 1, 2, 3, 4].map((d) => mkEntry({ keys: [`k${d}`], content: '', comment: `L${d}` }))
    )
  ]
  const ladderSegs = [0, 1, 2, 3, 4].map((d) => seg(d, `k${d}`))
  const firedComments = (rows: ReturnType<typeof scoreLoreEntries>): string[] =>
    rows.filter((r) => r.fired && !r.constant).map((r) => r.comment)

  it('relCut=0 + minScore=0 reproduces the old fixed-K selection (top maxK fire)', () => {
    const rows = scoreLoreEntries(ladderBook(), ladderSegs, '', params({ maxK: 2, minScore: 0, relCut: 0 }))
    expect(firedComments(rows)).toEqual(['L0', 'L1'])
    // The ranked-but-cut rows are all capped.
    expect(row(rows, 'L2').cutBy).toBe('cap')
    expect(row(rows, 'L4').cutBy).toBe('cap')
  })

  it('minScore floors weak entries even inside a free quota, with cutBy="floor"', () => {
    // maxK=5 (no cap), relCut=0. minScore=0.3 floors only L4 (0.2322 < 0.3).
    const rows = scoreLoreEntries(ladderBook(), ladderSegs, '', params({ maxK: 5, minScore: 0.3, relCut: 0 }))
    expect(firedComments(rows)).toEqual(['L0', 'L1', 'L2', 'L3'])
    expect(row(rows, 'L4').fired).toBe(false)
    expect(row(rows, 'L4').cutBy).toBe('floor')
  })

  it('relCut fires fewer on a skewed distribution', () => {
    // relFloor = 0.5 · 1.7918 = 0.8959 → only L0, L1 clear it; L2..L4 are cut.
    const rows = scoreLoreEntries(ladderBook(), ladderSegs, '', params({ maxK: 5, minScore: 0, relCut: 0.5 }))
    expect(firedComments(rows)).toEqual(['L0', 'L1'])
    expect(row(rows, 'L2').cutBy).toBe('cut')
    expect(row(rows, 'L3').cutBy).toBe('cut')
  })

  it('relCut leaves a flat distribution firing up to maxK', () => {
    // All five keys matched at depth 0 → equal top scores; relCut can cut nothing (all == topScore).
    const flatSegs = [seg(0, 'k0 k1 k2 k3 k4')]
    const rows = scoreLoreEntries(ladderBook(), flatSegs, '', params({ maxK: 5, minScore: 0, relCut: 0.5 }))
    expect(firedComments(rows).length).toBe(5)
  })

  it('fires nothing when topScore < minScore (thin evidence → zero)', () => {
    const rows = scoreLoreEntries(ladderBook(), ladderSegs, '', params({ maxK: 5, minScore: 2.0, relCut: 0 }))
    expect(firedComments(rows)).toEqual([])
    expect(row(rows, 'L0').cutBy).toBe('floor')
  })

  it('reports cutBy in floor→cut→cap priority across one run', () => {
    // maxK=2, minScore=0.3, relCut=0.35 (relFloor = 0.6271):
    //   L0,L1 fire · L2 (0.6450 ≥ relFloor, passes floor+cut, but quota full) → cap
    //   L3 (0.3870 ≥ min, < relFloor) → cut · L4 (0.2322 < min) → floor
    const rows = scoreLoreEntries(ladderBook(), ladderSegs, '', params({ maxK: 2, minScore: 0.3, relCut: 0.35 }))
    expect(firedComments(rows)).toEqual(['L0', 'L1'])
    expect(row(rows, 'L2').cutBy).toBe('cap')
    expect(row(rows, 'L3').cutBy).toBe('cut')
    expect(row(rows, 'L4').cutBy).toBe('floor')
    // Fired rows carry no cutBy.
    expect(row(rows, 'L0').cutBy).toBeUndefined()
  })

  it('is deterministic under the new selection', () => {
    const p = params({ maxK: 3, minScore: 0.3, relCut: 0.35 })
    const a = scoreLoreEntries(ladderBook(), ladderSegs, '', p)
    const b = scoreLoreEntries(ladderBook(), ladderSegs, '', p)
    expect(a).toEqual(b)
  })
})
