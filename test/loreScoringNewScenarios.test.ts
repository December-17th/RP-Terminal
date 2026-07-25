import { describe, it, expect } from 'vitest'
import { STRUCTURAL_SCENARIOS, scenario } from './fixtures/loreScoring/scenarios'
import type { Scenario } from './fixtures/loreScoring/scenarios'
import { evaluate, microScorer } from './fixtures/loreScoring/metrics'
import { scoreLoreEntries } from '../src/main/services/loreScoring'
import { DEFAULT_SCORING_PARAMS } from '../src/shared/retrievalTrace'
import type { ScoringParams } from '../src/shared/retrievalTrace'

/**
 * Behavioral tests for the four STRUCTURAL scenario families added 2026-07-24
 * (test/fixtures/loreScoring/scenarios.ts → STRUCTURAL_SCENARIOS). They exist because the previous
 * 23-scenario suite could not evaluate a retrieval change: baseline micro-recall was exactly 1.000
 * (no headroom), depth 0 was mis-modeled, and no book was large enough for maxK to bind.
 *
 * These assertions pin the DESIGNED behavior of each family, not a tuning target — each is expressed as
 * a mechanism ("does not fire at these params, fires at actionBoost 3") rather than as an aggregate floor.
 *
 * 2026-07-24: the defaults moved to actionBoost 2 / relCut 0.20 / linkCap 4. Two families here measured
 * the very defects that change fixes (the topic-pivot cut and the hub link flood), so those mechanisms
 * are now asserted against the explicit `LEGACY_PARAMS` below, with a companion test pinning the improved
 * behavior at the adopted defaults. The aggregate floors live in loreScoringScenarios.test.ts.
 */

const byName = (name: string): Scenario => scenario(name)

/** The pre-2026-07-24 defaults. Several designed mechanisms below (the topic-pivot flip points, the hub
 *  flood) were authored against them, and they are still the reference point the adopted defaults are
 *  measured against — so they are pinned explicitly rather than tracking DEFAULT_SCORING_PARAMS. */
const LEGACY_PARAMS: ScoringParams = {
  ...DEFAULT_SCORING_PARAMS,
  actionBoost: 1,
  relCut: 0.35,
  linkCap: 0
}

/** Score of one entry, looked up by its `comment` label, at the given param overrides. */
const scoreOf = (s: Scenario, comment: string, over: Partial<typeof DEFAULT_SCORING_PARAMS> = {}) => {
  const rows = scoreLoreEntries(s.books, s.segments, s.pinText, { ...DEFAULT_SCORING_PARAMS, ...over })
  const row = rows.find((r) => r.comment === comment)
  if (!row) throw new Error(`no entry labelled ${comment} in ${s.name}`)
  return row
}

describe('structural scenarios — registration', () => {
  it('adds exactly 8 scenarios across the four intended families', () => {
    expect(STRUCTURAL_SCENARIOS).toHaveLength(8)
    const byCategory = STRUCTURAL_SCENARIOS.reduce<Record<string, string[]>>((acc, s) => {
      ;(acc[s.category] ??= []).push(s.name)
      return acc
    }, {})
    expect(Object.keys(byCategory).sort()).toEqual([
      'generickey',
      'pivot',
      'proportions',
      'scale'
    ])
    for (const names of Object.values(byCategory)) expect(names).toHaveLength(2)
  })

  it('gives the suite real recall headroom at the defaults (micro-recall strictly below 1)', () => {
    // The defect these families were authored to fix: the old suite's baseline micro-recall was exactly
    // 1.000, so no parameter change could ever GAIN recall — only lose precision.
    const micro = microScorer(STRUCTURAL_SCENARIOS, DEFAULT_SCORING_PARAMS)
    expect(micro.recall).toBeLessThan(1)
    expect(micro.recall).toBeGreaterThan(0)
  })
})

