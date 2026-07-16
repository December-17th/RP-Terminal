/**
 * Project Yuzu WP-P0 — resilient JSON extraction from a model reply.
 *
 * Generalizes the two ad-hoc extractors already in the app (tableSql.ts `sanitizeSqlBatch` and
 * resilientCall.ts `parsesAsJson`) into one that both parses AND reports which repairs it had to
 * apply — the `applied[]` trail is keeper data (it tells us how often real providers wrap output in
 * <think>, fence it, or bury it in prose). NEVER throws.
 *
 * Transforms, in order, each recorded in `applied[]` when it fires:
 *  - 'think' : strip a <think>…</think> reasoning block
 *  - 'fence' : unwrap a ```json … ``` (or bare ```) code fence
 *  - 'slice' : slice the outermost balanced {…} out of surrounding prose
 */

/** Why extraction failed, mapped to a FailureShape by validate.ts. */
export type ExtractFailReason = 'EMPTY' | 'NO_JSON' | 'TRUNCATED' | 'PARSE_ERROR'

export type ExtractResult =
  | { ok: true; value: unknown; applied: string[] }
  | { ok: false; error: string; reason: ExtractFailReason; applied: string[] }

const THINK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi
// A fenced block anywhere in the text: ```json\n … ``` or bare ```\n … ```.
const FENCE_RE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i

/**
 * Slice the first outermost balanced {…} object out of `s`, honoring string literals (so a `}` inside
 * a quoted string does not close the object). Returns null if there is no `{`, or if the object never
 * closes (a truncated reply).
 */
export const sliceOutermostObject = (s: string): string | null => {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null // opened but never closed — truncated
}

const tryParse = (s: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export const extractJson = (raw: string): ExtractResult => {
  const applied: string[] = []
  let s = raw ?? ''

  if (THINK_RE.test(s)) {
    s = s.replace(THINK_RE, '')
    applied.push('think')
  }
  s = s.trim()
  if (!s) return { ok: false, error: 'output is empty', reason: 'EMPTY', applied }

  const fence = FENCE_RE.exec(s)
  if (fence) {
    s = fence[1].trim()
    applied.push('fence')
  }
  if (!s) return { ok: false, error: 'output is empty', reason: 'EMPTY', applied }

  // Whole-string parse first — a clean reply needs no slice.
  const whole = tryParse(s)
  if (whole.ok) return { ok: true, value: whole.value, applied }

  // Otherwise pull the outermost {…} out of the surrounding prose.
  const sliced = sliceOutermostObject(s)
  if (sliced === null) {
    if (s.indexOf('{') === -1) {
      return { ok: false, error: 'no JSON object found', reason: 'NO_JSON', applied }
    }
    return {
      ok: false,
      error: 'JSON object never closed (truncated)',
      reason: 'TRUNCATED',
      applied
    }
  }
  applied.push('slice')
  const parsed = tryParse(sliced)
  if (parsed.ok) return { ok: true, value: parsed.value, applied }
  return {
    ok: false,
    error: `sliced object failed to parse: ${parsed.error}`,
    reason: 'PARSE_ERROR',
    applied
  }
}
