# Lore-scoring real-data evaluation — adaptive selection (2026-07-24)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** Supersedes
lore-scoring-real-data-2026-07-23.md (point-in-time). Replays stored chats from the dev data dir against a
next-response proxy label: an enabled non-constant entry is "relevant" for floor N iff one of its primary
keys appears in the stored text of response N. λ/hop/pin are held at the current defaults; only the
selection knobs (maxK × minScore × relCut) are gridded. Metrics are micro-aggregated P/R/F1 vs. the proxy
(no hard negatives). `DEFAULT_SCORING_PARAMS` is NOT changed from these numbers (proxy is too weak).

## Sample size

- Chats replayed (≥4 floors): **1**
- (chat, floor) samples: **16**
- Lorebook entries in scope: **473**
- scanDepth: **3** · maxRecursion: **0** (app default; the keyword baseline uses the same)
- Pins: none (real cards declare no `pin_paths`) — **the `pinBoost` axis is NOT exercised by real data.**

## Selection-grid top 10 (by micro-F1)

| Rank | Params | Precision | Recall | F1 |
|---|---|---|---|---|
| 1 | maxK=16 min=0 rel=0 | 0.844 | 0.273 | 0.413 |
| 2 | maxK=16 min=0 rel=0.1 | 0.844 | 0.273 | 0.413 |
| 3 | maxK=16 min=0.15 rel=0 | 0.844 | 0.273 | 0.413 |
| 4 | maxK=16 min=0.15 rel=0.1 | 0.844 | 0.273 | 0.413 |
| 5 | maxK=16 min=0.3 rel=0 | 0.844 | 0.273 | 0.413 |
| 6 | maxK=16 min=0.3 rel=0.1 | 0.844 | 0.273 | 0.413 |
| 7 | maxK=16 min=0.6 rel=0 | 0.844 | 0.273 | 0.413 |
| 8 | maxK=16 min=0.6 rel=0.1 | 0.844 | 0.273 | 0.413 |
| 9 | maxK=16 min=1 rel=0 | 0.844 | 0.273 | 0.413 |
| 10 | maxK=16 min=1 rel=0.1 | 0.844 | 0.273 | 0.413 |

## Before / after / best / keyword

| Config | Params | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
| OLD (K=4, floor+cut off) | maxK=4 min=0 rel=0 | 1.000 | 0.081 | 0.150 | 4.000 | 1.067 |
| NEW default | maxK=4 min=0.6 rel=0.35 | 1.000 | 0.065 | 0.121 | 3.188 | 0.800 |
| grid best | maxK=16 min=0 rel=0 | 0.844 | 0.273 | 0.413 | 16.000 | 6.133 |
| ST-keyword | maxRecursion=0 | 0.713 | 0.362 | 0.480 | 25.063 | 6.000 |

## Recall recovery

**Does floor + relCut recover the recall a bare K=4 cap lost on the 473-entry book, while keeping
fired/floor and churn low? NO.** On this data, lifting recall requires a
large `maxK`: the grid best (maxK=16 min=0 rel=0) reaches recall 0.273
(vs. OLD K=4 recall 0.081) but only by firing 16.000/floor
with churn 6.133 — around the keyword baseline's 25.063/floor and churn
6.000. So the floor/relative-cut do NOT let a small `maxK` recover recall here; the score
distribution on this book is broad rather than sharply peaked, so few entries clear `relCut·top`.
Floor+relCut alone (NEW default, maxK=4 min=0.6 rel=0.35) instead trims the low-idf tail: it
slightly lowers recall vs. bare K=4 (0.065 vs. 0.081) but
cuts fired/floor (4.000 → 3.188) and churn
(1.067 → 0.800) — a precision / cache-stability move, not a recall lever.
The proxy label is keyword-flavored and structurally favors the broad keyword baseline on recall, so read
these as directional. `maxK` stays 4 by default (precision); raise it in the viewer to trade for recall.

## Limitations

- **Proxy-label bias.** "Relevant = key appears in the stored response" is a keyword-flavored oracle: it
  rewards the ST-keyword behavior it is meant to be compared against, and mislabels both directions —
  needs-without-mention (false negatives) and mentions-without-need (false positives).
- **Pins unexercised.** No real card declares `pin_paths`, so `pinBoost` is untested here.
- **Small, homogeneous sample.** A single dev data dir with few chats is a smoke signal, not a basis.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; proxy labels are too weak to retune `DEFAULT_SCORING_PARAMS`._
