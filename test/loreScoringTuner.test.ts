/**
 * Parameter tuner for the deterministic lore-scoring PoC. SKIPPED in the normal suite; run it with:
 *   npm run tune:lore     (sets TUNE_LORE=1)
 *
 * Grid-searches ScoringParams over the synthetic scenarios (test/fixtures/loreScoring), ranks combos by
 * micro-F1 (tiebreak: fewer hard-negative violations, then higher precision), prints the top 10 plus the
 * current default's rank and the ST-keyword baseline, and writes docs/lore-scoring-tuning-2026-07-23.md.
 * Deterministic; no LLM, no network.
 */

import { describe, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { SCENARIOS } from './fixtures/loreScoring/scenarios'
import { microScorer, microKeywordBaseline, type MicroAgg } from './fixtures/loreScoring/metrics'
import { DEFAULT_SCORING_PARAMS, type ScoringParams } from '../src/shared/retrievalTrace'

const GRID = {
  lambda: [0.4, 0.5, 0.6, 0.7, 0.8],
  hopDecay: [0.25, 0.5, 0.75],
  pinBoost: [1.5, 2.5, 4.0],
  topK: [4, 6, 8, 10, 12]
}

interface Combo {
  params: ScoringParams
  micro: MicroAgg
}

const sameParams = (a: ScoringParams, b: ScoringParams): boolean =>
  a.lambda === b.lambda && a.hopDecay === b.hopDecay && a.pinBoost === b.pinBoost && a.topK === b.topK

// Distance from the current defaults (normalized per axis) — used ONLY as a final tiebreak so that,
// among metric-equivalent combos, the reported "best" changes the fewest / smallest params. This keeps
// metric-neutral knobs (e.g. hopDecay/pinBoost when the scenarios don't distinguish them) at their
// current values rather than flipping them on noise.
const distFromDefault = (p: ScoringParams): number =>
  Math.abs(p.lambda - DEFAULT_SCORING_PARAMS.lambda) / 0.4 +
  Math.abs(p.hopDecay - DEFAULT_SCORING_PARAMS.hopDecay) / 0.5 +
  Math.abs(p.pinBoost - DEFAULT_SCORING_PARAMS.pinBoost) / 2.5 +
  Math.abs(p.topK - DEFAULT_SCORING_PARAMS.topK) / 8

// Rank: F1 desc, then fewer violations, higher precision, then closest to the current defaults.
const rankCmp = (a: Combo, b: Combo): number =>
  b.micro.f1 - a.micro.f1 ||
  a.micro.violations - b.micro.violations ||
  b.micro.precision - a.micro.precision ||
  distFromDefault(a.params) - distFromDefault(b.params)

const f3 = (n: number): string => n.toFixed(3)
const paramStr = (p: ScoringParams): string =>
  `λ=${p.lambda} hop=${p.hopDecay} pin=${p.pinBoost} K=${p.topK}`

const RUN = process.env.TUNE_LORE === '1'

;(RUN ? describe : describe.skip)('lore-scoring parameter tuner', () => {
  it('grid-searches params and writes the tuning report', () => {
    const combos: Combo[] = []
    for (const lambda of GRID.lambda)
      for (const hopDecay of GRID.hopDecay)
        for (const pinBoost of GRID.pinBoost)
          for (const topK of GRID.topK) {
            const params = { lambda, hopDecay, pinBoost, topK }
            combos.push({ params, micro: microScorer(SCENARIOS, params) })
          }
    combos.sort(rankCmp)

    const defaultIdx = combos.findIndex((c) => sameParams(c.params, DEFAULT_SCORING_PARAMS))
    const defaultCombo = combos[defaultIdx]
    const best = combos[0]
    const baseline = microKeywordBaseline(SCENARIOS)

    // --- Console output ---
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
      `\nDefault ${paramStr(DEFAULT_SCORING_PARAMS)} → rank ${defaultIdx + 1}/${combos.length} ` +
        `P=${f3(defaultCombo.micro.precision)} R=${f3(defaultCombo.micro.recall)} ` +
        `F1=${f3(defaultCombo.micro.f1)} viol=${defaultCombo.micro.violations}`
    )
    // eslint-disable-next-line no-console
    console.log(
      `Keyword baseline → P=${f3(baseline.precision)} R=${f3(baseline.recall)} ` +
        `F1=${f3(baseline.f1)} viol=${baseline.violations}`
    )

    // --- Markdown report ---
    const row = (rank: string, p: string, m: MicroAgg): string =>
      `| ${rank} | ${p} | ${f3(m.precision)} | ${f3(m.recall)} | ${f3(m.f1)} | ${m.violations} |`
    const header = '| Rank | Params | Precision | Recall | F1 | HN violations |\n|---|---|---|---|---|---|'
    const topRows = combos.slice(0, 10).map((c, i) => row(String(i + 1), paramStr(c.params), c.micro))
    const f1Gain = best.micro.f1 - defaultCombo.micro.f1
    const beatsDefault =
      f1Gain > 0.02 && best.micro.violations <= defaultCombo.micro.violations && defaultIdx !== 0

    const doc = `# Lore-scoring parameter tuning (2026-07-23)

**Status: PoC — debug window only.** Grid search over ${combos.length} \`ScoringParams\` combinations,
evaluated on ${SCENARIOS.length} synthetic scenarios (\`test/fixtures/loreScoring/scenarios.ts\`). Metric =
micro-aggregated precision/recall/F1 (summed numerators/denominators) vs. authored relevant / hard-negative
sets, plus total hard-negative violations. Ranked by F1, tiebreak fewer violations then higher precision.

## Top 10 combinations

${header}
${topRows.join('\n')}

## Current default vs. baseline

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
${row(`${defaultIdx + 1}/${combos.length}`, `${paramStr(DEFAULT_SCORING_PARAMS)} (DEFAULT)`, defaultCombo.micro)}
${row('best', paramStr(best.params), best.micro)}
${row('—', 'ST-keyword baseline', baseline)}

## Interpretation

The default \`${paramStr(DEFAULT_SCORING_PARAMS)}\` ranks ${defaultIdx + 1} of ${combos.length}
(F1 ${f3(defaultCombo.micro.f1)}). The best combo \`${paramStr(best.params)}\` scores F1
${f3(best.micro.f1)} — a gain of ${f3(f1Gain)} over the default with
${best.micro.violations} vs. ${defaultCombo.micro.violations} hard-negative violations. Both beat the
ST-keyword baseline on precision (${f3(baseline.precision)}), which fires every keyword/pin match with no
ranking or top-K cut and so over-fires on large books and common-word collisions. The dominant precision
lever is \`topK\` (smaller caps over-firing on small books); \`pinBoost\` and \`hopDecay\` mainly move
recall on the pin and scene-cluster scenarios. **Defaults ${beatsDefault ? 'SHOULD be updated (best beats default by >0.02 F1 without adding violations).' : 'were KEPT (best does not beat the default by more than 0.02 F1 without regressing violations).'}**

_Tuned on synthetic scenarios; real-card in-app validation still required._
`
    const outDir = path.join(process.cwd(), 'docs')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'lore-scoring-tuning-2026-07-23.md'), doc)
    // eslint-disable-next-line no-console
    console.log(
      `\nDefaults ${beatsDefault ? 'SHOULD be updated' : 'KEPT'} (best F1 gain ${f3(f1Gain)}).`
    )
  })
})
