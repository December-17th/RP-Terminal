/**
 * ST-Prompt-Template injection markers + decorators — clean-room, from the published docs
 * (docs/features.md). NO upstream source copied.
 *
 * A world-info / lorebook entry becomes a prompt INJECTION (rather than plain lore) when its `comment`
 * is a bracket marker — `[GENERATE:BEFORE]`, `[GENERATE:2:AFTER]`, `[GENERATE:REGEX:p]`, `[RENDER:BEFORE]`,
 * `@INJECT …` — or its `content` begins with an `@@` decorator (`@@generate_before`, …). The entry's
 * content (an EJS template) is then injected at the computed position. This module only CLASSIFIES an
 * entry; `promptBuilder` drains the markers into the message array.
 */

export type Side = 'before' | 'after'
export type Role = 'user' | 'assistant' | 'system'

export interface GenerateMarker {
  kind: 'generate'
  side: Side
  /** 0-based message index for `[GENERATE:{idx}:*]`; undefined → whole-prompt start/end. */
  index?: number
  /** `[GENERATE:REGEX:p]` → inject relative to the first message matching `p`. */
  regex?: string
}
export interface RenderMarker {
  kind: 'render'
  side: Side
}
export interface InjectMarker {
  kind: 'inject'
  role?: Role
  /** Absolute mode: 1-based, negatives count from the end, `0` → first. */
  pos?: number
  /** Target mode: relative to the nth message of `target`. */
  target?: Role
  index?: number
  at?: Side
  /** Regex mode: relative to the first message matching this pattern. */
  regex?: string
  order?: number
}
export type Marker = GenerateMarker | RenderMarker | InjectMarker

export interface ParsedEntryMarker {
  /** The injection marker (from the comment or an `@@` decorator), or null for a plain WI entry. */
  marker: Marker | null
  /** Entry content with leading `@@` decorator lines removed (the EJS template body). */
  template: string
  /** `@@activate`/`@@always_enabled` → 'force'; `@@dont_activate` → 'never'; else null. */
  activation: 'force' | 'never' | null
  /** `@@private` → the rendered content should be wrapped in an isolating scope. */
  private: boolean
}

const reGenRegex = /^\s*\[GENERATE:REGEX:(.+)\]\s*$/i
const reGenerate = /^\s*\[GENERATE:(?:(\d+):)?(BEFORE|AFTER)\]\s*$/i
const reRender = /^\s*\[RENDER:(BEFORE|AFTER)\]\s*$/i
const reInject = /^\s*@INJECT\s+(.+?)\s*$/i

const isRole = (v: string | undefined): v is Role =>
  v === 'user' || v === 'assistant' || v === 'system'

const parseInject = (params: string): InjectMarker => {
  const p: Record<string, string> = {}
  for (const part of params.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim().toLowerCase()
    let v = part.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1)
    if (k) p[k] = v
  }
  const marker: InjectMarker = { kind: 'inject' }
  if (isRole(p.role)) marker.role = p.role
  if (p.pos) marker.pos = Number(p.pos)
  if (isRole(p.target)) marker.target = p.target
  if (p.index) marker.index = Number(p.index)
  if (p.at === 'before' || p.at === 'after') marker.at = p.at
  if (p.regex) marker.regex = p.regex
  if (p.order) marker.order = Number(p.order)
  return marker
}

const parseCommentMarker = (comment: string): Marker | null => {
  const c = comment || ''
  let m: RegExpMatchArray | null
  if ((m = c.match(reGenRegex))) return { kind: 'generate', side: 'before', regex: m[1] }
  if ((m = c.match(reGenerate))) {
    const g: GenerateMarker = { kind: 'generate', side: m[2].toLowerCase() as Side }
    if (m[1] != null) g.index = Number(m[1])
    return g
  }
  if ((m = c.match(reRender))) return { kind: 'render', side: m[1].toLowerCase() as Side }
  if ((m = c.match(reInject))) return parseInject(m[1])
  return null
}

