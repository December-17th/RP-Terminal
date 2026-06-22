import { Lorebook } from '../types/character'
import { parseJsObject } from '../parsers/mvuParser'

/**
 * MVU schema / initialization (Track R / R2). Seeds the initial `stat_data` for a
 * new session from two layers:
 *   1. the card's native defaults (`extensions.rp_terminal.state_schema.defaults`), and
 *   2. `[initvar]` (and ST-Prompt-Template `[InitialVariables]` / `@@initial_variables`) lorebook
 *      entries — JSON object code blocks, or the content itself, merged on top,
 * so the RPG panel is populated before the first turn. Init-var overrides defaults.
 *
 * Full Zod-schema validation of a card-shipped `data_schema` runs later in the T3.2
 * worker (R4); R2 is the native, no-card-JS path. Pure + unit-tested.
 */

const isObj = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** Recursively merge `source` into `target` (objects merge; everything else replaces). */
const deepMerge = (target: Record<string, any>, source: Record<string, any>): void => {
  for (const k of Object.keys(source)) {
    const sv = source[k]
    if (isObj(sv) && isObj(target[k])) deepMerge(target[k], sv)
    else target[k] = clone(sv)
  }
}

// RPT's `[initvar]` plus ST-Prompt-Template's `[InitialVariables]` / `@@initial_variables` (parity).
const INITVAR_RE = /\[initvar\]|\[InitialVariables\]|@@initial_variables/i
const FENCE_RE = /```(?:[\w-]+)?\s*\n?([\s\S]*?)```/g

/** Drop leading `@@…` decorator lines (ST-PT) so the remaining content parses as the JSON body. */
const stripDecorators = (content: string): string => {
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim().startsWith('@@')) i++
  return lines.slice(i).join('\n')
}

/** Merge every `[initvar]` lorebook entry's JSON code block(s) into one object. */
export const parseInitVars = (lorebooks: Lorebook[]): Record<string, any> => {
  const acc: Record<string, any> = {}
  for (const book of lorebooks) {
    for (const entry of book.entries) {
      if (!INITVAR_RE.test(entry.comment || '') && !INITVAR_RE.test(entry.content || '')) continue
      let matched = false
      FENCE_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FENCE_RE.exec(entry.content)) !== null) {
        const obj = parseJsObject(m[1])
        if (obj) {
          deepMerge(acc, obj)
          matched = true
        }
      }
      // No fenced block — try the content (minus any leading @@ decorator) as one object. ST-PT
      // `[InitialVariables]` / `@@initial_variables` put the JSON object directly in the content.
      if (!matched) {
        const obj = parseJsObject(stripDecorators(entry.content))
        if (obj) deepMerge(acc, obj)
      }
    }
  }
  return acc
}

/** Deep-merge default layers left→right (later layers override earlier). */
export const mergeDefaults = (...layers: unknown[]): Record<string, any> => {
  const acc: Record<string, any> = {}
  for (const l of layers) if (isObj(l)) deepMerge(acc, l)
  return acc
}

/** The starting `stat_data` for a new session: native defaults ⊕ init-var entries. */
export const buildInitialStatData = (
  defaults: unknown,
  lorebooks: Lorebook[]
): Record<string, any> => {
  const acc: Record<string, any> = {}
  if (isObj(defaults)) deepMerge(acc, defaults)
  deepMerge(acc, parseInitVars(lorebooks))
  return acc
}
