/**
 * Parameter tuner for the deterministic lore-scoring PoC. SKIPPED in the normal suite; run it with:
 *   npm run tune:lore     (sets TUNE_LORE=1)
 *
 * Grid-searches ScoringParams (adaptive selection: maxK ceiling + minScore floor + relCut) over the
 * synthetic scenarios (test/fixtures/loreScoring), ranks by micro-F1 (tiebreak: fewer hard-negative
 * violations, higher precision, closest to the baseline behavior), and writes the dated tuning report.
 * Deterministic; no LLM, no network.
 */

import { describe, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { SCENARIOS } from './fixtures/loreScoring/scenarios'
import { microScorer, microKeywordBaseline, type MicroAgg } from './fixtures/loreScoring/metrics'
import type { ScoringParams } from '../src/shared/retrievalTrace'

const GRID = {
  lambda: [0.4, 0.6, 0.8],
  hopDecay: [0.25, 0.5, 0.75],
  pinBoost: [1.5, 2.5, 4.0],
  maxK: [4, 8, 12, 16],
  minScore: [0, 0.15, 0.3, 0.6, 1.0],
  relCut: [0, 0.1, 0.2, 0.35, 0.5]
}

// The behavior to beat: the previous fixed-K default (minScore/relCut disabled), i.e. old topK=4.
const BASELINE: ScoringParams = {
  lambda: 0.6,
  hopDecay: 0.5,
  pinBoost: 2.5,
  maxK: 4,
  minScore: 0,
  relCut: 0
}

interface Combo {
  params: ScoringParams
  micro: MicroAgg
}

const sameParams = (a: ScoringParams, b: ScoringParams): boolean =>
  a.lambda === b.lambda &&
  a.hopDecay === b.hopDecay &&
  a.pinBoost === b.pinBoost &&
  a.maxK === b.maxK &&
  a.minScore === b.minScore &&
  a.relCut === b.relCut

// Distance from the baseline (normalized per axis) — a final tiebreak so that, among metric-equivalent
// combos, the reported best changes the fewest / smallest params.
const distFromBaseline = (p: ScoringParams): number =>
  Math.abs(p.lambda - BASELINE.lambda) / 0.4 +
  Math.abs(p.hopDecay - BASELINE.hopDecay) / 0.5 +
  Math.abs(p.pinBoost - BASELINE.pinBoost) / 2.5 +
  Math.abs(p.maxK - BASELINE.maxK) / 12 +
  Math.abs(p.minScore - BASELINE.minScore) / 1 +
  Math.abs(p.relCut - BASELINE.relCut) / 0.5

const rankCmp = (a: Combo, b: Combo): number =>
  b.micro.f1 - a.micro.f1 ||
  a.micro.violations - b.micro.violations ||
  b.micro.precision - a.micro.precision ||
  distFromBaseline(a.params) - distFromBaseline(b.params)

const f3 = (n: number): string => n.toFixed(3)
const paramStr = (p: ScoringParams): string =>
  `λ=${p.lambda} hop=${p.hopDecay} pin=${p.pinBoost} maxK=${p.maxK} min=${p.minScore} rel=${p.relCut}`

const RUN = process.env.TUNE_LORE === '1'

;(RUN ? describe : describe.skip)('lore-scoring parameter tuner', () => {
  it('grid-searches params and writes the tuning report', () => {
    const combos: Combo[] = []
    for (const lambda of GRID.lambda)
      for (const hopDecay of GRID.hopDecay)
        for (const pinBoost of GRID.pinBoost)
          for (const maxK of GRID.maxK)
            for (const minScore of GRID.minScore)
              for (const relCut of GRID.relCut) {
                const params = { lambda, hopDecay, pinBoost, maxK, minScore, relCut }
                combos.push({ params, micro: microScorer(SCENARIOS, params) })
              }
    combos.sort(rankCmp)

    const baseIdx = combos.findIndex((c) => sameParams(c.params, BASELINE))
    const baseCombo = combos[baseIdx]
    const best = combos[0]
    const keyword = microKeywordBaseline(SCENARIOS)
    const f1Gain = best.micro.f1 - baseCombo.micro.f1
    const beatsBaseline =
      f1Gain > 0.02 && best.micro.violations <= baseCombo.micro.violations && baseIdx !== 0

    // --- Console ---
    const top = combos.slice(0, 10).map((c, i) => ({
      rank: i + 1,
      params: paramStr(c.params),
      P: f3(c.micro.precision),
      R: f3(c.micro.recall),
      F1: f3(c.micro.f1),
      viol: c.micro.violations
    }))
    // eslint-disable-next-line no-console
    console.table(top)
    // eslint-disable-next-line no-console
    console.log(
      `\nBaseline ${paramStr(BASELINE)} → rank ${baseIdx + 1}/${combos.length} ` +
        `F1=${f3(baseCombo.micro.f1)} viol=${baseCombo.micro.violations}\n` +
        `Best ${paramStr(best.params)} F1=${f3(best.micro.f1)} viol=${best.micro.violations}\n` +
        `Keyword baseline F1=${f3(keyword.f1)} P=${f3(keyword.precision)}\n` +
        `Defaults ${beatsBaseline ? 'SHOULD be updated' : 'KEPT'} (gain ${f3(f1Gain)}).`
    )

    // --- Markdown report ---
    const row = (rank: string, p: string, m: MicroAgg): string =>
      `| ${rank} | ${p} | ${f3(m.precision)} | ${f3(m.recall)} | ${f3(m.f1)} | ${m.violations} |`
    const header = '| Rank | Params | Precision | Recall | F1 | HN violations |\n|---|---|---|---|---|---|'
    const topRows = combos.slice(0, 10).map((c, i) => row(String(i + 1), paramStr(c.params), c.micro))

    const doc = `# Lore-scoring parameter tuning — adaptive selection (2026-07-24)

**Status: PoC — debug window only.** Supersedes lore-scoring-tuning-2026-07-23.md (point-in-time). Grid
search over ${combos.length} \`ScoringParams\` combinations with the new adaptive selection (\`maxK\`
ceiling + \`minScore\` floor + \`relCut\` relative cut), evaluated on ${SCENARIOS.length} synthetic
scenarios. Metric = micro-aggregated P/R/F1 (summed numerators/denominators) vs. authored relevant /
hard-negative sets, plus total hard-negative violations. Ranked by F1, tiebreak fewer violations, higher
precision, then closeness to the baseline behavior.

Baseline to beat = the previous fixed-K default \`${paramStr(BASELINE)}\` (floor + cut disabled).

## Top 10 combinations

${header}
${topRows.join('\n')}

## Baseline vs. best vs. keyword

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
${row(`${baseIdx + 1}/${combos.length}`, `${paramStr(BASELINE)} (BASELINE)`, baseCombo.micro)}
${row('best', paramStr(best.params), best.micro)}
${row('—', 'ST-keyword baseline', keyword)}

## Interpretation

The fixed-K baseline ranks ${baseIdx + 1}/${combos.length} (F1 ${f3(baseCombo.micro.f1)}, ${baseCombo.micro.violations} violations).
The best combo \`${paramStr(best.params)}\` scores F1 ${f3(best.micro.f1)} (gain ${f3(f1Gain)}) with
${best.micro.violations} violations. A non-zero \`minScore\` floor zeroes the thin-evidence scenario's
weak fires (its main violation source); \`relCut\` trims the low tail on skewed score distributions while
leaving flat distributions near the \`maxK\` ceiling. **Defaults ${
      beatsBaseline
        ? 'WERE UPDATED to the best combo (it beats the fixed-K baseline by >0.02 F1 without adding violations).'
        : 'were KEPT (best does not beat the baseline by >0.02 F1 without regressing violations).'
    }**

_Tuned on synthetic scenarios; real-card in-app validation still required._
`
    const outDir = path.join(process.cwd(), 'docs')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'lore-scoring-tuning-2026-07-24.md'), doc)
  })
})
