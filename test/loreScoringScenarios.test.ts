import { describe, it, expect } from 'vitest'
import {
  SCENARIOS,
  ORIGINAL_SCENARIOS,
  NEW_SCENARIOS,
  scenario
} from './fixtures/loreScoring/scenarios'
import type { EntryRef } from './fixtures/loreScoring/scenarios'
import {
  evaluate,
  microScorer,
  microKeywordBaseline
} from './fixtures/loreScoring/metrics'
import { scoreLoreEntries } from '../src/main/services/loreScoring'
import { DEFAULT_SCORING_PARAMS } from '../src/shared/retrievalTrace'

/**
 * Regression tests for the deterministic lore scorer over the synthetic scenario suite
 * (test/fixtures/loreScoring). Runs at DEFAULT_SCORING_PARAMS (adaptive selection).
 *
 * The micro-F1 / recall FLOORS are computed over ORIGINAL_SCENARIOS only. The 2026-07-24 broad-evidence
 * scenarios carry 9–10 relevant entries each; they now reach full recall under the adopted maxK=12 default
 * (2026-07-24), so they are held in a SEPARATE block below rather than folded into the original-suite floor.
 * That block plus the persistence block document the wider cap and the persistence-bonus mechanics. See the
 * tuner (`npm run tune:lore`) and docs/lore-scoring-tuning-persist-2026-07-24.md.
 */

// Comment lookup on a scored run of one scenario (DEFAULT params).
const scoreByComment = (name: string): Map<string, number> => {
  const s = scenario(name)
  const rows = scoreLoreEntries(s.books, s.segments, s.pinText, DEFAULT_SCORING_PARAMS)
  return new Map(rows.map((r) => [r.comment, r.score]))
}

const refKey = (r: EntryRef): string => `${r.bookName}::${r.entryIndex}`

describe('lore scorer — synthetic scenario regression', () => {
  it('achieves a micro-F1 above a loose floor at the default params (original suite)', () => {
    // Floor computed over the ORIGINAL tuned suite — see the file header for why the new scenarios are
    // excluded here (they intentionally under-fire at maxK=4).
    const micro = microScorer(ORIGINAL_SCENARIOS, DEFAULT_SCORING_PARAMS)
    // At the adopted maxK=12/persistBoost=1.5 defaults (2026-07-24) F1 measures 0.899 and recall 1.0 on
    // the original suite; the wider cap trades a little precision for full recall. Floor set below measured.
    expect(micro.f1).toBeGreaterThanOrEqual(0.87)
    expect(micro.recall).toBeGreaterThanOrEqual(0.9)
  })

  it('fires nothing on the thin-evidence opening (min-score floor zeroes weak noise)', () => {
    const r = evaluate(scenario('thin-evidence-opening'), DEFAULT_SCORING_PARAMS)
    expect(r.firedCount).toBe(0)
    expect(r.hardNegativeViolations).toBe(0)
  })

  it('beats the ST-keyword baseline on micro-precision (original suite)', () => {
    const scorer = microScorer(ORIGINAL_SCENARIOS, DEFAULT_SCORING_PARAMS)
    const keyword = microKeywordBaseline(ORIGINAL_SCENARIOS)
    expect(scorer.precision).toBeGreaterThan(keyword.precision)
  })

  it('has zero hard-negative violations on the keyword-correct-guard scenarios', () => {
    for (const name of ['keyword-guard-oaths', 'keyword-guard-beasts', 'keyword-guard-relics']) {
      const r = evaluate(scenario(name), DEFAULT_SCORING_PARAMS)
      expect(r.hardNegativeViolations, name).toBe(0)
    }
  })

  it('ranks a p=40 entry strictly below its p=100 twin (category 7)', () => {
    const scores = scoreByComment('probability-ordering')
    expect(scores.get('CrimsonP40')!).toBeLessThan(scores.get('AzureP100')!)
  })

  it('ranks a two-key entry above a single-key rival at the same depth (category 11)', () => {
    const scores = scoreByComment('multi-key-accumulation')
    expect(scores.get('TwoKey')!).toBeGreaterThan(scores.get('OneKey')!)
  })

  it('every original scenario evaluates without throwing and fires ≥1 relevant when expected', () => {
    // Restricted to ORIGINAL_SCENARIOS: the new broad-evidence scenarios still fire ≥1 relevant, but the
    // persistence scenarios fire NOTHING at the default persistBoost=1 by design (covered separately).
    for (const s of ORIGINAL_SCENARIOS) {
      const r = evaluate(s, DEFAULT_SCORING_PARAMS)
      // Thin-evidence has no relevant entries by design (it measures over-firing on noise).
      if (s.relevant.length > 0) {
        expect(r.firedCount, `${s.name} fired nothing`).toBeGreaterThan(0)
        expect(r.tp, `${s.name} fired no relevant entry`).toBeGreaterThan(0)
      }
    }
  })
})

