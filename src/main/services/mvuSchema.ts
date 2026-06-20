import { Lorebook } from '../types/character'
import { parseJsObject } from '../parsers/mvuParser'

/**
 * MVU schema / initialization (Track R / R2). Seeds the initial `stat_data` for a
 * new session from two layers:
 *   1. the card's native defaults (`extensions.rp_terminal.state_schema.defaults`), and
 *   2. `[initvar]`-marked lorebook entries (JSON object code blocks merged on top),
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

const INITVAR_RE = /\[initvar\]/i
const FENCE_RE = /```(?:[\w-]+)?\s*\n?([\s\S]*?)```/g

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
      // No fenced block matched — try the whole entry content as one object.
      if (!matched) {
        const obj = parseJsObject(entry.content)
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
