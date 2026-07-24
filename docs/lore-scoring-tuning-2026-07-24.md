# Lore-scoring parameter tuning — adaptive selection (2026-07-24)

**Status: PoC — debug window only.** Supersedes lore-scoring-tuning-2026-07-23.md (point-in-time). Grid
search over 2700 `ScoringParams` combinations with the new adaptive selection (`maxK`
ceiling + `minScore` floor + `relCut` relative cut), evaluated on 19 synthetic
scenarios. Metric = micro-aggregated P/R/F1 (summed numerators/denominators) vs. authored relevant /
hard-negative sets, plus total hard-negative violations. Ranked by F1, tiebreak fewer violations, higher
precision, then closeness to the baseline behavior.

Baseline to beat = the previous fixed-K default `λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0 rel=0` (floor + cut disabled).

## Top 10 combinations

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| 1 | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.35 | 0.912 | 1.000 | 0.954 | 3 |
| 2 | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.5 | 0.912 | 1.000 | 0.954 | 3 |
| 3 | λ=0.6 hop=0.5 pin=1.5 maxK=4 min=0.6 rel=0.35 | 0.912 | 1.000 | 0.954 | 3 |
| 4 | λ=0.6 hop=0.75 pin=2.5 maxK=4 min=0.6 rel=0.35 | 0.912 | 1.000 | 0.954 | 3 |
| 5 | λ=0.8 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.35 | 0.912 | 1.000 | 0.954 | 3 |
| 6 | λ=0.6 hop=0.5 pin=4 maxK=4 min=0.6 rel=0.35 | 0.912 | 1.000 | 0.954 | 3 |
| 7 | λ=0.6 hop=0.5 pin=1.5 maxK=4 min=0.6 rel=0.5 | 0.912 | 1.000 | 0.954 | 3 |
| 8 | λ=0.6 hop=0.75 pin=2.5 maxK=4 min=0.6 rel=0.5 | 0.912 | 1.000 | 0.954 | 3 |
| 9 | λ=0.8 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.5 | 0.912 | 1.000 | 0.954 | 3 |
| 10 | λ=0.6 hop=0.5 pin=4 maxK=4 min=0.6 rel=0.5 | 0.912 | 1.000 | 0.954 | 3 |

## Baseline vs. best vs. keyword

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| 628/2700 | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0 rel=0 (BASELINE) | 0.721 | 1.000 | 0.838 | 10 |
| best | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.35 | 0.912 | 1.000 | 0.954 | 3 |
| — | ST-keyword baseline | 0.128 | 0.806 | 0.220 | 20 |

## Interpretation

The fixed-K baseline ranks 628/2700 (F1 0.838, 10 violations).
The best combo `λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.35` scores F1 0.954 (gain 0.116) with
3 violations. A non-zero `minScore` floor zeroes the thin-evidence scenario's
weak fires (its main violation source); `relCut` trims the low tail on skewed score distributions while
leaving flat distributions near the `maxK` ceiling. **Defaults WERE UPDATED to the best combo (it beats the fixed-K baseline by >0.02 F1 without adding violations).**

_Tuned on synthetic scenarios; real-card in-app validation still required._
