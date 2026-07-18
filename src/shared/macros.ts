/**
 * Clean-room macro engine (TH-5) for the ST/Tavern-Helper `{{...}}` macro set. Pure (no
 * node/electron/DOM) so it runs both prompt-time (promptBuilder, main) and render-time
 * (renderer, on AI output). It expands `{{...}}` macros ONLY — it deliberately leaves
 * `<%...%>` EJS template tags untouched so the central order stays macros → EJS → regex.
 *
 * Reimplemented from the public ST macro docs + observed behavior of the SillyTavern 1.18.0
 * NEW macro engine (`public/scripts/macros/engine/MacroEngine.js`, `MacroEnvBuilder.js`,
 * `definitions/*.js`). No SillyTavern / js-slash-runner code is copied — behavior is matched
 * from the source study and pinned by fixtures (ADR 0016 decision 10: the new engine is RPT's
 * single macro profile; the legacy engine's quirks are recorded divergences, not emulated).
 *
 * New-engine semantics reproduced (ST file:line in comments below):
 *  - a whole-document expand with PRE-processors (legacy `<USER>`/`<BOT>`/… marker rewrite) run
 *    before, and POST-processors (brace-unescape, `{{trim}}` + adjacent-newline removal) run after;
 *  - case-insensitive macro names everywhere; nested macros resolve innermost-first;
 *  - unknown / faulting macros are PRESERVED LITERALLY (RPT's existing passthrough policy —
 *    docs/rpt-api.md §7);
 *  - `{{original}}` is a one-shot dynamic macro (the character-card system_prompt / post_history
 *    override exposes the replaced content as `{{original}}` during substitution).
 */

export interface MacroContext {
  user?: string
  char?: string
  persona?: string
  /**
   * Group-members string for `{{group}}` / `{{charIfNotGroup}}`. RPT assembles a single character
   * (never a real ST group), so this is normally absent and both macros fall back to the char name —
   * matching ST's `getGroupValue` when `!selected_group` (MacroEnvBuilder.js:194).
   */
  group?: string
  /** The last user turn's raw text for `{{lastUserMessage}}` (chat-macros.js:108-111). */
  lastUserMessage?: string
  /**
   * The character-card fields for ST's `{{personality}}` / `{{scenario}}` / `{{description}}` macros
   * (env-macros.js:67-89 — `charPersonality`/`charScenario`/`charDescription` with those aliases,
   * `handler: ({ env }) => env.character.<field> ?? ''`). Each resolves ONLY when supplied as a string
   * (like `{{original}}`); absent → the macro is unknown-passthrough (left literal), so a caller that
   * doesn't set them keeps its prior output. Used mainly to expand ST preset marker FORMAT strings
   * (`personality_format` default `{{personality}}`, `scenario_format` default `{{scenario}}`,
   * openai.js:112-113) for imported presets. */
  personality?: string
  scenario?: string
  description?: string
  /**
   * The ONE-SHOT `{{original}}` value: the ORIGINAL prompt content a character-card override replaced
   * (ST openai.js:1489-1492 → preparePrompt → substituteParams `{ original }`). First `{{original}}`
   * in an evaluation yields this string; every later `{{original}}` in the SAME call yields ''
   * (MacroEnvBuilder.js:144-151). Absent (undefined) → `{{original}}` is an unknown macro, left literal.
   */
  original?: string
  /** Local (chat) variables for {{getvar}} / {{setvar}} / {{addvar}}. Mutated in place. */
  vars?: Record<string, unknown>
  /** Global variables for {{getglobalvar}}. */
  globals?: Record<string, unknown>
  /** RNG for {{roll}} / {{random}} / {{pick}} (default Math.random) — injectable for tests. */
  rng?: () => number
  /**
   * Max macro passes before stopping (default 5). Governs nested-macro resolution: the engine runs
   * innermost-first passes until nothing changes or this cap is hit. SPreset's **MacroNest** feature
   * (issue 16) maps onto this — `MacroNest:false` sets `maxPasses:1` (a single, non-nesting pass,
   * matching SPreset's original shallow `substituteParams`); `MacroNest:true`/absent keeps the default
   * nesting cap. Clamped to ≥1.
   */
  maxPasses?: number
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

// Dice roll, matching ST's new-engine `{{roll}}` (core-macros.js:303-337) which delegates to the
// `droll` MIT library (droll.js:58-107). Formula grammar: `([1-9]\d*)?d([1-9]\d*)([+-]\d+)?`
//   - optional dice count (defaults to 1), `d`, sides (≥1), optional `+N`/`-N` modifier.
// A bare integer `N` is treated as `1dN` (core-macros.js:322-325). An invalid formula → '' (the
// engine warns and returns nothing, core-macros.js:328-331). Accepts the LEGACY SPACE form too —
// `{{roll 1d20}}` / `{{roll d20}}` — because the caller now splits the macro name off on whitespace
// as well as `::` / `:` (see splitNameArgs), so `expr` here is just the formula either way.
const DICE_RE = /^([1-9]\d*)?d([1-9]\d*)([+-]\d+)?$/i
const roll = (expr: string, rng: () => number): string => {
  let s = expr.trim()
  if (/^\d+$/.test(s)) s = `1d${s}` // bare integer → 1dN
  const m = DICE_RE.exec(s)
  if (!m) return '' // invalid droll formula
  const count = m[1] ? parseInt(m[1], 10) : 1
  const sides = parseInt(m[2], 10)
  const modifier = m[3] ? parseInt(m[3], 10) : 0
  let total = 0
  for (let i = 0; i < count; i++) total += Math.floor(rng() * sides) + 1
  return String(total + modifier)
}

// Split a macro's arg list on "::" or "," (ST accepts both for random/pick).
const splitChoices = (raw: string): string[] =>
  (raw.includes('::') ? raw.split('::') : raw.split(',')).map((s) => s.trim()).filter(Boolean)

// Format a value for the `{{format_X_variable::}}` family: objects/arrays → JSON, primitives → string.
const formatVar = (v: unknown): string =>
  v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)

