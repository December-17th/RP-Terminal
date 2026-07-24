# Lore-scoring parameter tuning — persistence-bonus axis (2026-07-24)

**Status: PoC — debug window only. Aggregates only; awaiting owner's retuned-defaults decision.**
Point-in-time snapshot; does NOT supersede lore-scoring-tuning-2026-07-24.md — it adds the new
persistence (hysteresis) axis `persistBoost ∈ {1, 1.5, 2}` and the broad-evidence / persistence
scenarios. Grid search over 8100 `ScoringParams` combinations (adaptive selection: `maxK`
ceiling + `minScore` floor + `relCut` relative cut + `persistBoost` continuity multiplier), evaluated
on 23 synthetic scenarios. Metric = micro-aggregated P/R/F1 (summed
numerators/denominators) vs. authored relevant / hard-negative sets, plus total hard-negative violations.
Ranked by F1, tiebreak fewer violations, higher precision, then closeness to the baseline.

Baseline to beat = the previous fixed-K default `λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0 rel=0 persist=1` (floor + cut + persist disabled).
**Current shipped defaults are UNCHANGED (`persistBoost: 1`); this run only informs a future decision.**

## Top 10 combinations

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| 1 | λ=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 2 | λ=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.5 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 3 | λ=0.6 hop=0.5 pin=2.5 maxK=16 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 4 | λ=0.6 hop=0.5 pin=1.5 maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 5 | λ=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=2 | 0.851 | 1.000 | 0.919 | 10 |
| 6 | λ=0.6 hop=0.75 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 7 | λ=0.6 hop=0.5 pin=4 maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 8 | λ=0.6 hop=0.5 pin=2.5 maxK=16 min=0.6 rel=0.5 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 9 | λ=0.6 hop=0.5 pin=1.5 maxK=12 min=0.6 rel=0.5 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| 10 | λ=0.6 hop=0.5 pin=1.5 maxK=16 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |

## Reference rows: baseline, current defaults, best, keyword

| Rank | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| 6778/8100 | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0 rel=0 persist=1 (fixed-K BASELINE) | 0.729 | 0.754 | 0.741 | 14 |
| 4831/8100 | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.35 persist=1 (CURRENT DEFAULTS) | 0.870 | 0.702 | 0.777 | 6 |
| best | λ=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |
| — | ST-keyword baseline | 0.225 | 0.895 | 0.359 | 25 |

## Best combo per maxK ceiling (justifying a higher cap)

| maxK | Params | Precision | Recall | F1 | HN violations |
|---|---|---|---|---|---|
| maxK=4 | λ=0.6 hop=0.5 pin=2.5 maxK=4 min=0.6 rel=0.35 persist=1.5 | 0.939 | 0.807 | 0.868 | 3 |
| maxK=8 | λ=0.6 hop=0.5 pin=2.5 maxK=8 min=0.6 rel=0.35 persist=1.5 | 0.844 | 0.947 | 0.893 | 10 |
| maxK=12 | λ=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.851 | 1.000 | 0.919 | 10 |

## Interpretation

The current shipped defaults (`persistBoost 1`) rank 4831/8100 on the new suite
(F1 0.777, recall 0.702, 6 violations)
— the maxK=4 cap under-fires the broad-evidence scenarios (9–10 genuinely-relevant entries each). The best
combo `λ=0.6 hop=0.5 pin=2.5 maxK=12 min=0.6 rel=0.35 persist=1.5` scores F1 0.919 (gain 0.178 over the fixed-K
baseline) with 10 violations. Raising `maxK` recovers broad-evidence recall without
firing the zero-evidence hard negatives; a `persistBoost` > 1 lets weakly-but-continuously-relevant
entries survive the floor/cut/cap that would otherwise drop them, which is what buys back cache stability
at the higher cap. **Defaults are NOT changed here — the owner decides retuned defaults from these
aggregates.**

_Tuned on synthetic scenarios; real-card in-app validation still required._