const DECOR_MARKER: Record<string, Marker> = {
  '@@generate_before': { kind: 'generate', side: 'before' },
  '@@generate_after': { kind: 'generate', side: 'after' },
  '@@render_before': { kind: 'render', side: 'before' },
  '@@render_after': { kind: 'render', side: 'after' }
}

/** Classify a lorebook entry by its `comment` + `content`. A plain entry → marker null, template = content. */
export function parseEntryMarker(comment: string, content: string): ParsedEntryMarker {
  // Peel leading @@ decorator lines off the content; the EJS template is what remains.
  const lines = (content || '').split('\n')
  let i = 0
  const decorators: string[] = []
  while (i < lines.length && lines[i].trim().startsWith('@@')) {
    decorators.push(lines[i].trim())
    i++
  }
  const template = lines.slice(i).join('\n')

  let activation: 'force' | 'never' | null = null
  let priv = false
  let decoratorMarker: Marker | null = null
  for (const d of decorators) {
    const name = d.split(/\s+/)[0].toLowerCase()
    if (name === '@@activate' || name === '@@always_enabled') activation = 'force'
    else if (name === '@@dont_activate') activation = 'never'
    else if (name === '@@private') priv = true
    else if (DECOR_MARKER[name]) decoratorMarker = DECOR_MARKER[name]
  }

  // A bracket/@INJECT comment marker wins; otherwise an @@generate_*/@@render_* decorator.
  const marker = parseCommentMarker(comment) ?? decoratorMarker
  return { marker, template, activation, private: priv }
}

/** Minimal message shape the position math needs (the prompt's role + content). */
export interface PositionMessage {
  role: string
  content: string
}

const safeTest = (pattern: string, content: string): boolean => {
  try {
    return new RegExp(pattern).test(content)
  } catch {
    return false
  }
}

/**
 * The 0-based insertion index for a BUILD-TIME marker against the (final) message array, or null when it
 * doesn't apply (a render marker, or a regex/target with no match). From the ST-PT source:
 * - `[GENERATE]`: before→idx (whole-prompt → 0), after→idx+1 (whole-prompt → end); REGEX→relative to the
 *   first message matching the pattern.
 * - `@INJECT` absolute `pos`: `0`→0, `N>0`→`N-1` (1-based), `N<0`→`len+N+1` (clamped ≥1) then −1.
 * - `@INJECT` target: the nth (1-based; negatives from the end) message of `target`'s role, before/after.
 * - `@INJECT` regex: relative to the first matching message.
 */
export const markerIndex = (m: Marker, messages: PositionMessage[]): number | null => {
  if (m.kind === 'generate') {
    if (m.regex) {
      const rx = m.regex
      const idx = messages.findIndex((x) => safeTest(rx, x.content))
      return idx < 0 ? null : m.side === 'after' ? idx + 1 : idx
    }
    if (m.index != null) return m.side === 'after' ? m.index + 1 : m.index
    return m.side === 'before' ? 0 : messages.length
  }
  if (m.kind === 'inject') {
    if (m.pos != null) {
      if (m.pos === 0) return 0
      if (m.pos > 0) return m.pos - 1
      return Math.max(1, messages.length + m.pos + 1) - 1
    }
    if (m.target) {
      const target = m.target
      const total = messages.filter((x) => x.role === target).length
      let occ = m.index ?? 1
      if (occ < 0) occ = total + occ + 1
      let count = 0
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === target && ++count === occ) return m.at === 'after' ? i + 1 : i
      }
      return null
    }
    if (m.regex) {
      const rx = m.regex
      const idx = messages.findIndex((x) => safeTest(rx, x.content))
      return idx < 0 ? null : m.at === 'after' ? idx + 1 : idx
    }
    return null
  }
  return null // render marker — not a build-time injection
}
