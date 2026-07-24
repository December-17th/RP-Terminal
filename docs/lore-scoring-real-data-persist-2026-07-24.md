# Lore-scoring real-data evaluation — persistence axis (2026-07-24)

**Status: PoC — debug window only; diagnostic, NOT a defaults decision.** This is the real-floor-data
replay extended to exercise the **persistence-bonus axis** (`persistBoost`) that the scorer gained in
`loreScoring.ts`. `prevFired` is threaded **sequentially per chat, in floor order**: the entries that
fired at floor i (keyed `bookName::entryIndex`) become the `prevFired` set for floor i+1 of the same
chat under the same params; the first floor of each chat starts from an empty set.

**The proxy is keyword-flavored and circular.** The label ("an enabled non-constant entry is relevant for
floor N iff one of its primary keys appears in the stored text of response N") rewards exactly the lexical
signal the scorer already keys on, so it CANNOT adjudicate a defaults change — it is a smoke test that the
codepath runs and a rough recall-vs-churn shape, nothing more. `DEFAULT_SCORING_PARAMS` is **NOT** changed
from these numbers.

Context pins are exercised: the replayed card declares one `pin_paths` entry (a location variable),
resolved **per floor (the floor N-1 stat_data snapshot the generation of floor N would have seen)**.
λ/hop are held at defaults and **pinBoost is fixed at 2.5** (the proxy cannot separate pinBoost
values — documented in the prior real-data doc); the grid sweeps maxK × minScore × relCut × persistBoost
(**108 combos**). Metrics are micro-aggregated P/R/F1 vs. the proxy; churn is the mean
floor-to-floor symmetric-difference of the fired set within a chat (same definition as the prior doc, so
numbers are comparable).

## Sample size + pin resolution

- Chats replayed (≥4 floors): **1** · (chat, floor) samples: **16** · entries: **473**
- scanDepth: **3** · maxRecursion: **0** · vars mode: **per-floor** · pins declared: **true**
- Floors with a resolved pin block: **16/16** · pin-hit entries: total **224**, mean **14.000/floor**, floors with ≥1 pin hit **16/16**
  (the location DOES match entry keys — the pin axis is genuinely exercised).

## Recall-vs-churn frontier (maxK × persistBoost, min=0.6 rel=0.35, pin=2.5) — HEADLINE

| maxK | persistBoost | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
| 4 | 1 | 1.000 | 0.081 | 0.150 | 4.000 | 0.533 |
| 4 | 1.5 | 1.000 | 0.081 | 0.150 | 4.000 | 0.133 |
| 4 | 2 | 1.000 | 0.081 | 0.150 | 4.000 | 0.000 |
| 8 | 1 | 1.000 | 0.162 | 0.279 | 8.000 | 0.933 |
| 8 | 1.5 | 0.992 | 0.161 | 0.277 | 8.000 | 0.000 |
| 8 | 2 | 0.992 | 0.161 | 0.277 | 8.000 | 0.000 |
| 12 | 1 | 0.885 | 0.215 | 0.346 | 12.000 | 1.733 |
| 12 | 1.5 | 0.854 | 0.208 | 0.334 | 12.000 | 0.133 |
| 12 | 2 | 0.844 | 0.205 | 0.330 | 12.000 | 0.000 |
| 16 | 1 | 0.680 | 0.220 | 0.333 | 16.000 | 1.867 |
| 16 | 1.5 | 0.682 | 0.211 | 0.323 | 15.313 | 0.133 |
| 16 | 2 | 0.679 | 0.209 | 0.319 | 15.188 | 0.133 |

_Read down a maxK block: raising `persistBoost` should hold last-floor entries in place — trading a little
precision for lower churn (cache stability) at equal-or-better recall. Read across maxK: a larger cap lifts
recall at the cost of more fires (and more churn). The owner's defaults call is where on this surface the
recall gain stops being worth the churn/context cost._

## Named comparisons

| Config | Params | Precision | Recall | F1 | fired/floor | churn |
|---|---|---|---|---|---|---|
| Current defaults | maxK=4 min=0.6 rel=0.35 persist=1 | 1.000 | 0.081 | 0.150 | 4.000 | 0.533 |
| Synthetic-grid winner | maxK=12 min=0.6 rel=0.35 persist=1.5 | 0.854 | 0.208 | 0.334 | 12.000 | 0.133 |
| Keyword baseline (segments+pins) | — | 0.713 | 0.362 | 0.480 | 25.063 | 6.000 |

## Grid top 10 (by micro-F1; pinBoost fixed at 2.5)

| Rank | Params | Precision | Recall | F1 |
|---|---|---|---|---|
| 1 | maxK=12 min=0 rel=0 persist=1 | 0.885 | 0.215 | 0.346 |
| 2 | maxK=12 min=0 rel=0.2 persist=1 | 0.885 | 0.215 | 0.346 |
| 3 | maxK=12 min=0 rel=0.35 persist=1 | 0.885 | 0.215 | 0.346 |
| 4 | maxK=12 min=0.3 rel=0 persist=1 | 0.885 | 0.215 | 0.346 |
| 5 | maxK=12 min=0.3 rel=0.2 persist=1 | 0.885 | 0.215 | 0.346 |
| 6 | maxK=12 min=0.3 rel=0.35 persist=1 | 0.885 | 0.215 | 0.346 |
| 7 | maxK=12 min=0.6 rel=0 persist=1 | 0.885 | 0.215 | 0.346 |
| 8 | maxK=12 min=0.6 rel=0.2 persist=1 | 0.885 | 0.215 | 0.346 |
| 9 | maxK=12 min=0.6 rel=0.35 persist=1 | 0.885 | 0.215 | 0.346 |
| 10 | maxK=12 min=0 rel=0 persist=1.5 | 0.854 | 0.208 | 0.334 |

_Grid best on this data: `maxK=12 min=0 rel=0 persist=1` (F1 0.346). This is the proxy's
own optimum, NOT a recommendation — the proxy rewards fire-everything recall, so its F1 optimum drifts to a
high maxK / low floor that would blow up real context budget._

## Limitations

- **Proxy is circular.** "Relevant = key appears in the stored response" rewards the exact lexical signal
  the scorer keys on and mislabels both directions (needs-without-mention, mentions-without-need). It
  under-credits pins and persistence: an entry the model KNEW but did not re-name counts as a false
  positive, and a correctly-persisted entry that goes unmentioned for a floor is scored as noise.
- **Persistence is self-referential here.** `prevFired` is the scorer's OWN prior-floor output, not a
  ground-truth "should have persisted" set — so the churn numbers describe the scorer's self-consistency,
  which `persistBoost` mechanically improves; they do not prove the persisted entries were the right ones.
- **One pin path, one card, 1 chat(s).** A single location variable on a single 473-entry
  book — a smoke signal that the persistence + pin codepaths run end-to-end, not a representative measure.
- **No recursion.** maxRecursion=0 (app default) — recursion-lifted retrieval is not measured.

_Diagnostic replay of local dev data; the proxy is too weak (and, for persistence, too circular) to retune
`DEFAULT_SCORING_PARAMS`._