describe('structural scenarios — family 1: topic-pivot', () => {
  // A short depth-0 action names a subject absent from the whole depth-1..3 transcript. The pivot entry
  // is reachable ONLY through that depth-0 evidence, and at the defaults it loses to the relative cut.
  const cases: Array<{ name: string; label: string; firesAtBoost2: boolean }> = [
    // Harrowgate: pivot 2.708 vs relCut floor 0.35 × 11.620 = 4.067 → flips between actionBoost 1 and 2.
    { name: 'topic-pivot-harrowgate-writ', label: 'SablewingWrit-PIVOT', firesAtBoost2: true },
    // Tideholm: the pivot key is df-damped (df=4 → idf 1.705) vs floor 0.35 × 12.672 = 4.435 → needs 3.
    { name: 'topic-pivot-tideholm-charter', label: 'GullwingCharter-PIVOT', firesAtBoost2: false }
  ]

  // The flip points above are stated against the LEGACY relCut 0.35 floor they were computed from, so
  // they are asserted at LEGACY_PARAMS. Updated 2026-07-24: they used to run at DEFAULT_SCORING_PARAMS,
  // which then carried actionBoost 1 / relCut 0.35. The adopted defaults deliberately fire both pivots
  // (that recovered pivot-recall is the point of the change) — pinned by the last test in this block.
  it.each(cases)('$name: the pivot entry does NOT fire at the LEGACY params', ({ name, label }) => {
    const s = byName(name)
    const row = scoreOf(s, label, LEGACY_PARAMS)
    expect(row.score).toBeGreaterThan(0) // it HAS evidence …
    expect(row.fired).toBe(false) // … and still loses
    expect(row.cutBy).toBe('cut') // to the RELATIVE cut, not the floor or the cap
  })

  it.each(cases)('$name: the pivot entry DOES fire at actionBoost 3 (LEGACY relCut)', ({ name, label }) => {
    const row = scoreOf(byName(name), label, { ...LEGACY_PARAMS, actionBoost: 3 })
    expect(row.fired).toBe(true)
    expect(row.cutBy).toBeUndefined()
  })

  it.each(cases)('$name: flips exactly where documented at actionBoost 2 (LEGACY relCut)', ({ name, label, firesAtBoost2 }) => {
    expect(scoreOf(byName(name), label, { ...LEGACY_PARAMS, actionBoost: 2 }).fired).toBe(firesAtBoost2)
  })

  it.each(cases)('$name: the pivot entry FIRES at the adopted 2026-07-24 defaults', ({ name, label }) => {
    // actionBoost 2 doubles the depth-0 pivot evidence while relCut 0.20 lowers the bar it must clear:
    // harrowgate 5.416 and tideholm 3.409 both clear their (now lower) relative cut. Recall goes 2/3 → 3/3
    // on both scenarios with hard-negative violations still 0.
    const row = scoreOf(byName(name), label)
    expect(row.fired).toBe(true)
    expect(row.cutBy).toBeUndefined()
    const r = evaluate(byName(name), DEFAULT_SCORING_PARAMS)
    expect(r.recall).toBe(1)
    expect(r.hardNegativeViolations).toBe(0)
  })

  it.each(cases)('$name: raising actionBoost never fires a hard negative', ({ name }) => {
    const s = byName(name)
    for (const actionBoost of [1, 2, 3]) {
      const r = evaluate(s, { ...DEFAULT_SCORING_PARAMS, actionBoost })
      expect(r.hardNegativeViolations, `${name} @actionBoost=${actionBoost}`).toBe(0)
    }
  })

  it('the pivot subject appears in the depth-0 action and NOWHERE in the transcript', () => {
    for (const { name, label } of cases) {
      const s = byName(name)
      const pivotKey = s.books[0].lorebook.entries.find((e) => e.comment === label)!.keys[0].toLowerCase()
      const action = s.segments.find((seg) => seg.depth === 0)!
      expect(action.text.toLowerCase(), name).toContain(pivotKey)
      for (const deeper of s.segments.filter((seg) => seg.depth > 0)) {
        expect(deeper.text.toLowerCase(), `${name} depth ${deeper.depth}`).not.toContain(pivotKey)
      }
    }
  })
})

