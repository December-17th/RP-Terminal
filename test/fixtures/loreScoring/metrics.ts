/**
 * Deterministic metrics for the lore-scorer evaluation harness. Compares the scorer's fired set (and the
 * ST-keyword baseline's) against each scenario's authored `relevant` / `hardNegative` sets. Pure; no LLM,
 * no network. Used by the regression test and the parameter tuner.
 */

import { scoreLoreEntries } from '../../../src/main/services/loreScoring'
import { matchAcrossTraced } from '../../../src/main/services/lorebookService'
import type { ScoringParams } from '../../../src/shared/retrievalTrace'
import type { EntryRef, Scenario } from './scenarios'

const refKey = (r: EntryRef): string => `${r.bookName}::${r.entryIndex}`

export interface EvalResult {
  fired: EntryRef[]
  /** True positives = |fired ∩ relevant|. */
  tp: number
  firedCount: number
  relevantCount: number
  precision: number
  recall: number
  f1: number
  /** |fired ∩ hardNegative|. */
  hardNegativeViolations: number
}

const metricsFor = (fired: EntryRef[], scenario: Scenario): EvalResult => {
  const relSet = new Set(scenario.relevant.map(refKey))
  const hnSet = new Set(scenario.hardNegative.map(refKey))
  const firedKeys = fired.map(refKey)
  const tp = firedKeys.filter((k) => relSet.has(k)).length
  const firedCount = fired.length
  const relevantCount = scenario.relevant.length
  const hardNegativeViolations = firedKeys.filter((k) => hnSet.has(k)).length
  // Per-scenario ratios: no fires → precision 1 (vacuously precise); no relevant → recall 1.
  const precision = firedCount > 0 ? tp / firedCount : 1
  const recall = relevantCount > 0 ? tp / relevantCount : 1
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { fired, tp, firedCount, relevantCount, precision, recall, f1, hardNegativeViolations }
}

/** Evaluate the deterministic scorer (non-constant fired set only) for one scenario + params. */
export const evaluate = (scenario: Scenario, params: ScoringParams): EvalResult => {
  const rows = scoreLoreEntries(scenario.books, scenario.segments, scenario.pinText, params)
  const fired: EntryRef[] = rows
    .filter((r) => r.fired && !r.constant)
    .map((r) => ({ bookName: r.bookName, entryIndex: r.entryIndex }))
  return metricsFor(fired, scenario)
}

/**
 * Evaluate the ST-keyword baseline for one scenario: run the real matcher over the joined segment text
 * with the pin block appended (that is what RPT mode actually scans), constants excluded so the fired
 * set is comparable to the scorer's non-constant set. rng ()=>0 → probability roll always passes.
 */
export const evaluateKeywordBaseline = (scenario: Scenario): EvalResult => {
  const joined = scenario.segments.map((s) => s.text).join('\n') + scenario.pinText
  const { trace } = matchAcrossTraced(scenario.books, joined, () => 0, 0)
  const fired: EntryRef[] = trace
    .filter((r) => r.fired && r.reason !== 'constant')
    .map((r) => ({ bookName: r.bookName, entryIndex: r.entryIndex }))
  return metricsFor(fired, scenario)
}

export interface MicroAgg {
  precision: number
  recall: number
  f1: number
  violations: number
  tpSum: number
  firedSum: number
  relevantSum: number
}

/** Micro-aggregate: sum numerators/denominators across scenarios (NOT a mean of per-scenario ratios). */
export const microAggregate = (results: EvalResult[]): MicroAgg => {
  let tpSum = 0
  let firedSum = 0
  let relevantSum = 0
  let violations = 0
  for (const r of results) {
    tpSum += r.tp
    firedSum += r.firedCount
    relevantSum += r.relevantCount
    violations += r.hardNegativeViolations
  }
  const precision = firedSum > 0 ? tpSum / firedSum : 0
  const recall = relevantSum > 0 ? tpSum / relevantSum : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { precision, recall, f1, violations, tpSum, firedSum, relevantSum }
}

/** Micro metrics for the scorer across all scenarios at given params. */
export const microScorer = (scenarios: Scenario[], params: ScoringParams): MicroAgg =>
  microAggregate(scenarios.map((s) => evaluate(s, params)))

/** Micro metrics for the ST-keyword baseline across all scenarios. */
export const microKeywordBaseline = (scenarios: Scenario[]): MicroAgg =>
  microAggregate(scenarios.map((s) => evaluateKeywordBaseline(s)))
