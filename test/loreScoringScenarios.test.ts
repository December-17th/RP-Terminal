import { describe, it, expect } from 'vitest'
import { SCENARIOS, scenario } from './fixtures/loreScoring/scenarios'
import {
  evaluate,
  microScorer,
  microKeywordBaseline
} from './fixtures/loreScoring/metrics'
import { scoreLoreEntries } from '../src/main/services/loreScoring'
import { DEFAULT_SCORING_PARAMS } from '../src/shared/retrievalTrace'

/**
 * Regression tests for the deterministic lore scorer over the synthetic scenario suite
 * (test/fixtures/loreScoring). Runs at DEFAULT_SCORING_PARAMS (adaptive selection). The F1 floor is
 * deliberately loose (~5 points below the measured 0.954) so it pins "don't regress badly", not an
 * overfit lock. See the tuner (test/loreScoringTuner.test.ts, `npm run tune:lore`) and
 * docs/lore-scoring-tuning-2026-07-24.md.
 */

// Comment lookup on a scored run of one scenario (DEFAULT params).
const scoreByComment = (name: string): Map<string, number> => {
  const s = scenario(name)
  const rows = scoreLoreEntries(s.books, s.segments, s.pinText, DEFAULT_SCORING_PARAMS)
  return new Map(rows.map((r) => [r.comment, r.score]))
}

describe('lore scorer — synthetic scenario regression', () => {
  it('achieves a micro-F1 above a loose floor at the default params', () => {
    const micro = microScorer(SCENARIOS, DEFAULT_SCORING_PARAMS)
    // Measured 0.954 (see tuning doc); floor set ~5 points below, not an overfit lock.
    expect(micro.f1).toBeGreaterThanOrEqual(0.9)
    expect(micro.recall).toBeGreaterThanOrEqual(0.9)
  })

  it('fires nothing on the thin-evidence opening (min-score floor zeroes weak noise)', () => {
    const r = evaluate(scenario('thin-evidence-opening'), DEFAULT_SCORING_PARAMS)
    expect(r.firedCount).toBe(0)
    expect(r.hardNegativeViolations).toBe(0)
  })

  it('beats the ST-keyword baseline on micro-precision', () => {
    const scorer = microScorer(SCENARIOS, DEFAULT_SCORING_PARAMS)
    const keyword = microKeywordBaseline(SCENARIOS)
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

  it('every scenario evaluates without throwing and fires ≥1 relevant entry when expected', () => {
    for (const s of SCENARIOS) {
      const r = evaluate(s, DEFAULT_SCORING_PARAMS)
      // Thin-evidence has no relevant entries by design (it measures over-firing on noise).
      if (s.relevant.length > 0) {
        expect(r.firedCount, `${s.name} fired nothing`).toBeGreaterThan(0)
        expect(r.tp, `${s.name} fired no relevant entry`).toBeGreaterThan(0)
      }
    }
  })
})
