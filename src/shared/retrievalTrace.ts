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
}

/** `retrieval-preview` response: the dry-run result, or a not-found error (unknown/empty chat or card). */
export type RetrievalPreviewResponse = RetrievalPreviewOk | { ok: false; code: 'not-found' }
