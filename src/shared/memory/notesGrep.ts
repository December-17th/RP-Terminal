/**
 * notesGrep — pure grep/parse/merge engine for the per-chat plot-recall notes file.
 *
 * PURE MODULE: no fs / electron / main / renderer imports (depcruise `shared-not-to-main-renderer`).
 * It operates only on the notes markdown STRING; the file store (WP2) reads/writes it.
 *
 * Notes-file format (see docs/grep-notes-memory-design.md):
 *   ## Heading
 *   <!-- keywords: alpha, beta -->      (optional metadata line, comma-separated)
 *   Body prose, possibly multiple lines.
 *
 *   ## Another heading
 *   ...
 *
 * Sections are delimited by `##` ATX headings. A heading- or keyword-hit surfaces the WHOLE section;
 * a body-only hit surfaces `grep -C`-style context around the matching lines.
 *
 * CJK-SAFETY (binding review finding): JS `\b` word boundaries never match adjacent to CJK
 * codepoints (CJK chars are not in `\w`), so a Latin word-boundary wrap silently breaks Chinese
 * queries. `grepSections` therefore only applies word-boundary wrapping to Latin-script queries and
 * falls back to plain (unwrapped) matching for queries containing CJK. A query that fails to compile
 * as a regex falls back to LITERAL substring matching — it never throws (the fail-to-literal
 * contract; contrast `parseNodes.ts` extractMatches, whose guard THROWS a NodeRunFailure).
 */

/** A parsed notes section: its heading, optional keyword metadata, and body prose. */
export interface NotesSection {
  heading: string
  keywords: string[]
  body: string
}

/** A grep hit. `whole` = heading/keyword match (surface the entire section); otherwise `context`
 * holds `grep -C`-style context slices around the body lines that matched. */
export interface SectionHit {
  section: NotesSection
  whole: boolean
  context?: string
}

export interface GrepOptions {
  /** default false — matching is case-insensitive unless set. */
  caseSensitive?: boolean
  /** default true — wrap Latin queries in `\b…\b`; ignored for CJK queries. */
  wordBoundary?: boolean
  /** default 2 — lines of context on each side of a body-line hit (`grep -C`). */
  context?: number
}

export interface FormatOptions {
  /** cap on the number of sections included. */
  maxSections?: number
  /** cap on total characters of the rendered output. */
  maxChars?: number
}

export type NoteEditMode = 'append' | 'replace'

export interface NoteEdit {
  heading: string
  body: string
  /** default 'replace'. */
  mode?: NoteEditMode
  /** only applied when creating a new section (or explicitly overriding metadata). */
  keywords?: string[]
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Common CJK ranges: Han (+ Extension A), compatibility ideographs, Hiragana/Katakana, Hangul, and
// halfwidth kana. Detecting any of these means we must NOT apply Latin word boundaries.
const CJK_RE =
  /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯ｦ-ﾝ]/

const HEADING_RE = /^#{2}\s+(.+?)\s*$/
const KEYWORDS_RE = /<!--\s*keywords:\s*(.*?)\s*-->/i

/**
 * Build a matcher regex for `query`. Latin queries get `\b…\b` (when `wordBoundary`); CJK queries do
 * not. Any compilation failure (bad user regex, or a wrap that produced an invalid pattern) falls
 * back to a LITERAL substring match of the raw query — never throws.
 */
const compileMatcher = (query: string, opts: GrepOptions): RegExp | null => {
  const q = query.trim()
  if (!q) return null
  const flags = (opts.caseSensitive ? '' : 'i') + 'g'
  const hasCjk = CJK_RE.test(q)
  const wrap = (opts.wordBoundary ?? true) && !hasCjk
  const pattern = wrap ? `\\b(?:${q})\\b` : q
  try {
    return new RegExp(pattern, flags)
  } catch {
    // fail-to-literal: escape the raw query and match it as a plain substring.
    return new RegExp(escapeRegExp(q), flags)
  }
}

const matchesLine = (re: RegExp, text: string): boolean => {
  re.lastIndex = 0
  return re.test(text)
}

/** Merge overlapping/adjacent context ranges and render them, `grep`-style, separated by `...`. */
const contextFor = (re: RegExp, body: string, context: number): string => {
  const lines = body.split('\n')
  const matched: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (matchesLine(re, lines[i])) matched.push(i)
  }
  if (matched.length === 0) return ''
  const ranges: Array<{ start: number; end: number }> = []
  for (const i of matched) {
    const start = Math.max(0, i - context)
    const end = Math.min(lines.length - 1, i + context)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }
  return ranges
    .map((r) => lines.slice(r.start, r.end + 1).join('\n').trim())
    .filter(Boolean)
    .join('\n...\n')
}

/** A parsed notes document: any pre-first-heading `preamble` text plus the addressable `sections`. */
export interface NotesDocument {
  /** Verbatim text before the first `##` heading (trailing newlines trimmed). '' when there is none. */
  preamble: string
  sections: NotesSection[]
}

/**
 * Split notes markdown into its preamble (any text before the first `##` heading) and its sections
 * (the addressable/mergeable unit). Each section captures an optional `<!-- keywords: … -->` line
 * (removed from the body) and the trimmed body prose. The preamble is preserved verbatim (only trailing
 * whitespace trimmed) so a hand-written intro survives a parse→serialize round-trip (`mergeNotes`).
 */
