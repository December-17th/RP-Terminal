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

Adopted 2026-07-24 from the 8100-combo synthetic grid (best F1 0.919 on the 23-scenario suite), with
real-floor frontier confirmation (recall 0.081 → 0.208, churn 0.533 → 0.133 vs the earlier
maxK=4/persistBoost=1 defaults). See `docs/lore-scoring-tuning-persist-2026-07-24.md` (synthetic tuner) and
`docs/lore-scoring-real-data-persist-2026-07-24.md` (real-floor replay). Adaptive selection had already
raised micro-F1 0.838 → 0.954 and cut hard-negative violations 10 → 3 over the fixed-K baseline
(`docs/lore-scoring-tuning-2026-07-24.md`); the wider `maxK`=12 cap trades a little precision for full
recall on broad-evidence scenarios, and `persistBoost`=1.5 rewards cross-floor cache continuity.

| param         | default | meaning                                                            |
| ------------- | ------- | ------------------------------------------------------------------ |
| `lambda`      | 0.6     | recency decay base (`lambda ** depth`)                             |
| `hopDecay`    | 0.5     | one-hop link decay on a donor's seed score                         |
| `pinBoost`    | 2.5     | weight for a pin-block key hit                                     |
| `maxK`        | 12      | ceiling on how many non-constant entries may fire                  |
| `minScore`    | 0.6     | absolute score floor (0 disables it)                               |
| `relCut`      | 0.35    | relative cut: fire only entries ≥ `relCut · topScore` (0 off)      |
| `persistBoost`| 1.5     | multiplier on an entry that fired on the previous floor (1 off)    |

The IPC merges a caller's partial params over these and sanitizes them (non-finite/negative → default;
`maxK` floored to an int ≥ 0; `relCut` clamped to [0, 1]; `persistBoost` clamped to ≥ 1).

### Persistence bonus

`persistBoost` is a hysteresis multiplier applied to the FINAL score of an entry that fired on the
**previous** floor. The previous-floor fired set is reconstructed by a mirror dry-run and keyed
`bookName::entryIndex` (`prevFired`); a matching entry's score is multiplied by `persistBoost` before the
floor/cut/cap selection runs, so a persistently-relevant entry can survive a floor/cut/cap it would
otherwise fail. Because it multiplies an existing score, it **never resurrects a zero-evidence entry**
(0 × boost = 0) — the mechanic rewards cache continuity without inventing evidence. Rows where the
multiplier actually lifted a previous-floor entry above zero are flagged `persisted`.

## Known limitations

- Lexical only — keys-only evidence, no content-token / BM25 scoring, no slicing.
- Persistence (`persistBoost`) is a cross-floor sticky bonus, but there is still no cooldown, no token
  budget, and no group scoring.
- Single hop of spreading activation only.
- Stateless preview — nothing is journaled; independent of a turn's real retrieval.