describe('lore scorer — broad-evidence scenarios reach full recall at the maxK=12 default (2026-07-24)', () => {
  // The adopted maxK=12 default (2026-07-24) is what the broad-evidence scenarios were built to justify:
  // scenarios with many genuinely-relevant entries (9–10 each) now recover recall WITHOUT firing the
  // zero-evidence hard negatives. The old maxK=4 default starved them (recall well below 0.6).
  const broad = NEW_SCENARIOS.filter((s) => s.category === 'broad')

  it('lists the two broad-evidence scenarios', () => {
    expect(broad.map((s) => s.name).sort()).toEqual(['broad-evidence-starchart', 'broad-evidence-warband'])
  })

  it('reaches recall ≥0.9 at the defaults with zero hard-negative violations', () => {
    // Flipped 2026-07-24: at the old maxK=4 default this asserted recall was LOW (awaiting the defaults
    // decision); the adopted maxK=12 default now recovers it. Measured recall 1.0, violations 0.
    const micro = microScorer(broad, DEFAULT_SCORING_PARAMS)
    expect(micro.recall).toBeGreaterThanOrEqual(0.9)
    expect(micro.violations).toBe(0) // the wider cap fits the relevant entries without any hard negative
  })

  it('recovers recall ≥0.9 at maxK=12 with still-zero hard-negative violations', () => {
    const micro = microScorer(broad, { ...DEFAULT_SCORING_PARAMS, maxK: 12 })
    expect(micro.recall).toBeGreaterThanOrEqual(0.9)
    expect(micro.violations).toBe(0)
  })
})

describe('lore scorer — persistence scenarios (2026-07-24)', () => {
  const persistence = NEW_SCENARIOS.filter((s) => s.category === 'persistence')

  // The single ZERO-current-evidence entry each persistence scenario lists in `prevFired`. Persistence
  // multiplies a final score; it never resurrects zero evidence (0 × boost = 0) — so these must NEVER fire.
  const zeroEvidence: Record<string, string> = {
    'persistence-fading-companions': 'PhantomRider-ZERO',
    'persistence-recurring-company': 'SunkenHerald-ZERO'
  }

  it('lists the two persistence scenarios, each with a prevFired set', () => {
    expect(persistence.map((s) => s.name).sort()).toEqual([
      'persistence-fading-companions',
      'persistence-recurring-company'
    ])
    for (const s of persistence) expect((s.prevFired ?? []).length).toBeGreaterThan(0)
  })

  it('never fires a zero-current-evidence prevFired entry at ANY persistBoost in {1, 1.5, 2}', () => {
    for (const s of persistence) {
      const prev = new Set((s.prevFired ?? []).map(refKey))
      for (const persistBoost of [1, 1.5, 2]) {
        const rows = scoreLoreEntries(
          s.books,
          s.segments,
          s.pinText,
          { ...DEFAULT_SCORING_PARAMS, persistBoost },
          prev
        )
        const zero = rows.find((r) => r.comment === zeroEvidence[s.name])!
        expect(zero.fired, `${s.name} @persist=${persistBoost}`).toBe(false)
        expect(zero.score, `${s.name} @persist=${persistBoost}`).toBe(0)
        expect(zero.persisted, `${s.name} @persist=${persistBoost}`).toBeUndefined()
      }
    }
  })

  it('persistBoost≥1.5 recovers the persisted relevant entries without adding hard negatives', () => {
    for (const s of persistence) {
      const off = evaluate(s, { ...DEFAULT_SCORING_PARAMS, persistBoost: 1 })
      const on = evaluate(s, { ...DEFAULT_SCORING_PARAMS, persistBoost: 1.5 })
      // At the adopted maxK=12 default (2026-07-24) the wider cap alone already recovers recall for some
      // persistence scenarios, so persistence is non-decreasing (was strictly-increasing at maxK=4). With
      // it the relevant entries reach full recall, and persistence adds no hard-negative beyond whatever
      // the wider cap already fires on its own evidence (persistence never resurrects zero-evidence).
      expect(on.recall, `${s.name} recall`).toBeGreaterThanOrEqual(off.recall)
      expect(on.recall, `${s.name} recall`).toBeGreaterThanOrEqual(0.9)
      expect(on.hardNegativeViolations, `${s.name} violations`).toBe(off.hardNegativeViolations)
    }
  })
})

// Sanity: the combined suite is the concatenation and nothing in it throws at defaults.
describe('lore scorer — combined suite integrity', () => {
  it('SCENARIOS = ORIGINAL_SCENARIOS + NEW_SCENARIOS and evaluates without throwing', () => {
    expect(SCENARIOS.length).toBe(ORIGINAL_SCENARIOS.length + NEW_SCENARIOS.length)
    for (const s of SCENARIOS) expect(() => evaluate(s, DEFAULT_SCORING_PARAMS)).not.toThrow()
  })
})