export const parseNotesDocument = (notes: string | null | undefined): NotesDocument => {
  const lines = (notes ?? '').split(/\r?\n/)
  const sections: NotesSection[] = []
  const preambleLines: string[] = []
  let sawHeading = false
  let heading: string | null = null
  let bodyLines: string[] = []

  const flush = (): void => {
    if (heading === null) return
    let keywords: string[] = []
    let rest = bodyLines
    const kwIdx = rest.findIndex((l) => KEYWORDS_RE.test(l))
    if (kwIdx !== -1) {
      const m = KEYWORDS_RE.exec(rest[kwIdx])
      keywords = (m?.[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      rest = rest.slice(0, kwIdx).concat(rest.slice(kwIdx + 1))
    }
    sections.push({ heading, keywords, body: rest.join('\n').trim() })
  }

  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      flush()
      sawHeading = true
      heading = m[1].trim()
      bodyLines = []
    } else if (heading !== null) {
      bodyLines.push(line)
    } else if (!sawHeading) {
      preambleLines.push(line)
    }
  }
  flush()
  // Trailing-whitespace-trimmed so an empty/blank-only preamble round-trips to exactly '' (no drift).
  const preamble = preambleLines.join('\n').replace(/\s+$/, '')
  return { preamble, sections }
}

/**
 * Split notes markdown into sections. Text before the first `##` heading is preamble and is dropped
 * from the section list (sections are the addressable/mergeable unit) — use `parseNotesDocument` when
 * the preamble must be preserved. Each section captures an optional `<!-- keywords: … -->` line
 * (removed from the body) and the trimmed body prose.
 */
export const parseNotesSections = (notes: string | null | undefined): NotesSection[] =>
  parseNotesDocument(notes).sections

/**
 * Grep `sections` for `query`. A heading- or keyword-match surfaces the whole section; a body-only
 * match surfaces `grep -C`-style context. CJK-safe and never throws (see module header).
 */
export const grepSections = (
  sections: NotesSection[],
  query: string,
  opts: GrepOptions = {}
): SectionHit[] => {
  const re = compileMatcher(query, opts)
  if (!re) return []
  const context = opts.context ?? 2
  const hits: SectionHit[] = []
  for (const section of sections) {
    if (
      matchesLine(re, section.heading) ||
      section.keywords.some((k) => matchesLine(re, k))
    ) {
      hits.push({ section, whole: true })
      continue
    }
    const ctx = contextFor(re, section.body, context)
    if (ctx) hits.push({ section, whole: false, context: ctx })
  }
  return hits
}

/**
 * Render hits as a markdown block. Whole-section hits emit heading + full body; body hits emit
 * heading + context. Respects `maxSections` (count cap) and `maxChars` (hard character cap).
 */
export const formatHits = (hits: SectionHit[], opts: FormatOptions = {}): string => {
  const maxSections = opts.maxSections ?? Infinity
  const maxChars = opts.maxChars ?? Infinity
  const chosen = hits.slice(0, Math.max(0, maxSections))
  const blocks = chosen.map((h) => {
    const bodyText = h.whole ? h.section.body : (h.context ?? '')
    return `## ${h.section.heading}\n${bodyText}`.trimEnd()
  })
  let out = blocks.join('\n\n')
  if (out.length > maxChars) out = out.slice(0, Math.max(0, maxChars)).trimEnd()
  return out
}

const serializeSections = (sections: NotesSection[], preamble = ''): string => {
  const pre = preamble.trim() ? `${preamble.replace(/\s+$/, '')}\n` : ''
  // Preamble-only (no sections): preserve the intro verbatim; empty preamble → '' (byte-identical).
  if (sections.length === 0) return pre
  const blocks = sections.map((s) => {
    const parts = [`## ${s.heading}`]
    if (s.keywords.length) parts.push(`<!-- keywords: ${s.keywords.join(', ')} -->`)
    const body = s.body.trim()
    if (body) parts.push(body)
    return parts.join('\n')
  })
  // A non-empty preamble is separated from the first heading by a blank line.
  return (pre ? `${pre}\n` : '') + blocks.join('\n\n') + '\n'
}

/**
 * Upsert sections by case-insensitive heading. `replace` (default) swaps the body; `append` adds to
 * it; an unknown heading creates a new section at the end. Any pre-first-heading preamble text is
 * preserved verbatim at the top. Returns the re-serialized markdown.
 */
export const mergeNotes = (
  existing: string | null | undefined,
  edits: NoteEdit[] | null | undefined
): string => {
  const { preamble, sections } = parseNotesDocument(existing)
  for (const edit of edits ?? []) {
    const heading = edit.heading.trim()
    if (!heading) continue
    const mode = edit.mode ?? 'replace'
    const incoming = edit.body.trim()
    const idx = sections.findIndex(
      (s) => s.heading.toLowerCase() === heading.toLowerCase()
    )
    if (idx === -1) {
      sections.push({ heading, keywords: edit.keywords ?? [], body: incoming })
      continue
    }
    const cur = sections[idx]
    const body =
      mode === 'append' ? [cur.body, incoming].filter(Boolean).join('\n\n') : incoming
    sections[idx] = { ...cur, body, keywords: edit.keywords ?? cur.keywords }
  }
  return serializeSections(sections, preamble)
}
