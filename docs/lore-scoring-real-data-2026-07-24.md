# Lore-scoring real-data evaluation — pin axis active (2026-07-24)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** Rerun of the 2026-07-24 real-data
evaluation with **context pins now exercised**: the replayed card declares one `pin_paths` entry (the
location variable), resolved **per floor (the floor N-1 stat_data snapshot the generation of floor N would have seen)**.
The pin block feeds both the scorer and the RPT keyword baseline the same way the live handler does; a
pinless ST keyword baseline is kept for reference. λ/hop are fixed at defaults; pinBoost × maxK × minScore ×
relCut are gridded (108 combos). Proxy label unchanged: an enabled non-constant entry is
"relevant" for floor N iff one of its primary keys appears in the stored text of response N. Metrics are
micro-aggregated P/R/F1 vs. the proxy. `DEFAULT_SCORING_PARAMS` is NOT changed from these numbers.

## Sample size + pin resolution

- Chats replayed (≥4 floors): **1** · (chat, floor) samples: **16** · entries: **473**
- scanDepth: **3** · maxRecursion: **0** · vars mode: **per-floor** · pins declared: **true**
- Floors with a resolved pin block: **16/16**
- **Pin-hit entries** (entries whose key matches the resolved location): total **224**, mean
  **14.000/floor**, floors with ≥1 pin hit **16/16**.
  The location DOES match entry keys — the pin axis is genuinely exercised.

## Selection+pin grid top 10 (by micro-F1)

| Rank | Params | Precision | Recall | F1 |
|---|---|---|---|---|
| 1 | pin=1.5 maxK=12 min=0 rel=0 | 0.927 | 0.225 | 0.363 |
| 2 | pin=1.5 maxK=12 min=0 rel=0.2 | 0.927 | 0.225 | 0.363 |
| 3 | pin=1.5 maxK=12 min=0.3 rel=0 | 0.927 | 0.225 | 0.363 |
| 4 | pin=1.5 maxK=12 min=0.3 rel=0.2 | 0.927 | 0.225 | 0.363 |
| 5 | pin=1.5 maxK=12 min=0.6 rel=0 | 0.927 | 0.225 | 0.363 |
| 6 | pin=1.5 maxK=12 min=0.6 rel=0.2 | 0.927 | 0.225 | 0.363 |
| 7 | pin=1.5 maxK=16 min=0 rel=0 | 0.719 | 0.233 | 0.352 |
| 8 | pin=1.5 maxK=16 min=0 rel=0.2 | 0.719 | 0.233 | 0.352 |
| 9 | pin=1.5 maxK=16 min=0.3 rel=0 | 0.719 | 0.233 | 0.352 |
| 10 | pin=1.5 maxK=16 min=0.3 rel=0.2 | 0.719 | 0.233 | 0.352 |

## Scorer with vs. without pins (default params) + keyword baselines

| Config | Params | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
| Scorer WITH pins | pin=2.5 maxK=4 min=0.6 rel=0.35 | 1.000 | 0.081 | 0.150 | 4.000 | 0.533 |
| Scorer WITHOUT pins | pin=2.5 maxK=4 min=0.6 rel=0.35 (pinText ∅) | 1.000 | 0.065 | 0.121 | 3.188 | 0.800 |
| grid best | pin=1.5 maxK=12 min=0 rel=0 | 0.927 | 0.225 | 0.363 | 12.000 | 1.467 |
| Keyword RPT (segments+pins) | — | 0.713 | 0.362 | 0.480 | 25.063 | — |
| Keyword ST (no pins) | — | 0.713 | 0.362 | 0.480 | 25.063 | — |

_Note: the two keyword baselines are identical — the current location is also named in the recent transcript, so appending the pin block adds no new keyword match for the unranked matcher. The pin only matters for the SCORER, which uses it to WEIGHT those entries so they survive the `maxK` cap._

## pinBoost sweep at default selection knobs

| pinBoost | Precision | Recall | F1 |
|---|---|---|---|
| 1.5 | 1.000 | 0.081 | 0.150 |
| 2.5 | 1.000 | 0.081 | 0.150 |
| 4 | 1.000 | 0.081 | 0.150 |

## Answers

- **Does the resolved pin match entry keys?** YES — 224 pin-hit entries total (mean 14.000/floor, 16/16 floors). The location string shares keys (place / realm names) with lorebook entries, so the pin block re-surfaces state-relevant entries.
- **Do pins change the fired set / metrics / churn vs. pinless (same params)?** YES — WITH pins vs WITHOUT: F1 0.150 vs 0.121, fired/floor 4.000 vs 3.188, churn 0.533 vs 0.800. Pinned location entries get a strong weight, so they hold their `maxK` slots across floors as the transcript moves on. Notably churn DROPS (0.800 → 0.533): a stable location re-surfaces the same entries each floor — a cache-stability win, which is the point of pins.
- **Does pinBoost matter, and does 2.5 hold?** Best pinBoost on this data = **1.5**. 2.5 is tied for the best here (F1 at pin 1.5/2.5/4.0 = 0.150 / 0.150 / 0.150); the proxy barely separates pinBoost values, so 2.5 remains a reasonable default.

## Limitations

- **Proxy-label bias.** "Relevant = key appears in the stored response" is keyword-flavored and mislabels
  both directions (needs-without-mention, mentions-without-need). It also under-credits pins: a pinned
  location that the model KNEW but did not re-name in the response counts as a false positive.
- **One pin path, one card, one chat.** A single location variable on a single 473-entry book — a
  smoke signal that the pin codepath runs end-to-end, not a representative measurement.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; proxy labels are too weak to retune `DEFAULT_SCORING_PARAMS`._
