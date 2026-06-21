/**
 * Clean-room macro engine (TH-5) for the ST/Tavern-Helper `{{...}}` macro set. Pure (no
 * node/electron/DOM) so it runs both prompt-time (promptBuilder, main) and render-time
 * (renderer, on AI output). It expands `{{...}}` macros ONLY — it deliberately leaves
 * `<%...%>` EJS template tags untouched so the central order stays macros → EJS → regex.
 *
 * Reimplemented from the public ST macro docs; no SillyTavern / js-slash-runner code.
 */

export interface MacroContext {
  user?: string
  char?: string
  persona?: string
  /** Local (chat) variables for {{getvar}} / {{setvar}} / {{addvar}}. Mutated in place. */
  vars?: Record<string, unknown>
  /** Global variables for {{getglobalvar}}. */
  globals?: Record<string, unknown>
  /** RNG for {{roll}} / {{random}} / {{pick}} (default Math.random) — injectable for tests. */
  rng?: () => number
}

const path = (obj: Record<string, unknown> | undefined, key: string): unknown => {
  if (!obj) return undefined
  let cur: unknown = obj
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const setPath = (obj: Record<string, unknown>, key: string, val: unknown): void => {
  const parts = key.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = val
}

// "2d6" → roll 2 six-sided dice; "d20" → 1d20; "100" → 1..100.
const roll = (expr: string, rng: () => number): number => {
  const s = expr.trim()
  const dice = /^(\d*)d(\d+)$/i.exec(s)
  if (dice) {
    const n = parseInt(dice[1] || '1', 10)
    const sides = parseInt(dice[2], 10) || 1
    let total = 0
    for (let i = 0; i < n; i++) total += Math.floor(rng() * sides) + 1
    return total
  }
  const max = parseInt(s, 10)
  return Number.isFinite(max) && max > 0 ? Math.floor(rng() * max) + 1 : 0
}

// Split a macro's arg list on "::" or "," (ST accepts both for random/pick).
const splitChoices = (raw: string): string[] =>
  (raw.includes('::') ? raw.split('::') : raw.split(',')).map((s) => s.trim()).filter(Boolean)

// Match a single macro whose body has no braces, so the INNERMOST `{{...}}` matches first.
// Combined with the multi-pass loop, nested macros (`{{getvar::{{user}}}}`) resolve
// inside-out, and `<%...%>` (no `{{`) is never touched.
const MACRO_RE = /\{\{([^{}]+?)\}\}/g

/**
 * Expand `{{...}}` macros in `text`. Unknown macros are left untouched. Runs a few passes
 * so nested macros (e.g. `{{getvar::{{user}}}}`) resolve; bounded to avoid loops.
 */
export const expandMacros = (text: string, ctx: MacroContext = {}): string => {
  if (!text) return text
  const rng = ctx.rng || Math.random
  let out = text
  for (let pass = 0; pass < 5; pass++) {
    let changed = false
    out = out.replace(MACRO_RE, (whole, body: string) => {
      const sep = body.indexOf('::')
      const name = (sep < 0 ? body : body.slice(0, sep)).trim().toLowerCase()
      const a = sep < 0 ? '' : body.slice(sep + 2)
      let res: string | null = null
      switch (name) {
        case 'char':
          res = ctx.char ?? ''
          break
        case 'user':
          res = ctx.user ?? ''
          break
        case 'persona':
          res = ctx.persona ?? ''
          break
        case 'newline':
          res = '\n'
          break
        case 'noop':
        case '/':
        case '//':
          res = ''
          break
        case 'time':
          res = new Date().toLocaleTimeString()
          break
        case 'date':
          res = new Date().toLocaleDateString()
          break
        case 'getvar':
          res = String(path(ctx.vars, a.trim()) ?? '')
          break
        case 'getglobalvar':
          res = String(path(ctx.globals, a.trim()) ?? '')
          break
        case 'setvar': {
          const [k, ...rest] = a.split('::')
          if (k && ctx.vars) setPath(ctx.vars, k.trim(), rest.join('::'))
          res = ''
          break
        }
        case 'addvar': {
          const [k, n] = a.split('::')
          if (k && ctx.vars) {
            const key = k.trim()
            const cur = Number(path(ctx.vars, key)) || 0
            setPath(ctx.vars, key, cur + (Number(n) || 0))
          }
          res = ''
          break
        }
        case 'roll':
        case 'random':
        case 'pick': {
          if (name === 'roll') {
            res = String(roll(a, rng))
          } else {
            const choices = splitChoices(a)
            res = choices.length ? choices[Math.floor(rng() * choices.length)] : ''
          }
          break
        }
        default:
          return whole // unknown macro — leave as-is
      }
      changed = true
      return res
    })
    if (!changed) break
  }
  return out
}
