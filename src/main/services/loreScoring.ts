/**
 * Deterministic lore-scoring PoC (ADR-free experiment) — DEBUG WINDOW ONLY.
 *
 * Scores lorebook entries by weighted keyword evidence plus one hop of spreading activation. It is a
 * side-effect-free, purely lexical ranking used exclusively by the `retrieval-preview` IPC's Debug
 * viewer. It NEVER runs on the generation path and does not change `matchAcross` / `matchAcrossTraced`.
 *
 * Boundary: no electron / renderer / IPC imports. It reuses `keyMatchesText` from the lorebook service so
 * key semantics (literal vs `/pattern/flags` regex, the case rule, invalid-regex fallback, lastIndex
 * reset) are byte-identical to the real matcher.
 */

import { Lorebook, LorebookEntry } from '../types/character'
import { keyMatchesText, RegexKeyCache } from './lorebookService'
import {
  ScoringParams,
  ScoredEntryRow,
  ScoredKeyHit,
  DEFAULT_SCORING_PARAMS
} from '../../shared/retrievalTrace'

export { DEFAULT_SCORING_PARAMS }
export type { ScoringParams }

/** One slice of the scan input. depth 0 = the pending user action, 1 = the newest floor, 2 = next, … */
export interface ScoreSegment {
  depth: number
  text: string
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4

/** Entry label: the comment, else the first ~40 chars of content (mirrors lorebookService.entryLabel). */
const labelOf = (entry: LorebookEntry): string =>
  entry.comment?.trim() || entry.content.slice(0, 40).trim()

/** Distinct keys preserving first-seen order, dropping empties. */
const distinctKeys = (keys: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of keys) {
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** One enabled entry paired with its stable enumeration context (book order, in-array index). */
interface Considered {
  entry: LorebookEntry
  bookName: string
  entryIndex: number // index within its book's `entries` array
  order: number // global enumeration index (book order, then array order) — the final deterministic key
  keys: string[] // distinct primary keys
}

/** Per-entry scoring scratch, filled across the passes. */
interface Scratch {
  c: Considered
  constant: boolean
  disqualified: boolean
  seedScore: number
  keyHits: ScoredKeyHit[]
  linkBonus: number
  linkFrom?: string
}

/**
 * Score enabled entries across all books. Pure and deterministic: identical inputs → deeply-equal output.
 * See the module header + `docs/lore-scoring-poc-2026-07-23.md` for the exact formula.
 */
export const scoreLoreEntries = (
  books: Array<{ name: string; lorebook: Lorebook }>,
  segments: ScoreSegment[],
  pinText: string,
  params: ScoringParams,
  /** Entries fired on the PREVIOUS floor, keyed `${bookName}::${entryIndex}` (the viewer rowKey format).
   *  Their final score is multiplied by `persistBoost` (hysteresis for cache stability). Default empty. */
  prevFired: ReadonlySet<string> = new Set()
): ScoredEntryRow[] => {
  const cache: RegexKeyCache = new Map() // one shared compiled-regex cache for the whole call
  const maxK = Number.isFinite(params.maxK) && params.maxK >= 0 ? Math.floor(params.maxK) : 0
  const minScore = Number.isFinite(params.minScore) && params.minScore >= 0 ? params.minScore : 0
  const relCut = Number.isFinite(params.relCut) ? Math.min(1, Math.max(0, params.relCut)) : 0
  // Persistence multiplier: non-finite or < 1 collapses to 1 (no-op). Never < 1, so 0 stays 0.
  const persistBoost =
    Number.isFinite(params.persistBoost) && params.persistBoost >= 1 ? params.persistBoost : 1
  const hasPin = pinText.length > 0
  // Full joined scan text used ONLY for the selective secondary-key gate.
  const fullScan = segments.map((s) => s.text).join('\n') + pinText

  // Enumerate enabled entries in book order (then array order) — this is "book order" everywhere below.
  const candidates: Considered[] = []
  for (const { name, lorebook } of books) {
    lorebook.entries.forEach((entry, entryIndex) => {
      if (!entry.enabled) return
      candidates.push({
        entry,
        bookName: name,
        entryIndex,
        order: candidates.length,
        keys: distinctKeys(entry.keys)
      })
    })
  }
  const N = candidates.length

  // --- idf: df(k) counts enabled entries whose content matches k (with the SCORING entry's case flag)
  // or that declare k verbatim. Memoized by raw key + case flag; df ≥ 1 (the declaring entry has k). ---
  const idfMemo = new Map<string, number>()
  const idfOf = (k: string, caseSensitive: boolean): number => {
    const memoKey = `${caseSensitive ? 'S' : 'i'}0000${k}`
    const cached = idfMemo.get(memoKey)
    if (cached !== undefined) return cached
    let df = 0
    for (const c of candidates) {
      if (c.entry.keys.includes(k) || keyMatchesText(k, c.entry.content, caseSensitive, cache)) df++
    }
    if (df < 1) df = 1
    const idf = Math.log(1 + N / df)
    idfMemo.set(memoKey, idf)
    return idf
  }

  // --- Per-entry gates + seed score ---
  const scratch: Scratch[] = candidates.map((c) => {
    const { entry } = c
    if (entry.constant) {
      return { c, constant: true, disqualified: false, seedScore: 0, keyHits: [], linkBonus: 0 }
    }
    // Selective hard gate: at least one secondary key must match the full joined scan text.
    if (entry.selective && entry.secondary_keys.length > 0) {
      const passed = entry.secondary_keys.some((sk) =>
        keyMatchesText(sk, fullScan, entry.case_sensitive, cache)
      )
      if (!passed) {
        return { c, constant: false, disqualified: true, seedScore: 0, keyHits: [], linkBonus: 0 }
      }
    }
    const hits: ScoredKeyHit[] = []
    let seed = 0
    for (const k of c.keys) {
      // Lowest depth where k matches a segment → recency weight lambda ** depth.
      let minDepth: number | null = null
      for (const seg of segments) {
        if (keyMatchesText(k, seg.text, entry.case_sensitive, cache)) {
          if (minDepth === null || seg.depth < minDepth) minDepth = seg.depth
        }
      }
      const recencyWeight = minDepth === null ? 0 : Math.pow(params.lambda, minDepth)
      const pinHit = hasPin && keyMatchesText(k, pinText, entry.case_sensitive, cache)
      const pinWeight = pinHit ? params.pinBoost : 0
      const weight = Math.max(recencyWeight, pinWeight)
      if (weight === 0) continue
      const idf = idfOf(k, entry.case_sensitive)
      const contribution = idf * weight
      if (contribution === 0) continue
      hits.push({ key: k, depth: minDepth, pin: pinHit, idf: round4(idf), weight: round4(weight) })
      seed += contribution
    }
    seed *= entry.probability / 100
    return { c, constant: false, disqualified: false, seedScore: seed, keyHits: hits, linkBonus: 0 }
  })

  // --- One-hop spreading activation. Edge A→B when A can activate B (A's content names a B key) and
  // neither flag blocks it; linkBonus(B) = hopDecay * max seed of an inbound A (seed > 0). One hop only. ---
  // Deterministic tie-break for the donor: bookName asc, then in-array index asc, then enumeration order.
  const donorBefore = (a: Considered, b: Considered): boolean => {
    if (a.bookName !== b.bookName) return a.bookName < b.bookName
    if (a.entryIndex !== b.entryIndex) return a.entryIndex < b.entryIndex
    return a.order < b.order
  }
  for (const B of scratch) {
    const be = B.c.entry
    if (B.constant || B.disqualified || be.exclude_recursion) continue
    let best: Scratch | null = null
    for (const A of scratch) {
      if (A === B) continue
      if (A.disqualified || A.seedScore <= 0) continue // constants have seed 0 → skipped here
      if (A.c.entry.prevent_recursion) continue
      const hasEdge = B.c.keys.some((k) =>
        keyMatchesText(k, A.c.entry.content, be.case_sensitive, cache)
      )
      if (!hasEdge) continue
      if (
        best === null ||
        A.seedScore > best.seedScore ||
        (A.seedScore === best.seedScore && donorBefore(A.c, best.c))
      ) {
        best = A
      }
    }
    if (best) {
      B.linkBonus = params.hopDecay * best.seedScore
      B.linkFrom = labelOf(best.c.entry) || `${best.c.bookName}#${best.c.entryIndex}`
    }
  }

  // An entry persists when it fired last floor (same rowKey). The multiplier applies to the FINAL score
  // of non-constant, non-disqualified entries only; because persistBoost ≥ 1, a zero base stays zero.
  const inPrevFired = (s: Scratch): boolean =>
    prevFired.has(`${s.c.bookName}::${s.c.entryIndex}`)
  const finalScoreOf = (s: Scratch): number =>
    s.constant || s.disqualified
      ? 0
      : (s.seedScore + s.linkBonus) * (inPrevFired(s) ? persistBoost : 1)

  // --- Selection: rank non-constant, non-disqualified entries with final score > 0. Top-K fire. ---
  const ranked = scratch
    .filter((s) => !s.constant && !s.disqualified && finalScoreOf(s) > 0)
    .sort((x, y) => {
      const fx = finalScoreOf(x)
      const fy = finalScoreOf(y)
      if (fx !== fy) return fy - fx // score desc
      if (x.c.entry.insertion_order !== y.c.entry.insertion_order)
        return x.c.entry.insertion_order - y.c.entry.insertion_order
      if (x.c.bookName !== y.c.bookName) return x.c.bookName < y.c.bookName ? -1 : 1
      if (x.c.entryIndex !== y.c.entryIndex) return x.c.entryIndex - y.c.entryIndex
      return x.c.order - y.c.order
    })
  // Adaptive selection (ranked desc, all score > 0). Fire iff score ≥ minScore AND score ≥ relCut·topScore
  // AND fewer than maxK have fired. A non-firing entry records the FIRST failed condition (floor→cut→cap)
  // so the viewer can explain why. topScore < minScore ⇒ nothing fires (thin evidence → zero, by design).
  const topScore = ranked.length > 0 ? finalScoreOf(ranked[0]) : 0
  const relFloor = relCut * topScore
  const firedSet = new Set<Scratch>()
  const cutOf = new Map<Scratch, 'floor' | 'cut' | 'cap'>()
  let firedCount = 0
  for (const s of ranked) {
    const sc = finalScoreOf(s) // > 0 by construction
    if (sc < minScore) cutOf.set(s, 'floor')
    else if (sc < relFloor) cutOf.set(s, 'cut')
    else if (firedCount >= maxK) cutOf.set(s, 'cap')
    else {
      firedSet.add(s)
      firedCount++
    }
  }

  const toRow = (s: Scratch, fired: boolean, cutBy?: 'floor' | 'cut' | 'cap'): ScoredEntryRow => {
    const { entry } = s.c
    const row: ScoredEntryRow = {
      bookName: s.c.bookName,
      entryIndex: s.c.entryIndex,
      ...(entry.id ? { entryId: entry.id } : {}),
      comment: labelOf(entry),
      constant: s.constant,
      fired,
      score: round4(finalScoreOf(s)),
      seedScore: round4(s.seedScore),
      linkBonus: round4(s.linkBonus),
      probabilityFactor: round4(entry.probability / 100),
      keyHits: s.keyHits,
      ...(s.linkBonus > 0 && s.linkFrom ? { linkFrom: s.linkFrom } : {}),
      ...(s.disqualified ? { disqualified: 'secondary' as const } : {}),
      // persisted only when the boost was a real multiplier (>1), the entry fired last floor, and the
      // boosted score is > 0. A persistBoost of 1 (or empty prevFired) leaves the flag off entirely.
      ...(persistBoost > 1 && inPrevFired(s) && finalScoreOf(s) > 0 ? { persisted: true as const } : {}),
      ...(!fired && cutBy ? { cutBy } : {})
    }
    return row
  }

  // Output order: constants (book order) → ranked scored (desc) → zero-score entries (book order).
  const rankedRows = ranked.map((s) => toRow(s, firedSet.has(s), cutOf.get(s)))
  const constantRows = scratch.filter((s) => s.constant).map((s) => toRow(s, true))
  const rankedSet = new Set(ranked)
  const zeroRows = scratch
    .filter((s) => !s.constant && !rankedSet.has(s))
    .map((s) => toRow(s, false))

  return [...constantRows, ...rankedRows, ...zeroRows]
}
