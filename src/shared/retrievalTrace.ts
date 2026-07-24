/**
 * Retrieval-comparison diagnostics (WP-D2). Pure data types shared by the main-process matcher trace
 * (`lorebookService.matchAcrossTraced`), the `retrieval-preview` IPC, and the Debug window's Retrieval
 * tab. Internal diagnostics only — NOT part of the card-facing SDK surface.
 *
 * Boundary: this module is pure (no main/renderer/electron imports) so both sides can share it.
 */

/** Why a considered lorebook entry did or did not qualify. `constant` = always-on entry; `key` = a
 *  keyword (primary + optional secondary) matched; `none` = no key matched (entry did not fire). */
export type RetrievalReason = 'constant' | 'key' | 'none'

/** One CONSIDERED lorebook entry in a dry-run retrieval pass. Byte-stable for a given (books, scanText,
 *  maxRecursion) input under a deterministic rng. */
export interface RetrievalTraceRow {
  /** The lorebook this entry came from (its `name`). */
  bookName: string
  /** Index of this entry within its book's `entries` array (the join key across baseline/rpt/scored). */
  entryIndex: number
  /** The entry's stable id when present (minted-on-save entries always have one). */
  entryId?: string
  /** Display label: the entry `comment`, falling back to the first ~40 chars of its content. */
  comment: string
  /** Did the entry fire (qualify + pass the probability roll) in this run? */
  fired: boolean
  reason: RetrievalReason
  /** The first primary key string that hit (regex keys reported as their slash-delimited source text). */
  matchedKey?: string
  /** For a `selective` entry: whether a secondary key also matched. */
  secondaryMatched?: boolean
  /** Which pass fired/considered the entry: 0 = base scan, 1.. = recursion passes. */
  recursionPass: number
  /** The entry's probability (0..100); the viewer badges it when < 100. */
  probability: number
  /** True when the entry could only be reached via recursion but its `exclude_recursion` flag blocked it. */
  excludedByRecursionFlag?: boolean
}

/** One pin path that resolved to a scan-text value in the dry-run. `adhoc` marks a path that came from
 *  the viewer's ad-hoc "try pin paths" input rather than the card's declared `pin_paths`. */
export interface ResolvedPinView {
  path: string
  value: string
  adhoc?: boolean
}

/**
 * Deterministic lore-scoring PoC (debug window only — NOT wired into generation). Tuning knobs for the
 * keyword-evidence + one-hop spreading-activation scorer (`loreScoring.scoreLoreEntries`). Lives here in
 * the pure shared module so the main scorer and the renderer viewer share one definition without the
 * renderer importing main. */
export interface ScoringParams {
  /** Recency decay base: a key hit at scan depth d contributes `lambda ** d`. */
  lambda: number
  /** One-hop spreading-activation decay applied to a neighbour's seed score. */
  hopDecay: number
  /** Weight a key gets when it matches the appended pin block (vs. transcript recency). */
  pinBoost: number
  /** Ceiling (NOT a quota) on how many non-constant entries may fire. */
  maxK: number
  /** Absolute score floor: an entry below this never fires (0 disables the floor). */
  minScore: number
  /** Relative cut in [0,1]: an entry scoring below `relCut * topScore` never fires (0 disables it). */
  relCut: number
  /** Persistence (hysteresis) multiplier ≥1 applied to the FINAL score of an entry that fired on the
   *  previous floor; 1 disables. Rewards cache continuity so a persistently-relevant entry survives the
   *  floor/cut/cap it would otherwise fail — but never resurrects a zero-evidence entry (0 × boost = 0). */
  persistBoost: number
}

/** Tuned on the synthetic scenario suite (docs/lore-scoring-tuning-2026-07-24.md). Selection is adaptive:
 *  an entry fires iff score > 0 AND score ≥ minScore AND score ≥ relCut·topScore AND fewer than maxK have
 *  fired. A sane floor + relative cut lets `maxK` be a generous ceiling while thin/weak evidence still
 *  fires nothing. Debug-only; real-card validation pending. */
