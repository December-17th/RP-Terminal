# Lore-scoring real-data evaluation (2026-07-23)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** Replays stored chats from the
dev data dir against a next-response proxy label and grid-searches `ScoringParams`. Proxy label: an
enabled non-constant entry is "relevant" for floor N iff one of its primary keys appears in the stored
text of response N. No hard-negative set on real data — metrics are micro-aggregated precision/recall/F1
vs. the proxy only. `DEFAULT_SCORING_PARAMS` is NOT changed from these numbers (see limitations).

## Sample size

- Chats replayed (≥4 floors): **1**
- (chat, floor) samples: **15**
- Lorebook entries in scope: **473**
- scanDepth: **3** · maxRecursion: **0** (app default; the keyword baseline uses the same)
- Pins: none (real cards declare no `pin_paths`) — **the `pinBoost` axis is NOT exercised by real data.**

## Grid top 10 (by micro-F1)

| Rank | Params | Precision | Recall | F1 |
|---|---|---|---|---|
| 1 | λ=0.4 hop=0.5 pin=2.5 K=12 | 0.939 | 0.235 | 0.376 |
| 2 | λ=0.4 hop=0.5 pin=1.5 K=12 | 0.939 | 0.235 | 0.376 |
| 3 | λ=0.4 hop=0.5 pin=4 K=12 | 0.939 | 0.235 | 0.376 |
| 4 | λ=0.5 hop=0.5 pin=2.5 K=12 | 0.922 | 0.231 | 0.369 |
| 5 | λ=0.5 hop=0.5 pin=1.5 K=12 | 0.922 | 0.231 | 0.369 |
| 6 | λ=0.5 hop=0.5 pin=4 K=12 | 0.922 | 0.231 | 0.369 |
| 7 | λ=0.4 hop=0.25 pin=2.5 K=12 | 0.922 | 0.231 | 0.369 |
| 8 | λ=0.4 hop=0.25 pin=1.5 K=12 | 0.922 | 0.231 | 0.369 |
| 9 | λ=0.4 hop=0.25 pin=4 K=12 | 0.922 | 0.231 | 0.369 |
| 10 | λ=0.6 hop=0.5 pin=2.5 K=12 | 0.917 | 0.229 | 0.367 |

## Default vs. baseline

| Rank | Params | Precision | Recall | F1 |
|---|---|---|---|---|
| 181/225 | λ=0.6 hop=0.5 pin=2.5 K=4 (DEFAULT) | 1.000 | 0.083 | 0.154 |
| best | λ=0.4 hop=0.5 pin=2.5 K=12 | 0.939 | 0.235 | 0.376 |
| — | ST-keyword baseline | 0.705 | 0.365 | 0.481 |

## Unsupervised stats at default params

| Metric | Scorer | ST-keyword |
|---|---|---|
| mean fired / floor | 4.000 | 24.867 |
| mean churn (|Δ fired| between consecutive floors) | 1.143 | 5.714 |

Scorer score distribution (non-constant, score > 0): p50 1.762 · p90 5.349 · max 26.399.

## Real vs. synthetic conclusion

**⚠ CONTRADICTION:** on real data the best combo (λ=0.4 hop=0.5 pin=2.5 K=12, F1 0.376) uses a LARGER topK than the synthetic-tuned default (topK 4, rank 181, F1 0.154). The synthetic suite favored a smaller topK; real proxy labels disagree. Do NOT act on this alone — investigate before changing defaults.

## Limitations

- **Proxy-label bias.** "Relevant = key appears in the stored response" is a keyword-flavored oracle: it
  rewards the ST-keyword behavior it is meant to be compared against, and mislabels both directions —
  entries the story *needed* but never named (needs-without-mention → false negatives) and entries merely
  *mentioned in passing* without narrative need (mentions-without-need → false positives).
- **Pins unexercised.** No real card declares `pin_paths`, so `pinBoost` (and pin-driven recall) is
  untested here; the synthetic suite is the only pinBoost evidence.
- **Small, homogeneous sample.** A single dev data dir with few chats is not representative; treat these
  numbers as a smoke signal, not a decision basis.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; proxy labels are too weak to retune `DEFAULT_SCORING_PARAMS`._
