import { z } from 'zod'
import { NodeImpl, NodeRunFailure } from '../types'
import { extractTagAll, extractTagAllWithAttrs, type TagWithAttrs } from '../../../../shared/memory/tagExtract'

/**
 * Generic text-extraction node — deliberately table-AGNOSTIC (it's the plot-preset `extractTags`
 * equivalent, usable by any side branch, not just table memory). Given text and a tag name (or a
 * user regex), it emits the first match and all matches; a `found` Signal fires only when there's
 * at least one match, so a downstream branch can gate on "the reply carried this tag". Lives here in
 * a general `parseNodes.ts`, NOT with the table nodes.
 *
 * The PURE extractors (`extractTagAll` / `extractTagAllWithAttrs`) moved to
 * `shared/memory/tagExtract.ts` (execution-plan M5b) so survivors outside the node system keep them
 * after M5c deletes this file; re-exported here so the existing node-internal importers are unchanged.
 */

export { extractTagAll, extractTagAllWithAttrs }
export type { TagWithAttrs }

const extractConfig = z.object({
  /** 'tag' matches `<name>…</name>`; 'regex' runs a user-supplied pattern. Default 'tag'. */
  mode: z.enum(['tag', 'regex']).optional(),
  /** Tag name for 'tag' mode (e.g. `char_info`). */
  tag: z.string().optional(),
  /** Pattern for 'regex' mode. */
  pattern: z.string().optional(),
  /** Regex flags for 'regex' mode; defaults to 'g' (always forced to include 'g' internally). */
  flags: z.string().optional()
})

type ExtractConfig = z.infer<typeof extractConfig>

/**
 * Pull matches out of `text`. In 'tag' mode: every `<tag>…</tag>` (non-greedy, dotall,
 * case-insensitive), the captured inner content. In 'regex' mode: `new RegExp(pattern, flags)` (the
 * 'g' flag is forced so `matchAll` walks every match); the CAPTURED value is group 1 when the
 * pattern has one, else the whole match. A bad user regex → class-B `bad-pattern` (never a crash).
 */
const extractMatches = (text: string, cfg: ExtractConfig): string[] => {
  const mode = cfg.mode ?? 'tag'
  if (mode === 'tag') return extractTagAll(text, cfg.tag ?? '')
  const pattern = cfg.pattern ?? ''
  if (!pattern) return []
  let flags = cfg.flags ?? 'g'
  if (!flags.includes('g')) flags += 'g'
  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch (error) {
    throw new NodeRunFailure(
      'B',
      `parse.extract: invalid regex — ${error instanceof Error ? error.message : String(error)}`,
      1,
      'bad-pattern'
    )
  }
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    out.push((m[1] !== undefined ? m[1] : m[0]) ?? '')
  }
  return out
}

/**
 * `parse.extract` — extract tagged/regex content from text. No/blank input text → empty outputs and
 * NO `found` signal (the memory.query blank-input contract). `first` is the first match ('' when
 * none), `all` the string[] of every match.
 */
export const parseExtract: NodeImpl = {
  type: 'parse.extract',
  title: 'Extract Text',
  inputs: [
    { name: 'text', type: 'Text' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'first', type: 'Text' },
    { name: 'all', type: 'Any' },
    { name: 'found', type: 'Signal' }
  ],
  configSchema: extractConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as ExtractConfig
    const text = typeof inputs.text === 'string' ? inputs.text : ''
    if (!text) return { outputs: { first: '', all: [] } }
    const matches = extractMatches(text, cfg)
    if (matches.length === 0) return { outputs: { first: '', all: [] } }
    return { outputs: { first: matches[0], all: matches }, signals: ['found'] }
  }
}