export const DEFAULT_SCORING_PARAMS: ScoringParams = {
  lambda: 0.6,
  hopDecay: 0.5,
  pinBoost: 2.5,
  maxK: 4,
  minScore: 0.6,
  relCut: 0.35,
  persistBoost: 1
}

/** One weighted key-evidence hit contributing to an entry's seed score. `depth` is the lowest scan
 *  segment depth the key matched (null when it only matched via the pin block); `pin` marks a pin hit. */
export interface ScoredKeyHit {
  key: string
  depth: number | null
  pin: boolean
  idf: number
  weight: number
}

/** One scored lorebook entry in the deterministic-scorer PoC section. */
export interface ScoredEntryRow {
  bookName: string
  /** Index of this entry within its book's `entries` array (the join key across baseline/rpt/scored). */
  entryIndex: number
  entryId?: string
  comment: string
  /** Always-on entry (bypasses scoring; reported fired without consuming a top-K slot). */
  constant: boolean
  /** Constant, or ranked within the top-K by final score. */
  fired: boolean
  /** seedScore + linkBonus, rounded. */
  score: number
  seedScore: number
  linkBonus: number
  /** entry.probability / 100 (the seed-score multiplier). */
  probabilityFactor: number
  keyHits: ScoredKeyHit[]
  /** Label of the neighbour that donated the one-hop link bonus (present when linkBonus > 0). */
  linkFrom?: string
  /** Set when a `selective` entry failed its required secondary-key gate (score 0, no link activation). */
  disqualified?: 'secondary'
  /** True only when this entry was in the previous floor's fired set AND its final (boosted) score > 0,
   *  i.e. the persistence multiplier actually applied. Absent otherwise. */
  persisted?: boolean
  /** For a scored-but-not-fired entry (score > 0): the FIRST selection condition it failed — `floor`
   *  (below minScore), `cut` (below relCut·topScore), or `cap` (maxK already reached). */
  cutBy?: 'floor' | 'cut' | 'cap'
}

/** Successful `retrieval-preview` result: the base scan text + pin block, matcher tuning, pin status,
 *  and the two traces (RPT = base + [PINS]; baseline = base only). */
export interface RetrievalPreviewOk {
  ok: true
  /** The ST-style scan text (recent turns + pending action) — identical for both traces. */
  baseScanText: string
  /** The appended `[PINS]` block (leading newline), or '' when no pin resolves. */
  pinBlock: string
  scanDepth: number
  maxRecursion: number
  /** The card-declared pin paths (`data.extensions.rp_terminal.pin_paths`), in card order. */
  pinPaths: string[]
  /** The ad-hoc pin paths actually used this run (deduped, card-declared paths removed). */
  extraPinPaths: string[]
  /** Every pin path (declared + ad-hoc) that resolved to a value, in block order. */
  resolvedPins: ResolvedPinView[]
  /** RPT retrieval: matched against `baseScanText + pinBlock`. */
  rpt: RetrievalTraceRow[]
  /** ST-keyword baseline: matched against `baseScanText` alone (no pin block). */
  baseline: RetrievalTraceRow[]
  /** Names of the active lorebooks scanned. */
  lorebookNames: string[]
  /** Deterministic-scorer PoC ranking (debug window only — never influences generation). */
  scored: ScoredEntryRow[]
  /** The (sanitized) scoring params actually used for `scored`. */
  scoringParams: ScoringParams
  /** How many entries fired on the PREVIOUS floor's mirror dry-run — the anchor set the persistence
   *  multiplier (`persistBoost`) is applied against. 0 for a fresh chat with no previous floor. */
  prevFiredCount?: number
}

/** `retrieval-preview` response: the dry-run result, or a not-found error (unknown/empty chat or card). */
export type RetrievalPreviewResponse = RetrievalPreviewOk | { ok: false; code: 'not-found' }
