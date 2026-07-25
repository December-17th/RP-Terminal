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
// actionBoost 1 / linkCap 0 are pinned here for the same reason (2026-07-24): the adopted defaults moved
// to actionBoost 2 / linkCap 4, which would silently rescale every depth-0 hit and zero every link bonus
// into a zero-seed entry in these mechanic fixtures. The adopted values have their own characterization
// tests in the final block; each knob also keeps its own dedicated test there.
const params = (o: Partial<ScoringParams> = {}): ScoringParams => ({
  ...DEFAULT_SCORING_PARAMS,
  minScore: 0,
  relCut: 0,
  actionBoost: 1,
  linkCap: 0,
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

describe('scoreLoreEntries — persistence bonus', () => {
  // One fired entry (index 0, rowKey 'B::0') plus a zero-evidence entry (index 1, 'B::1').
  const twoBook = (): Array<{ name: string; lorebook: Lorebook }> => [
    book('B', [
      mkEntry({ keys: ['ember'], content: '', comment: 'real' }),
      mkEntry({ keys: ['ghost'], content: '', comment: 'ghost' })
    ])
  ]
  const twoSegs = [seg(0, 'the ember glows')] // 'ghost' never appears → zero evidence

  it('(a) empty prevFired OR persistBoost=1 is deeply-equal to the no-prevFired baseline (no flags)', () => {
    const p = params()
    const baseline = scoreLoreEntries(twoBook(), twoSegs, '', p)
    const emptySet = scoreLoreEntries(twoBook(), twoSegs, '', p, new Set())
    // prevFired names the fired entry, but persistBoost=1 makes the multiplier a no-op.
    const boost1 = scoreLoreEntries(twoBook(), twoSegs, '', params({ persistBoost: 1 }), new Set(['B::0']))
    expect(emptySet).toEqual(baseline)
    expect(boost1).toEqual(baseline)
    for (const rows of [baseline, emptySet, boost1])
      for (const r of rows) expect(r.persisted).toBeUndefined()
  })

  it('(b) persistBoost multiplies the final score and sets persisted on the fired entry', () => {
    const off = scoreLoreEntries(twoBook(), twoSegs, '', params(), new Set())
    const on = scoreLoreEntries(twoBook(), twoSegs, '', params({ persistBoost: 2 }), new Set(['B::0']))
    const base = row(off, 'real').score
    const boosted = row(on, 'real')
    expect(base).toBeGreaterThan(0)
    expect(boosted.score).toBeCloseTo(base * 2, 4)
    expect(boosted.persisted).toBe(true)
    expect(boosted.fired).toBe(true)
    // The non-persisted entry (ghost) is untouched and carries no flag.
    expect(row(on, 'ghost').persisted).toBeUndefined()
  })

  it('(c) a zero-evidence prevFired entry stays score 0, never fires, and carries no flag', () => {
    // 'B::1' (ghost) fired last floor but has NO current evidence — persistence must not resurrect it.
    const rows = scoreLoreEntries(twoBook(), twoSegs, '', params({ persistBoost: 2 }), new Set(['B::1']))
    const ghost = row(rows, 'ghost')
    expect(ghost.score).toBe(0)
    expect(ghost.fired).toBe(false)
    expect(ghost.persisted).toBeUndefined()
  })

  it('(d) the boost lets a prevFired entry clear a minScore floor it would otherwise fail', () => {
    // One entry, key at depth 1: idf = ln(2) ≈ 0.693, base ≈ 0.693·0.6 = 0.4158 < minScore 0.5.
    const oneBook = (): Array<{ name: string; lorebook: Lorebook }> => [
      book('B', [mkEntry({ keys: ['zephyrite'], content: '', comment: 'lone' })])
    ]
    const segs = [seg(1, 'a shard of zephyrite hums in the dark')]
    const off = scoreLoreEntries(oneBook(), segs, '', params({ minScore: 0.5, relCut: 0, persistBoost: 2 }), new Set())
    const on = scoreLoreEntries(oneBook(), segs, '', params({ minScore: 0.5, relCut: 0, persistBoost: 2 }), new Set(['B::0']))
    expect(row(off, 'lone').fired).toBe(false) // below the floor without the boost
    expect(row(off, 'lone').cutBy).toBe('floor')
    const lifted = row(on, 'lone')
    expect(lifted.fired).toBe(true) // 0.4158 · 2 = 0.8316 ≥ 0.5
    expect(lifted.persisted).toBe(true)
  })

  it('(e) is deterministic with prevFired + a boost', () => {
    const p = params({ persistBoost: 1.5 })
    const prev = new Set(['B::0'])
    const a = scoreLoreEntries(twoBook(), twoSegs, '', p, prev)
    const b = scoreLoreEntries(twoBook(), twoSegs, '', p, prev)
    expect(a).toEqual(b)
  })
})

describe('scoreLoreEntries — actionBoost / linkCap / keyDamp / relCutBasis', () => {
  // One fixture exercising every path the four knobs touch: a depth-0 hit, a depth-1 hit, a pin-only
  // hit, a three-key entry, a link-only entry (its key appears in 'action's content), and a persisted
  // entry. N = 6, every key has df = 1 (idf = ln 7) except 'dawn' (declared by 'linked', present in
  // 'action's content ⇒ df = 2), which contributes nothing since it never appears in the scan text.
  const LN7 = Math.log(7)
  const charBook = (): Array<{ name: string; lorebook: Lorebook }> => [
    book('B', [
      mkEntry({ keys: ['ember'], content: 'the ember of dawn', comment: 'action' }), // B::0, depth 0
      mkEntry({ keys: ['relic'], content: '', comment: 'recent' }), // B::1, depth 1
      mkEntry({ keys: ['glyph'], content: '', comment: 'pinned' }), // B::2, pin only
      mkEntry({ keys: ['sigil', 'ward', 'oath'], content: '', comment: 'multi' }), // B::3, 3 keys @ d0
      mkEntry({ keys: ['dawn'], content: '', comment: 'linked' }), // B::4, one-hop link only
      mkEntry({ keys: ['hollow'], content: '', comment: 'held' }) // B::5, depth 1 + prevFired
    ])
  ]
  const charSegs = [seg(0, 'ember sigil ward oath'), seg(1, 'relic hollow')]
  const charPin = '\n[PINS]\nglyph'
  const charPrev = new Set(['B::5'])
  const runChar = (o: Partial<ScoringParams> = {}): ReturnType<typeof scoreLoreEntries> =>
    scoreLoreEntries(
      charBook(),
      charSegs,
      charPin,
      { ...DEFAULT_SCORING_PARAMS, ...o } as ScoringParams,
      charPrev
    )

  // The pre-2026-07-24 defaults. The scorer must still be able to reproduce them EXACTLY on demand —
  // that safety property is what the legacy characterization below pins.
  const LEGACY_PARAMS: ScoringParams = {
    ...DEFAULT_SCORING_PARAMS,
    actionBoost: 1,
    relCut: 0.35,
    linkCap: 0
  }

  it('characterization (LEGACY): actionBoost 1 / relCut 0.35 / linkCap 0 reproduces the old behavior', () => {
    // Pinned explicitly since 2026-07-24: these three values are no longer the defaults, but the scorer
    // must still reproduce the old output byte-for-byte when they are passed in.
    const base = scoreLoreEntries(charBook(), charSegs, charPin, LEGACY_PARAMS, charPrev)

    // Hand-computed expected output (λ=0.6 hop=0.5 pin=2.5 persist=1.5 actionBoost=1, ranked desc):
    //   multi  3·ln7                     = 5.8377
    //   pinned ln7·2.5                   = 4.8648
    //   action ln7                       = 1.9459
    //   held   ln7·0.6·1.5               = 1.7513
    //   recent ln7·0.6                   = 1.1675
    //   linked 0 + 0.5·ln7 (from action) = 0.9730   (uncapped: a zero-seed entry still borrows)
    expect(base.map((r) => r.comment)).toEqual([
      'multi',
      'pinned',
      'action',
      'held',
      'recent',
      'linked'
    ])
    expect(base.map((r) => r.score)).toEqual([5.8377, 4.8648, 1.9459, 1.7513, 1.1675, 0.973])
    expect(row(base, 'action').score).toBeCloseTo(LN7, 4)
    expect(row(base, 'linked').linkBonus).toBeCloseTo(0.5 * LN7, 4)
    expect(row(base, 'linked').linkFrom).toBe('action')
    expect(row(base, 'held').persisted).toBe(true)
    // relFloor = 0.35 · 5.8377 = 2.0432 ⇒ only the top two clear it.
    expect(base.filter((r) => r.fired).map((r) => r.comment)).toEqual(['multi', 'pinned'])
  })

  it('characterization (ADOPTED 2026-07-24): actionBoost 2 / relCut 0.20 / linkCap 4 at the defaults', () => {
    const base = scoreLoreEntries(charBook(), charSegs, charPin, DEFAULT_SCORING_PARAMS, charPrev)

    // Hand-computed expected output at the ADOPTED defaults (λ=0.6 hop=0.5 pin=2.5 persist=1.5,
    // actionBoost=2 linkCap=4 relCut=0.20), ranked desc:
    //   multi  3·ln7·2                       = 6·ln7 = 11.6755   (three depth-0 keys)
    //   pinned ln7·2.5                       =         4.8648    (pin weight, untouched by actionBoost)
    //   action ln7·2                         =         3.8918
    //   held   ln7·0.6·1.5                   =         1.7513    (depth 1 + persistence)
    //   recent ln7·0.6                       =         1.1675
    //   linked min(0.5·3.8918, 4·0)          =         0         (capped: zero own seed ⇒ zero bonus)
    expect(base.map((r) => r.comment)).toEqual([
      'multi',
      'pinned',
      'action',
      'held',
      'recent',
      'linked'
    ])
    expect(base.map((r) => r.score)).toEqual([11.6755, 4.8648, 3.8918, 1.7513, 1.1675, 0])
    expect(row(base, 'action').score).toBeCloseTo(2 * LN7, 4)
    expect(row(base, 'multi').score).toBeCloseTo(6 * LN7, 4)
    // linkCap 4 × the receiver's own seed (0) ⇒ no bonus and no donor recorded (the accepted trade).
    expect(row(base, 'linked').linkBonus).toBe(0)
    expect(row(base, 'linked').linkFrom).toBeUndefined()
    expect(row(base, 'held').persisted).toBe(true)
    // relFloor = 0.20 · 11.6755 = 2.3351 ⇒ the top THREE clear it (the legacy 0.35 basis cleared two).
    expect(base.filter((r) => r.fired).map((r) => r.comment)).toEqual(['multi', 'pinned', 'action'])
  })

  it('actionBoost scales ONLY depth-0 hits (depth-1 and pin hits are untouched)', () => {
    // Baseline pinned at actionBoost 1 (the default moved to 2 on 2026-07-24), so the ×3 relation below
    // still measures the knob rather than the ratio between two boosted runs.
    const base = runChar({ actionBoost: 1 })
    const boosted = runChar({ actionBoost: 3 })
    expect(row(boosted, 'action').score).toBeCloseTo(3 * row(base, 'action').score, 4)
    expect(row(boosted, 'action').keyHits[0].weight).toBe(3)
    expect(row(boosted, 'multi').score).toBeCloseTo(9 * LN7, 4) // 3 keys × boost 3 (vs 3·ln7 at 1)
    // depth 1 and pin-only evidence keeps its old weight and score.
    expect(row(boosted, 'recent').score).toBe(row(base, 'recent').score)
    expect(row(boosted, 'recent').keyHits[0].weight).toBe(row(base, 'recent').keyHits[0].weight)
    expect(row(boosted, 'pinned').score).toBe(row(base, 'pinned').score)
    expect(row(boosted, 'pinned').keyHits[0].weight).toBe(2.5)
  })

  it('linkCap bounds the link bonus by the receiver own seed (zero seed ⇒ zero bonus, no linkFrom)', () => {
    // donor: depth-0 key, content naming both receivers' keys. 'empty' has no own evidence; 'small' has
    // a deep (weak) hit, so hopDecay·donorSeed exceeds its own seed and the cap binds.
    const capBook = (): Array<{ name: string; lorebook: Lorebook }> => [
      book('B', [
        mkEntry({ keys: ['blaze'], content: 'the void and the moss', comment: 'donor' }),
        mkEntry({ keys: ['void'], content: '', comment: 'empty' }),
        mkEntry({ keys: ['moss'], content: '', comment: 'small' })
      ])
    ]
    const capSegs = [seg(0, 'blaze'), seg(4, 'moss')]
    const uncapped = scoreLoreEntries(capBook(), capSegs, '', params())
    const capped = scoreLoreEntries(capBook(), capSegs, '', params({ linkCap: 1 }))

    // Uncapped (the default) still lends to a zero-seed entry.
    expect(row(uncapped, 'empty').linkBonus).toBeCloseTo(0.5 * row(uncapped, 'donor').seedScore, 4)
    expect(row(uncapped, 'empty').linkFrom).toBe('donor')

    const emptyCapped = row(capped, 'empty')
    expect(emptyCapped.linkBonus).toBe(0)
    expect(emptyCapped.linkFrom).toBeUndefined()
    expect(emptyCapped.score).toBe(0)
    expect(emptyCapped.fired).toBe(false)

    const smallCapped = row(capped, 'small')
    const raw = 0.5 * row(capped, 'donor').seedScore
    expect(smallCapped.linkBonus).toBeCloseTo(Math.min(raw, smallCapped.seedScore), 4)
    expect(smallCapped.linkBonus).toBe(smallCapped.seedScore) // the cap binds here
    expect(smallCapped.linkBonus).toBeLessThan(row(uncapped, 'small').linkBonus)
  })

  it('keyDamp discounts every key but the strongest (0 = strongest only, 0.5 = half the rest)', () => {
    // One entry, three keys at depths 0/1/2, probability 50. N = 1 ⇒ idf = ln 2 for each key.
    const dampBook = (): Array<{ name: string; lorebook: Lorebook }> => [
      book('B', [
        mkEntry({ keys: ['aaa', 'bbb', 'ccc'], content: '', comment: 'multi', probability: 50 })
      ])
    ]
    const dampSegs = [seg(0, 'aaa'), seg(1, 'bbb'), seg(2, 'ccc')]
    const idf = Math.log(2)
    const max = idf
    const sum = idf * (1 + 0.6 + 0.36)
    const at = (keyDamp: number): number =>
      row(scoreLoreEntries(dampBook(), dampSegs, '', params({ keyDamp })), 'multi').score

    expect(at(1)).toBeCloseTo(sum * 0.5, 4) // the default: plain sum
    expect(at(0)).toBeCloseTo(max * 0.5, 4) // strongest key only
    expect(at(0.5)).toBeCloseTo((max + 0.5 * (sum - max)) * 0.5, 4)
  })

  it("relCutBasis 'preBoost' measures the cut against the max PRE-boost score, not the boosted top", () => {
    // N = 4, every key df = 1 ⇒ idf = ln 5. 'held' (depth 1) is persisted with persistBoost 2, so it
    // ranks first on final score (1.9313) while 'loud' (depth 0) holds the max PRE-boost score (1.6094).
    const basisBook = (): Array<{ name: string; lorebook: Lorebook }> => [
      book('B', [
        mkEntry({ keys: ['anchor'], content: '', comment: 'held' }), // B::0, depth 1, prevFired
        mkEntry({ keys: ['blare'], content: '', comment: 'loud' }), // B::1, depth 0
        mkEntry({ keys: ['fresh'], content: '', comment: 'newcomer' }), // B::2, depth 2
        mkEntry({ keys: ['gloom'], content: '', comment: 'faint' }) // B::3, depth 3
      ])
    ]
    const basisSegs = [seg(0, 'blare'), seg(1, 'anchor'), seg(2, 'fresh'), seg(3, 'gloom')]
    const prev = new Set(['B::0'])
    const p = (relCutBasis: ScoringParams['relCutBasis']): ScoringParams =>
      params({ persistBoost: 2, relCut: 0.35, minScore: 0, relCutBasis })
    const onFinal = scoreLoreEntries(basisBook(), basisSegs, '', p('final'), prev)
    const onPre = scoreLoreEntries(basisBook(), basisSegs, '', p('preBoost'), prev)

    // 'final': floor = 0.35 · 1.9313 = 0.6760 ⇒ newcomer (0.5794) is cut by the persisted entry's boost.
    expect(row(onFinal, 'newcomer').fired).toBe(false)
    expect(row(onFinal, 'newcomer').cutBy).toBe('cut')
    // 'preBoost': floor = 0.35 · 1.6094 = 0.5633 ⇒ newcomer clears it.
    expect(row(onPre, 'newcomer').fired).toBe(true)
    // The basis is the MAX pre-boost score over ranked entries, not ranked[0]'s (0.9657): were it the
    // latter the floor would be 0.3380 and 'faint' (0.3477) would fire. It must stay cut.
    expect(row(onPre, 'faint').fired).toBe(false)
    expect(row(onPre, 'faint').cutBy).toBe('cut')
    // Ranking and the boosted top entry are unchanged by the basis.
    expect(onFinal.map((r) => r.comment)).toEqual(onPre.map((r) => r.comment))
    expect(onFinal.map((r) => r.score)).toEqual(onPre.map((r) => r.score))
    expect(row(onPre, 'held').fired).toBe(true)
    expect(row(onPre, 'loud').fired).toBe(true)
  })

  it('sanitizes bad knob values back to the sanitizer fallbacks (keyDamp clamps to [0,1])', () => {
    const bad = (o: Record<string, unknown>): ReturnType<typeof scoreLoreEntries> =>
      runChar(o as Partial<ScoringParams>)

    // Each fallback is compared against an EXPLICIT run at that fallback value rather than against
    // runChar(): since 2026-07-24 the sanitizer fallbacks (actionBoost 1, uncapped link) no longer
    // coincide with DEFAULT_SCORING_PARAMS (actionBoost 2, linkCap 4).
    for (const v of [NaN, -1, undefined]) {
      expect(bad({ actionBoost: v }), `actionBoost=${String(v)}`).toEqual(runChar({ actionBoost: 1 }))
      expect(bad({ linkCap: v }), `linkCap=${String(v)}`).toEqual(runChar({ linkCap: 0 }))
    }
    for (const v of [NaN, undefined, 5]) {
      expect(bad({ keyDamp: v }), `keyDamp=${String(v)}`).toEqual(runChar({ keyDamp: 1 })) // 5 clamps to 1
    }
    for (const v of ['garbage', undefined, '']) {
      expect(bad({ relCutBasis: v }), `relCutBasis=${String(v)}`).toEqual(
        runChar({ relCutBasis: 'final' })
      )
    }
    // The lower clamp is real: -3 behaves as 0, which genuinely changes the 3-key entry.
    expect(bad({ keyDamp: -3 })).toEqual(runChar({ keyDamp: 0 }))
    expect(runChar({ keyDamp: 0 })).not.toEqual(runChar())
  })
})
