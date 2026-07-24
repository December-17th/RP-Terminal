# Deterministic lore-scoring PoC (2026-07-23)

**Status: PoC — debug window only, no production wiring.** This scorer runs ONLY inside the Debug
window's Retrieval viewer (`retrieval-preview` IPC). It does NOT touch the generation/assembly path, and
it does NOT change `matchAcross` / `matchAcrossTraced`. It is a purely lexical, deterministic ranking
used to eyeball "what a weighted retrieval MIGHT surface" next to the real keyword matcher.

Code: `src/main/services/loreScoring.ts` (pure), types in `src/shared/retrievalTrace.ts`, wired in
`src/main/ipc/debugIpc.ts`, rendered in `src/renderer/src/components/debug/RetrievalPanel.tsx`.

## Formula

For each **enabled** entry across all active books:

1. **Hard gates first**
   - `constant: true` → fired, no scoring, does NOT consume a `maxK` slot.
   - `selective` with secondary keys → at least one secondary key must match the full joined scan text
     (all segments + pin text); otherwise `disqualified: 'secondary'`, score 0, and it neither seeds nor
     receives link activation.
2. **Key evidence** — for each DISTINCT primary key `k`:
   - `recencyWeight = lambda ** d` where `d` = lowest scan depth the key matched (0 = pending action,
     1 = newest floor, …), or 0 if no segment matched.
   - `pinWeight = pinBoost` if `k` matches the pin block, else 0.
   - `idf(k) = ln(1 + N / df(k))`, `N` = enabled entry count, `df(k)` = enabled entries whose content
     matches `k` (with the scoring entry's case flag) or that declare `k` verbatim (df ≥ 1).
   - `contribution_k = idf(k) * max(recencyWeight, pinWeight)` (0-weight keys omitted).
   - `seedScore = (Σ contribution_k) * (probability / 100)`.
3. **One-hop spreading activation** — edge `A→B` when `A` (enabled, not `prevent_recursion`) has content
   naming one of `B`'s keys, `B` is enabled / not `exclude_recursion` / not constant / not disqualified,
   `A ≠ B`. `linkBonus(B) = hopDecay * max(seedScore(A))` over inbound donors with `seedScore > 0`. One
   hop only — link bonuses never chain. `linkFrom` records the argmax donor (ties: bookName asc, index asc).
4. `finalScore = seedScore + linkBonus`.

### Adaptive selection

Rank the non-constant, non-disqualified entries with `finalScore > 0` (desc; ties: insertion_order,
bookName, index). Let `topScore` = the highest-ranked score. Iterating in rank order, an entry **fires
iff** `score > 0` AND `score ≥ minScore` AND `score ≥ relCut · topScore` AND fewer than `maxK` have
already fired. `maxK` is a **ceiling, not a quota**: `minScore = 0` disables the floor, `relCut = 0`
disables the relative cut (so `minScore = 0` + `relCut = 0` reproduces the old fixed top-K), and if
`topScore < minScore` nothing fires (thin evidence → zero, by design). A scored-but-not-fired entry
records the FIRST condition it failed as `cutBy`: `floor` (below `minScore`) → `cut` (below
`relCut · topScore`) → `cap` (`maxK` reached).

Key matching reuses `lorebookService.keyMatchesText`, so literal/regex/case semantics are identical to
the real matcher.

## Params (defaults)

Tuned on the synthetic scenario suite — see `docs/lore-scoring-tuning-2026-07-24.md` (adaptive selection
raised micro-F1 0.838 → 0.954 and cut hard-negative violations 10 → 3 over the fixed-K baseline).

| param      | default | meaning                                                        |
| ---------- | ------- | -------------------------------------------------------------- |
| `lambda`   | 0.6     | recency decay base (`lambda ** depth`)                         |
| `hopDecay` | 0.5     | one-hop link decay on a donor's seed score                     |
| `pinBoost` | 2.5     | weight for a pin-block key hit                                 |
| `maxK`     | 4       | ceiling on how many non-constant entries may fire              |
| `minScore` | 0.6     | absolute score floor (0 disables it)                           |
| `relCut`   | 0.35    | relative cut: fire only entries ≥ `relCut · topScore` (0 off)  |

The IPC merges a caller's partial params over these and sanitizes them (non-finite/negative → default;
`maxK` floored to an int ≥ 0; `relCut` clamped to [0, 1]).

## Known limitations

- Lexical only — keys-only evidence, no content-token / BM25 scoring, no slicing.
- No persistence/sticky bonus, no cooldown, no token budget, no group scoring.
- Single hop of spreading activation only.
- Stateless preview — nothing is journaled; independent of a turn's real retrieval.