// The scoped variable-read macros `{{get_X_variable::path}}` / `{{format_X_variable::path}}`, X ∈
// global/chat/message/preset/character. RPT has one chat-var store + a global store, so `global` reads from
// ctx.globals and every other scope reads from ctx.vars (chat vars) — matching how the EJS helpers alias
// message/character to the chat store (RPT has no dedicated per-message/preset/character var stores).
const VAR_MACRO_RE = /^(get|format)_(global|chat|message|preset|character)_variable$/

// Match a single macro whose body has no braces, so the INNERMOST `{{...}}` matches first.
// Combined with the multi-pass loop, nested macros (`{{getvar::{{user}}}}`) resolve
// inside-out, and `<%...%>` (no `{{`) is never touched.
const MACRO_RE = /\{\{([^{}]+?)\}\}/g

// A macro identifier: a leading letter then word-chars / hyphen (ST MACRO_IDENTIFIER_PATTERN,
// MacroLexer.js:17 `^[a-zA-Z][\w-_]*$`). Captured with the trailing separator so the arg list starts
// after the FIRST `::`, `:` or whitespace run (ST EndOfIdentifier, MacroLexer.js:76).
const NAME_RE = /^\s*([A-Za-z][\w-]*)/

/**
 * Split a brace-body (already innermost, no nested braces) into a lowercased macro `name` and its raw
 * `arg` string. The name/arg separator is the FIRST of `::`, `:` or a whitespace run — reproducing ST's
 * new-engine lexer, which ends the identifier at whitespace or a `:`/`::` lookahead (MacroLexer.js:76,
 * :208-236) and so accepts BOTH `{{roll::1d6}}` and the legacy space form `{{roll 1d6}}`. Returns null
 * when the body is not a valid macro (no leading identifier) → the caller leaves it literal.
 */