describe('structural scenarios — family 2: realistic-proportions', () => {
  const names = ['realistic-proportions-riverwatch', 'realistic-proportions-emberlane']

  it.each(names)('%s: a short depth-0 action competes with 800+ char depth-1/2/3 prose', (name) => {
    const s = byName(name)
    const depths = s.segments.map((seg) => seg.depth)
    expect(depths).toEqual([0, 1, 2, 3])
    const action = s.segments[0]
    expect(action.text.length).toBeGreaterThanOrEqual(40)
    expect(action.text.length).toBeLessThanOrEqual(60)
    for (const deeper of s.segments.slice(1)) {
      expect(deeper.text.length, `${name} depth ${deeper.depth}`).toBeGreaterThanOrEqual(800)
    }
    // The transcript must dwarf the action, as it does in the real product (~40 vs ~9,700 chars).
    const transcript = s.segments.slice(1).reduce((n, seg) => n + seg.text.length, 0)
    expect(transcript / action.text.length).toBeGreaterThan(40)
  })

  it.each(names)('%s: depth weighting is measurable — strictly decreasing scores by depth', (name) => {
    const s = byName(name)
    const rows = scoreLoreEntries(s.books, s.segments, s.pinText, DEFAULT_SCORING_PARAMS)
    const at = (comment: string): number => rows.find((r) => r.comment === comment)!.score
    // Two-key scene entries at depth 1 out-score their two-key twins at depth 2, which out-score the
    // one-key entries restated only at depth 3. Nothing here is uniform.
    const d1 = name.includes('riverwatch') ? at('Ombra') : at('Sennah')
    const d2 = name.includes('riverwatch') ? at('Vell') : at('Coldcellar')
    const d3 = name.includes('riverwatch') ? at('Ashenmoor-HN') : at('TallowgateLevy-HN')
    expect(d1).toBeGreaterThan(d2)
    expect(d2).toBeGreaterThan(d3)
    expect(d3).toBeGreaterThan(0)
  })

  it('riverwatch fires every relevant entry with no hard-negative violations', () => {
    const r = evaluate(byName('realistic-proportions-riverwatch'), DEFAULT_SCORING_PARAMS)
    expect(r.recall).toBe(1)
    expect(r.hardNegativeViolations).toBe(0)
  })

  it('emberlane leaves a live depth-3 compact unretrieved — the designed headroom', () => {
    const s = byName('realistic-proportions-emberlane')
    const row = scoreOf(s, 'VetchCompact-DEEP-RELEVANT')
    expect(row.fired).toBe(false)
    expect(row.cutBy).toBe('cut')
    const r = evaluate(s, DEFAULT_SCORING_PARAMS)
    expect(r.recall).toBeLessThan(1)
    expect(r.hardNegativeViolations).toBe(0)
  })
})

describe('structural scenarios — family 3: book-at-scale', () => {
  const counts: Array<[string, string, number]> = [
    ['book-at-scale-archive', 'RidgewayArchive', 174],
    ['book-at-scale-hub', 'LedgerhallRegistry', 183]
  ]

  it.each(counts)('%s holds %s enabled entries (>=150) so maxK binds', (name, bookName, expected) => {
    const s = byName(name)
    const entries = s.books.find((b) => b.name === bookName)!.lorebook.entries
    expect(entries).toHaveLength(expected)
    expect(entries.every((e) => e.enabled)).toBe(true)
    expect(entries.length).toBeGreaterThanOrEqual(150)
  })

  it('archive: maxK=12 is the binding constraint — 2 of 14 relevant entries are cut by `cap`', () => {
    const s = byName('book-at-scale-archive')
    const r = evaluate(s, DEFAULT_SCORING_PARAMS)
    expect(s.relevant).toHaveLength(14)
    expect(r.firedCount).toBe(DEFAULT_SCORING_PARAMS.maxK)
    expect(r.tp).toBe(12)
    expect(r.recall).toBeCloseTo(12 / 14, 6)
    expect(r.hardNegativeViolations).toBe(0)
    // Raising the cap alone recovers the two lost entries — proof the cap, not the score, is the limit.
    const wider = evaluate(s, { ...DEFAULT_SCORING_PARAMS, maxK: 16 })
    expect(wider.recall).toBe(1)
    expect(wider.hardNegativeViolations).toBe(0)
  })

  it('archive: the high-df generic key is floored, not merely out-ranked', () => {
    // df('the outer vault') = 150 filler bodies + 10 declaring entries = 160 of N=174 → idf 0.736.
    const row = scoreOf(byName('book-at-scale-archive'), 'OuterVault-HN-0')
    expect(row.cutBy).toBe('floor')
    expect(row.score).toBeLessThan(DEFAULT_SCORING_PARAMS.minScore)
    expect(row.linkBonus).toBe(0)
  })

  it('hub: one entry naming 22 other entries` keys floods the cap at the LEGACY (uncapped) params', () => {
    const s = byName('book-at-scale-hub')
    const hubEntry = s.books[0].lorebook.entries.find((e) => e.comment === 'LedgerhallHub')!
    const named = s.books[0].lorebook.entries.filter(
      (e) => e.comment.startsWith('Annex-HN-') && hubEntry.content.includes(e.keys[0])
    )
    expect(named.length).toBeGreaterThanOrEqual(20) // a REAL hub, not a token two-entry link

    // Asserted at LEGACY_PARAMS since 2026-07-24 (linkCap 0 = uncapped propagation): this flood is the
    // defect the adopted linkCap 4 default was chosen to fix, so it can only be observed with the cap off.
    const r = evaluate(s, LEGACY_PARAMS)
    expect(r.firedCount).toBe(LEGACY_PARAMS.maxK)
    expect(r.hardNegativeViolations).toBe(11) // hub + 11 zero-evidence passengers spend the whole cap
    expect(r.recall).toBeCloseTo(1 / 11, 6)
  })

  it('hub: the adopted linkCap default drains the flood — full recall, zero violations', () => {
    // A capped entry can borrow at most linkCap × its OWN seed; the annexes have seed 0, so they borrow
    // nothing and the cap is spent on genuinely-evidenced entries instead. Measured 2026-07-24: recall
    // 0.091 → 1.000, violations 11 → 0. This single scenario is the headline gain of linkCap 4.
    for (const p of [DEFAULT_SCORING_PARAMS, { ...DEFAULT_SCORING_PARAMS, linkCap: 1 }]) {
      const r = evaluate(byName('book-at-scale-hub'), p)
      expect(r.recall).toBe(1)
      expect(r.hardNegativeViolations).toBe(0)
      expect(r.firedCount).toBe(11)
    }
  })
})

