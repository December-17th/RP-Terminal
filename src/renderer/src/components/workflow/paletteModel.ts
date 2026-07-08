// Pure palette model for the node-workflow editor. Two independent, React-free helpers used by the
// palette UI (WorkflowEditorView):
//   - groupPalette (RF-04): filter + group the flat NodeTypeInfo[] catalog into ordered categories.
//   - paletteMatch (agent & memory UX WP-G, spec §2): ONE search box filters BOTH palette sections
//     (the Agent library and the node-type list) via a case-insensitive multi-term match.
// No React, no store — plain functions over the catalog so they are unit-testable in isolation
// (test/workflow/paletteModel.test.ts).
import type { NodeTypeInfo } from '../../stores/workflowEditorStore'

export interface PaletteGroup {
  prefix: string
  items: NodeTypeInfo[]
}

/** Preferred category order — every prefix registered in the built-in catalog
 *  (`src/main/services/nodes/builtin/index.ts`), grouped by the dot-prefix of each node's `type`:
 *  triggers first, then the generation/prompt pipeline, then data (vars/table/lorebook/mvu), then
 *  composition (text/messages/merge), then tool/subgraph/control/util. Prefixes not listed here
 *  append alphabetically after these (see groupPalette). A type with no '.' groups under 'other'. */
export const PALETTE_ORDER: string[] = [
  'trigger',
  'input',
  'context',
  'prompt',
  'llm',
  'parse',
  'apply',
  'output',
  'agent',
  'history',
  'vars',
  'table',
  'lorebook',
  'mvu',
  'text',
  'messages',
  'merge',
  'tool',
  'subgraph',
  'control',
  'util'
]

const prefixOf = (type: string): string => {
  const dot = type.indexOf('.')
  return dot === -1 ? 'other' : type.slice(0, dot)
}

/** Filter by `query` (case-insensitive substring over the type id AND the localized title provided
 *  by `titleOf`), then group by the prefix before the first '.'; a type with no '.' groups under
 *  'other'. Groups ordered by PALETTE_ORDER then alphabetically; items keep catalog order. Empty
 *  groups are dropped. An empty/whitespace query returns everything. */
export function groupPalette(
  nodeTypes: NodeTypeInfo[],
  query: string,
  titleOf: (nt: NodeTypeInfo) => string
): PaletteGroup[] {
  const q = query.trim().toLowerCase()
  const filtered = q
    ? nodeTypes.filter(
        (nt) => nt.type.toLowerCase().includes(q) || titleOf(nt).toLowerCase().includes(q)
      )
    : nodeTypes

  const byPrefix = new Map<string, NodeTypeInfo[]>()
  for (const nt of filtered) {
    const prefix = prefixOf(nt.type)
    const bucket = byPrefix.get(prefix)
    if (bucket) bucket.push(nt)
    else byPrefix.set(prefix, [nt])
  }

  const rank = (prefix: string): number => {
    const i = PALETTE_ORDER.indexOf(prefix)
    return i === -1 ? PALETTE_ORDER.length : i
  }

  return [...byPrefix.keys()]
    .sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      return ra !== rb ? ra - rb : a.localeCompare(b)
    })
    .map((prefix) => ({ prefix, items: byPrefix.get(prefix)! }))
}

/** Case-insensitive multi-term match: every whitespace-separated term of `query` must appear in at
 *  least one of the entry's `texts` (title, type id, description, …). An empty/blank query matches
 *  everything (the palette shows all entries until the user types). */
export const paletteMatch = (query: string, texts: (string | undefined)[]): boolean => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = texts
    .filter((t): t is string => !!t)
    .join('\n')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