const splitNameArgs = (body: string): { name: string; arg: string } | null => {
  const m = NAME_RE.exec(body)
  if (!m) return null
  const name = m[1].toLowerCase()
  const rest = body.slice(m[0].length)
  let arg: string
  if (rest.startsWith('::')) arg = rest.slice(2)
  else if (rest.startsWith(':')) arg = rest.slice(1)
  else if (/^\s/.test(rest)) arg = rest.replace(/^\s+/, '')
  else arg = '' // rest is empty (e.g. `{{user}}`) or trailing non-separator text
  return { name, arg }
}

/**
 * ST core PRE-processors (MacroEngine.js:273-294): legacy non-curly markers are rewritten into their
 * `{{...}}` macro forms BEFORE the engine runs, so they flow through the same pipeline (and resolve even
 * when nested inside an arg). Case-insensitive. `<USER>`→`{{user}}`, `<BOT>`/`<CHAR>`→`{{char}}`,
 * `<GROUP>`→`{{group}}`, `<CHARIFNOTGROUP>`→`{{charIfNotGroup}}`. Only touches `<…>` markers; unrelated
 * angle-bracket text (e.g. `<div>`) is left alone.
 */
const preprocessMarkers = (text: string): string =>
  text.includes('<')
    ? text
        .replace(/<USER>/gi, '{{user}}')
        .replace(/<BOT>/gi, '{{char}}')
        .replace(/<CHAR>/gi, '{{char}}')
        .replace(/<GROUP>/gi, '{{group}}')
        .replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}')
    : text

/**
 * ST core POST-processors (MacroEngine.js:299-323), run once after all macro passes, in ascending
 * priority:
 *  - brace-unescape (priority 10): `\{`→`{`, `\}`→`}`. An author writes `\{\{` to emit a literal `{{`
 *    that the engine won't treat as a macro opener; the backslashes are stripped here.
 *  - legacy `{{trim}}` removal (priority 20): `{{trim}}` and the newlines immediately around it are
 *    deleted — the trim macro "reaches over the boundaries of the defined macro", so ST handles it as a
 *    post-pass regex rather than a normal macro (MacroEngine.js:310-316). Case-insensitive.
 */
const postprocess = (text: string): string => {
  let out = text
  if (out.includes('\\')) out = out.replace(/\\([{}])/g, '$1')
  if (/\{\{trim\}\}/i.test(out)) out = out.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '')
  return out
}

/**
 * Expand `{{...}}` macros in `text`. Unknown macros are left untouched. Runs a few passes
 * so nested macros (e.g. `{{getvar::{{user}}}}`) resolve; bounded to avoid loops.
 *
 * Shape mirrors ST's new engine: preprocess (marker rewrite) → whole-document macro passes
 * (innermost-first) → postprocess (brace-unescape, `{{trim}}` removal). The multi-pass inner loop
 * replaces ST's single CST walk but yields the same inside-out nested resolution; the unknown-macro
 * passthrough policy (docs/rpt-api.md §7) is preserved — the switch's `default` returns the macro verbatim.
 */
