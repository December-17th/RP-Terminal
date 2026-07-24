# Lore-scoring parameter tuning (2026-07-23)

**Status: PoC — debug window only.** Grid search over 225 `ScoringParams` combinations,
evaluated on 19 synthetic scenarios (`test/fixtures/loreScoring/scenarios.ts`). Metric =
micro-aggregated precision/recall/F1 (summed numerators/denominators) vs. authored relevant / hard-negative
sets, plus total hard-negative violations. Ranked by F1, tiebreak fewer violations then higher precision.

> **DECISION — ACTED:** `DEFAULT_SCORING_PARAMS.topK` was updated **8 → 4** in the same commit as this
> report. That is the single param separating the tied-best combo below from the previous default; it
> raised micro-F1 **0.775 → 0.861** and cut hard-negative violations **12 → 8**, without regressing recall
> (1.000). `lambda`, `hopDecay`, and `pinBoost` were metric-neutral on this scenario set and were KEPT.
> The "DEFAULT" row below is the **previous** default (topK=8); the "best" row is the **new** default.
> This report is a point-in-time snapshot; re-running the tuner after the change will show the new default
> at rank 1 (no further improvement) — that is expected.

## Top 10 combinations

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| 1 | λ=0.6 hop=0.5 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 2 | λ=0.5 hop=0.5 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 3 | λ=0.7 hop=0.5 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 4 | λ=0.6 hop=0.5 pin=1.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 5 | λ=0.4 hop=0.5 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 6 | λ=0.6 hop=0.25 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 7 | λ=0.6 hop=0.75 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 8 | λ=0.8 hop=0.5 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 9 | λ=0.6 hop=0.5 pin=4 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| 10 | λ=0.5 hop=0.5 pin=1.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |

## Current default vs. baseline

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| 91/225 | λ=0.6 hop=0.5 pin=2.5 K=8 (DEFAULT) | 0.633 | 1.000 | 0.775 | 12 |
| best | λ=0.6 hop=0.5 pin=2.5 K=4 | 0.756 | 1.000 | 0.861 | 8 |
| — | ST-keyword baseline | 0.133 | 0.806 | 0.228 | 12 |

## Interpretation

The default `λ=0.6 hop=0.5 pin=2.5 K=8` ranks 91 of 225
(F1 0.775). The best combo `λ=0.6 hop=0.5 pin=2.5 K=4` scores F1
0.861 — a gain of 0.086 over the default with
8 vs. 12 hard-negative violations. Both beat the
ST-keyword baseline on precision (0.133), which fires every keyword/pin match with no
ranking or top-K cut and so over-fires on large books and common-word collisions. The dominant precision
lever is `topK` (smaller caps over-firing on small books); `pinBoost` and `hopDecay` mainly move
recall on the pin and scene-cluster scenarios. **Defaults SHOULD be updated (best beats default by >0.02 F1 without adding violations).**

_Tuned on synthetic scenarios; real-card in-app validation still required._
