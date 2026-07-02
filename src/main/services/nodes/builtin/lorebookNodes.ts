import { z } from 'zod'
import { Lorebook, LorebookEntry } from '../../../types/character'
import { GenContext } from '../../generation/types'
import { NodeImpl } from '../types'

/**
 * Lorebook selection/fetch nodes (context-epochs plan §2): per-call lorebook subsets a workflow
 * branch composes deterministically — NO keyword scan. Features like 世界推进 (world advancement)
 * make their own LLM call against a HAND-PICKED slice of the world's lorebooks (e.g. "the setting
 * books, but not 战斗规则"); these nodes produce that slice on a `Lore` (Lorebook[]) wire without
 * touching the main prompt's keyword-matched world info.
 *
 * All outputs are DEEP COPIES — `gen.lorebooks` is the shared session bundle and must never be
 * mutated by a downstream consumer (a select→entries chain, or a caller that trims entries).
 * Content is emitted RAW (no macro/EJS render), matching tool.lorebookSearch's convention.
 */

/** Split a comma-separated config string into lowercased, trimmed, non-empty terms (null = "no
 *  filter" = match everything). Shared by the book-name and entry-comment filters. */
export const parseCsvTerms = (s: string | undefined): string[] | null => {
  if (!s) return null
  const terms = s
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  return terms.length ? terms : null
}

/** Books whose `name` contains ANY of the terms (case-insensitive). null terms → all books.
 *  Same contains-matching semantics as tool.lorebookSearch's `book_filter`. */
export const filterBooksByName = (books: Lorebook[], terms: string[] | null): Lorebook[] =>
  terms ? books.filter((lb) => terms.some((t) => (lb.name ?? '').toLowerCase().includes(t))) : books

/** Whether an entry's `comment` contains ANY of the terms (case-insensitive). null terms → true
 *  (no filter). Used for the entry-level `entries`/`filter`/`exclude_entries` knobs. */
export const entryCommentMatches = (entry: LorebookEntry, terms: string[] | null): boolean =>
  terms == null || terms.some((t) => (entry.comment ?? '').toLowerCase().includes(t))

/** A wholly-independent copy of the books — including fresh `entries` arrays — so downstream
 *  filtering/mutation never reaches `gen.lorebooks`. */
export const deepCopyBooks = (books: Lorebook[]): Lorebook[] =>
  books.map((lb) => ({ ...lb, entries: lb.entries.map((e) => ({ ...e })) }))

const selectConfig = z.object({
  /** Comma-separated name filter (contains-match, case-insensitive). Empty = all session books. */
  books: z.string().optional(),
  /** Comma-separated comment substrings; an entry matching ANY term is KEPT. Empty = all entries. */
  entries: z.string().optional(),
  /** Comma-separated comment substrings applied AFTER `entries`; an entry matching ANY term is
   *  DROPPED (the 世界推进 "not 战斗规则" case). */
  exclude_entries: z.string().optional()
})

/** Filters the session's lorebooks (and their entries) down to a hand-picked subset on a `Lore`
 *  wire — deterministic, no keyword scan. Output books are DEEP COPIES with per-config-filtered
 *  entries; `gen.lorebooks` is never mutated. Empty config = all session books, copied. */
export const lorebookSelect: NodeImpl = {
  type: 'lorebook.select',
  title: 'Select Lorebooks',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'books', type: 'Lore' }],
  configSchema: selectConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = (node?.config ?? {}) as z.infer<typeof selectConfig>
    const nameTerms = parseCsvTerms(cfg.books)
    const keepTerms = parseCsvTerms(cfg.entries)
    const dropTerms = parseCsvTerms(cfg.exclude_entries)
    // Exclusion is only active when dropTerms is non-null; a null exclude filter drops nothing
    // (unlike entryCommentMatches, whose null-means-match-all convention would drop everything here).
    const excluded = (e: LorebookEntry): boolean =>
      dropTerms != null && entryCommentMatches(e, dropTerms)
    const picked = filterBooksByName(gen.lorebooks, nameTerms)
    const books = deepCopyBooks(picked).map((lb) => ({
      ...lb,
      entries: lb.entries.filter((e) => entryCommentMatches(e, keepTerms) && !excluded(e))
    }))
    return { outputs: { books } }
  }
}

const entriesConfig = z.object({
  /** Comma-separated comment substrings; an entry matching ANY term is kept. Empty = all entries. */
  filter: z.string().optional(),
  /** Keep only `constant` entries (always-on world info) when true. Default false. */
  constant_only: z.boolean().optional(),
  /** Hard cap on the returned BLOCK length in characters (0/unset = uncapped). */
  max_chars: z.number().int().min(0).max(100000).optional()
})

/** Deterministically fetches entry CONTENTS from a `Lore` subset (or gen.lorebooks when `books` is
 *  unwired) — no keyword scan. `block` is the raw contents joined by blank lines; `entries` is the
 *  matching `{ comment, content }` rows. `enabled === false` entries are always skipped. */
export const lorebookEntries: NodeImpl = {
  type: 'lorebook.entries',
  title: 'Lorebook Entries',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'books', type: 'Lore' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'block', type: 'Text' },
    { name: 'entries', type: 'Any' }
  ],
  configSchema: entriesConfig,
  run: (_ctx, inputs, node) => {
    const gen = inputs.gen as GenContext
    const cfg = (node?.config ?? {}) as z.infer<typeof entriesConfig>
    const source = (inputs.books as Lorebook[] | undefined) ?? gen.lorebooks
    const filterTerms = parseCsvTerms(cfg.filter)
    const rows: Array<{ comment: string; content: string }> = []
    for (const lb of source) {
      for (const e of lb.entries) {
        if (e.enabled === false) continue
        if (cfg.constant_only && !e.constant) continue
        if (!entryCommentMatches(e, filterTerms)) continue
        rows.push({ comment: e.comment ?? '', content: e.content })
      }
    }
    let block = rows
      .map((r) => r.content)
      .filter(Boolean)
      .join('\n\n')
    if (cfg.max_chars && block.length > cfg.max_chars) block = block.slice(0, cfg.max_chars)
    return { outputs: { block, entries: rows } }
  }
}