export const expandMacros = (text: string, ctx: MacroContext = {}): string => {
  if (!text) return text
  const rng = ctx.rng || Math.random
  // `{{original}}` is one-shot per evaluation (ST MacroEnvBuilder.js:144-151): the flag persists across
  // passes so a second `{{original}}` — including one that only appears after an earlier macro expands —
  // yields ''.
  let originalUsed = false
  let out = preprocessMarkers(text)
  // Default 5 passes (RPT's nesting engine — issue 13). SPreset MacroNest:false drops this to 1 (a single
  // non-nesting pass); true/absent keeps the default. Clamped ≥1 so a bad config never zeroes expansion.
  const maxPasses = Math.max(1, ctx.maxPasses ?? 5)
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false
    out = out.replace(MACRO_RE, (whole, body: string) => {
      // {{// comment }} — ST comment macro (`//`, core-macros.js:282): stripped from the prompt entirely
      // (may span lines; any body starting with `//`). Bare `{{/}}` — a scoped-close flag — is also
      // dropped for back-compat with the previous evaluator.
      const trimmed = body.trim()
      if (trimmed.startsWith('//') || trimmed === '/') {
        changed = true
        return ''
      }
      const parsed = splitNameArgs(body)
      // Not a valid macro (no leading identifier, e.g. `{{123}}` or a stray `{{/if}}` scoped close):
      // leave verbatim (unknown passthrough — docs/rpt-api.md §7).
      if (!parsed) return whole
      const { name, arg: a } = parsed
      // Scoped TH variable reads: {{get_X_variable::path}} / {{format_X_variable::path}}.
      const vm = VAR_MACRO_RE.exec(name)
      if (vm) {
        const val = path(vm[2] === 'global' ? ctx.globals : ctx.vars, a.trim())
        changed = true
        return vm[1] === 'format' ? formatVar(val) : String(val ?? '')
      }
      let res: string | null = null
      switch (name) {
        case 'char':
          res = ctx.char ?? ''
          break
        case 'user':
          res = ctx.user ?? ''
          break
        case 'group':
          // Solo assembly: `{{group}}` === char name (ST getGroupValue, MacroEnvBuilder.js:194).
          res = ctx.group ?? ctx.char ?? ''
          break
        case 'charifnotgroup':
          // RPT never assembles a real group, so this is always the char (ST getGroupValue with
          // filterOutChar=false and no selected_group).
          res = ctx.char ?? ''
          break
        case 'persona':
          res = ctx.persona ?? ''
          break
        // ST character-field macros + their aliases (env-macros.js:67-89). Gated on presence like
        // {{original}}: resolve only when the caller supplied the field (a string), else fall through to
        // unknown-passthrough so content that doesn't opt in is byte-identical to before.
        case 'charpersonality':
        case 'personality':
          if (typeof ctx.personality !== 'string') return whole
          res = ctx.personality
          break
        case 'charscenario':
        case 'scenario':
          if (typeof ctx.scenario !== 'string') return whole
          res = ctx.scenario
          break
        case 'chardescription':
        case 'description':
          if (typeof ctx.description !== 'string') return whole
          res = ctx.description
          break
        case 'lastusermessage':
          // Last user turn's raw text (chat-macros.js:108-111).
          res = ctx.lastUserMessage ?? ''
          break
        case 'original': {
          // One-shot: only meaningful when the caller supplied an override original (a string, possibly
          // empty). When absent, fall through to unknown passthrough so `{{original}}` stays literal.
          if (typeof ctx.original !== 'string') return whole
          res = originalUsed ? '' : ctx.original
          originalUsed = true
          break
        }
        case 'trim':
          // `{{trim}}` is resolved by the POST-processor (removes it + adjacent newlines). Leave it
          // literal here without marking `changed`, so it survives the passes untouched
          // (MacroEngine.js:310-316). Scoped `{{trim}}…{{/trim}}` is out of profile.
          return whole
        case 'newline':
          res = '\n'
          break
        case 'noop':
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
          res = roll(a, rng)
          break
        case 'random':
        case 'pick': {
          const choices = splitChoices(a)
          res = choices.length ? choices[Math.floor(rng() * choices.length)] : ''
          break
        }
        default:
          // Error policy: "unknown macro passes through verbatim" — see docs/rpt-api.md §7 (WS-9).
          // Matches ST's new engine, which returns the raw `{{…}}` for an unregistered / faulting macro
          // (MacroEngine.js:216-218, :236).
          return whole // unknown macro — leave as-is
      }
      changed = true
      return res
    })
    if (!changed) break
  }
  return postprocess(out)
}