describe('structural scenarios — family 4: generic-key-distractor', () => {
  it('settlement: df=40 of N=42 → the generic entries lose to the relative cut', () => {
    const s = byName('generic-key-settlement')
    const entries = s.books[0].lorebook.entries
    expect(entries).toHaveLength(42)
    // Verify the INTENDED df empirically: entries that declare 'settlement' or name it in their body.
    const df = entries.filter(
      (e) => e.keys.includes('settlement') || e.content.toLowerCase().includes('settlement')
    ).length
    expect(df).toBe(40)

    const generic = scoreOf(s, 'Settlement-HN-0')
    const topical = scoreOf(s, 'Cistern-TOPICAL')
    // Both hit at depth 0 in the SAME action text; only idf separates them.
    expect(generic.score).toBeGreaterThan(DEFAULT_SCORING_PARAMS.minScore) // the floor cannot stop it
    expect(generic.cutBy).toBe('cut') // the relative cut does
    expect(generic.score).toBeLessThan(topical.score / 4)
    expect(topical.fired).toBe(true)

    const r = evaluate(s, DEFAULT_SCORING_PARAMS)
    expect(r.hardNegativeViolations).toBe(0)
    expect(r.recall).toBe(1)
  })

  it('guardian: df=40 of N=62 → the generic entries fall below the min-score floor', () => {
    const s = byName('generic-key-guardian')
    const entries = s.books[0].lorebook.entries
    expect(entries).toHaveLength(62)
    const df = entries.filter(
      (e) => e.keys.includes('guardian') || e.content.toLowerCase().includes('guardian')
    ).length
    expect(df).toBe(40)

    const generic = scoreOf(s, 'Guardian-HN-0')
    expect(generic.cutBy).toBe('floor')
    expect(generic.score).toBeLessThan(DEFAULT_SCORING_PARAMS.minScore)
    expect(generic.linkBonus).toBe(0) // no self-donation between the ten generic entries

    const r = evaluate(s, DEFAULT_SCORING_PARAMS)
    expect(r.hardNegativeViolations).toBe(0)
    expect(r.recall).toBe(1)
  })

  it.each(['generic-key-settlement', 'generic-key-guardian'])(
    '%s: the low-df topical entry out-scores every generic distractor',
    (name) => {
      const s = byName(name)
      const rows = scoreLoreEntries(s.books, s.segments, s.pinText, DEFAULT_SCORING_PARAMS)
      const topical = rows.filter((r) => r.comment.endsWith('-TOPICAL'))
      const generic = rows.filter((r) => r.comment.includes('-HN-'))
      expect(topical.length).toBe(2)
      expect(generic.length).toBeGreaterThanOrEqual(8)
      const worstTopical = Math.min(...topical.map((r) => r.score))
      const bestGeneric = Math.max(...generic.map((r) => r.score))
      expect(worstTopical).toBeGreaterThan(bestGeneric)
    }
  )
})
