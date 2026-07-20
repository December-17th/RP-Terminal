/**
 * PURE tag/attribute extractors — the reference `extractTags` primitives shared by every memory
 * agent (maintain / notes / recall), the table-maintainer loop, and the (still-present) `parse.extract`
 * node. Extracted verbatim out of `main/services/nodes/builtin/parseNodes.ts` (execution-plan M5b) so
 * the load-bearing survivors keep working after M5c deletes the node-wrapper files: these functions are
 * pure string transforms with ZERO main/electron dependencies, so they live in `src/shared` where both
 * processes and tests can use them and no boundary is crossed.
 */

/** Escape a tag name so it can be embedded literally into a RegExp. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * PURE tag extractor (issue 07): every `<tag>…</tag>` inner content in `text` (non-greedy, dotall,
 * case-insensitive). Shared by the backfill service, which reuses the node's tag-mode logic without
 * copying it; the node's own `extractMatches` (with regex mode) delegates here for the tag path.
 * A blank tag or no match → [].
 */
export const extractTagAll = (text: string, tag: string): string[] => {
  const name = tag.trim()
  if (!name) return []
  const re = new RegExp(`<${escapeRegExp(name)}>([\\s\\S]*?)</${escapeRegExp(name)}>`, 'gi')
  const out: string[] = []
  for (const m of text.matchAll(re)) out.push(m[1] ?? '')
  return out
}

/** One `<tag …attrs…>…</tag>` match: its parsed (lower-cased key) quoted attributes + inner content. */
export interface TagWithAttrs {
  attrs: Record<string, string>
  content: string
}

/** Attribute scanner — QUOTED values only (double or single quotes); unquoted attributes are ignored.
 *  Keys are lower-cased so lookups are case-insensitive. */
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g

/**
 * PURE attribute-aware tag extractor (plot-recall WP6): every `<tag …attrs…>…</tag>` in `text`
 * (non-greedy, dotall, case-insensitive), returning each occurrence's parsed quoted attributes and
 * inner content. Powers `notes.maintain`'s `<MemoryNote section="…" mode="append|replace">…` parse.
 * A blank tag name, no match, or a malformed (never-closed) tag → [] (it never throws). Attributes may
 * appear in any order; only quoted values are captured; the attribute segment forbids `<`/`>` so a
 * missing `>` cannot swallow the rest of the document.
 */
export const extractTagAllWithAttrs = (text: string, tag: string): TagWithAttrs[] => {
  const name = tag.trim()
  if (!name) return []
  const re = new RegExp(
    `<${escapeRegExp(name)}((?:\\s[^<>]*)?)>([\\s\\S]*?)</${escapeRegExp(name)}>`,
    'gi'
  )
  const out: TagWithAttrs[] = []
  for (const m of text.matchAll(re)) {
    const attrs: Record<string, string> = {}
    for (const a of (m[1] ?? '').matchAll(ATTR_RE)) {
      const key = a[1] ?? a[3]
      if (key) attrs[key.toLowerCase()] = a[2] ?? a[4] ?? ''
    }
    out.push({ attrs, content: m[2] ?? '' })
  }
  return out
}
