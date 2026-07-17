/**
 * Shared regex replacement transform. Pure (no node/electron/DOM), so it can be
 * imported by BOTH the main prompt-time applier (`regexService.applyRegex`) and the
 * renderer display applier (`regexStore.apply`) — keeping the two from diverging.
 */

export interface RegexLikeRule {
  source: string
  flags: string
  replace: string
  placement: number[]
  trimStrings: string[]
  /** ST depth-scoping: only apply to messages whose depth (distance from the end of the
   * chat, 0 = latest) is within [minDepth, maxDepth]. null/undefined = no bound. Honored only
   * when a `depth` is supplied to `applyRegexRules` (prompt-time per-message); ignored otherwise. */
  minDepth?: number | null
  maxDepth?: number | null
  /** ST `substituteRegex` (substitute_find_regex — engine.js:298-302): how to macro-expand the FIND
   * pattern before compiling. 0/undefined = NONE (raw source), 1 = RAW ({{user}}/{{char}} expanded
   * verbatim), 2 = ESCAPED (expanded, then regex-escaped so the value is matched literally). Only the
   * {{user}}/{{char}} macro subset is expanded here (this module is pure — no full macro engine). */
  substituteRegex?: number
  /** ST `runOnEdit` (engine.js:356): when false, the rule is skipped on an EDIT call (`isEdit`). */
  runOnEdit?: boolean
}

export interface RegexApplyContext {
  user?: string
  char?: string
}

/** A "frontend card" payload — beautification HTML carrying its own <script>/<style>. Its embedded
 *  code must pass through verbatim, so we apply ONLY the substitutions SillyTavern's native
 *  String.replace does and skip our plain-text `\n`→newline shorthand (a card's script legitimately
 *  contains literal `\n`, e.g. inside `/[\r\n]/`, that must not become a real newline). */
export const isCardPayload = (s: string): boolean =>
  /```html|<script[\s>]|<style[\s>]|<(?:html|body)[\s>]/i.test(s)

/** Build a rule's replacement for one match: trimStrings stripped from `{{match}}`, the
 * `{{match}}`/`{{user}}`/`{{char}}` macros, `$0`/`$&`/`$N` capture groups, and (plain text only) `\n`.
 * Capture substitution mirrors native String.replace: `$N` is left LITERAL when the find-regex has
 * no group N — that's what keeps a card's own `$1` backreference intact instead of blanking it.
 *
 * CARD-PAYLOAD SAFETY: a frontend-card replacement carries the card's OWN `<script>`, which routinely
 * contains the universal regex-escape idiom `str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` — a LITERAL
 * `$&`, not an injection point (a beautifier injects the match via a numbered group or `{{match}}`).
 * Substituting the whole-match specials `$&`/`$0` there splices the entire matched block into the
 * card's script, breaking it (unterminated string → SyntaxError → every handler undefined → a card
 * that renders but can't be clicked/expanded). So for a card payload leave `$&`/`$0` LITERAL — the
 * same card-awareness that already skips the `\n` shorthand below. Numbered groups still resolve (the
 * beautifier's real injection uses them) and the "no group N ⇒ literal" guard keeps a card's `$6` intact. */
/** Expand the {{user}}/{{char}} macro subset in a string (the only macros this pure module knows). */
const subUserChar = (s: string, ctx: RegexApplyContext): string =>
  s.replace(/\{\{user\}\}/gi, ctx.user ?? '').replace(/\{\{char\}\}/gi, ctx.char ?? '')

/** Escape regex metacharacters in a substituted find-macro value (ST `sanitizeRegexMacro`,
 * engine.js:304-324) so a RAW value with e.g. `.` or `*` matches literally in ESCAPED mode. */
const escapeRegexValue = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Build the effective FIND source for ST `substituteRegex` RAW(1)/ESCAPED(2): expand the
 * {{user}}/{{char}} subset in the pattern, escaping the value in ESCAPED mode. Pure-module scope —
 * full macro expansion of the find pattern is out of scope (issue 13 owns the macro engine). */
const substituteFindSource = (
  source: string,
  mode: number,
  ctx: RegexApplyContext
): string => {
  const user = mode === 2 ? escapeRegexValue(ctx.user ?? '') : ctx.user ?? ''
  const char = mode === 2 ? escapeRegexValue(ctx.char ?? '') : ctx.char ?? ''
  return source.replace(/\{\{user\}\}/gi, user).replace(/\{\{char\}\}/gi, char)
}

/** Remove every trimString from a captured value, mirroring ST's `filterString` (engine.js:457-465):
 * each trimString is macro-expanded ({{user}}/{{char}}) before being stripped. */
const filterTrims = (value: string | undefined, rule: RegexLikeRule, ctx: RegexApplyContext): string => {
  let out = value ?? ''
  for (const t of rule.trimStrings) {
    if (!t) continue
    const sub = subUserChar(t, ctx)
    if (sub) out = out.split(sub).join('')
  }
  return out
}

const buildReplacement = (
  rule: RegexLikeRule,
  match: string,
  groups: Array<string | undefined>,
  named: Record<string, string | undefined>,
  ctx: RegexApplyContext
): string => {
  const card = isCardPayload(rule.replace)
  const filt = (v: string | undefined): string => filterTrims(v, rule, ctx)
  // {{match}} is ST's alias for $0 (engine.js:421 `replaceString.replace(/{{match}}/gi, '$0')`) — the
  // whole match with trimStrings removed. {{user}}/{{char}} expand from the apply context.
  let out = rule.replace
    .replace(/\{\{match\}\}/gi, filt(match))
    .replace(/\{\{user\}\}/gi, ctx.user ?? '')
    .replace(/\{\{char\}\}/gi, ctx.char ?? '')
  // `$&` — RPT extension (native String.replace whole-match). LEFT LITERAL in a card payload: a card's
  // <script> routinely carries the regex-escape idiom `.replace(/…/g,'\\$&')` and splicing the whole
  // match there breaks it (the 2026-07-17 fix, fix/regex-dollar0-card-payload). ST never touches `$&`.
  if (!card) out = out.replace(/\$&/g, match)
  // Numbered ($0/$N) + named ($<name>) capture groups in ONE pass (ST engine.js:422). trimStrings are
  // applied to every substituted value (ST filterString). $0 is the whole match. CARD-PAYLOAD guard:
  // $0 stays LITERAL (the 2026-07-17 fix); numbered/named groups still resolve when the group exists,
  // and a $N with no such group in the find-regex stays LITERAL (preserves a card's own backreference).
  out = out.replace(/\$(\d{1,2})|\$<([^>]+)>/g, (m, num, name) => {
    if (name !== undefined) {
      // Named group: ST returns '' when the group is absent/undefined (engine.js:428-435). In a card
      // payload keep an unknown $<name> literal (same protection as an unknown $N).
      if (name in named) return filt(named[name])
      return card ? m : ''
    }
    const groupNumber = Number(num)
    if (groupNumber === 0) return card ? m : filt(match)
    const i = groupNumber - 1
    return i < groups.length ? filt(groups[i]) : m
  })
  if (!card) out = out.replace(/\\n/g, '\n')
  return out
}

/** Pull (match, capture groups, named-groups object) out of a String.prototype.replace callback's
 * args, dropping the trailing offset/string. The named-groups object is present only when the
 * find-regex declares named groups (it is then the LAST arg, after the whole input string). */
const replaceArgs = (
  args: unknown[]
): { match: string; groups: Array<string | undefined>; named: Record<string, string | undefined> } => {
  const rest = [...args]
  let named: Record<string, string | undefined> = {}
  const last = rest[rest.length - 1]
  if (last !== null && typeof last === 'object') named = rest.pop() as Record<string, string | undefined>
  rest.pop() // whole input string
  rest.pop() // match offset
  return { match: rest[0] as string, groups: rest.slice(1) as Array<string | undefined>, named }
}

export interface ApplyOptions<R> {
  /** Skip a rule whose non-empty placement list doesn't include this value. */
  placement?: number
  /** The depth of the message being transformed (distance from the end of the chat, 0 = latest).
   * When a number, a rule is skipped if `depth` falls outside its [minDepth, maxDepth] (ST semantics).
   * Undefined = depth-scoping disabled (every rule applies regardless of its min/maxDepth). */
  depth?: number
  /** Supply a compiled RegExp for a rule (e.g. a cache); defaults to a fresh `new RegExp`. */
  compile?: (rule: R) => RegExp
  /**
   * Render-only: given the matched rule, return a marker string to PREPEND to that rule's
   * replacement output (e.g. a per-card render-mode HTML comment). Undefined → no marker.
   */
  marker?: (rule: R) => string | undefined
  /** ST edit call (engine.js:356): when true, a rule with `runOnEdit !== true` is skipped. No live
   * RPT caller sets this today (edits re-run generation); present for model + fixture parity. */
  isEdit?: boolean
  /**
   * PER-RULE LINEAGE (issue 14 / M1 finding 3): invoked once for every rule that ACTUALLY changed the
   * text, with that rule and its before/after span. Lets a caller (promptBuilder's forensic journal)
   * attribute a regex change to the RULE that fired rather than the whole turn. A rule that matches
   * nothing (before === after) does not fire it. Intended for the non-freeze prompt path (on the
   * display path `freezePayloads` rewrites payloads to tokens, so before/after carry placeholders).
   */
  onRuleApplied?: (rule: R, before: string, after: string) => void
  /**
   * DISPLAY-path only: when a rule injects a card payload (beautification HTML — see isCardPayload),
   * replace that injected region with an opaque placeholder so LATER rules don't rescan it, then
   * restore it verbatim at the end. A cleanup regex backtracking over a 100KB+ HTML paste stalls the
   * render for SECONDS (the plot panel re-ran this on every turn-settle and froze the whole app; the
   * repro: a preset beautifier pastes ~148KB, then two same-tier cleanups rescan it — ~5s). The
   * scope-tier ordering (regexOrder test) only shields a WORLD/SESSION-scoped beautifier from PRESET
   * cleanups; a PRESET-scoped beautifier is still rescanned by same-tier cleanups — this guards it
   * regardless of scope. OFF by default so the PROMPT path stays byte-identical (a beautifier is
   * display-only and never reaches the prompt anyway). Final output matches the un-frozen result EXCEPT
   * that a later rule can no longer match structure INSIDE an injected payload — the intended fix: a
   * cleanup must not rewrite (or backtrack over) an already-finished card. Fail-safe: if the input
   * already contains the U+E000 delimiter, freezing is skipped; if a rule strips the raw PUA range and
   * mangles a token, the applier detects the stray delimiter and re-runs un-frozen — so enabling this
   * can never produce output the un-frozen path wouldn't.
   */
  freezePayloads?: boolean
}

/** Apply rules to `text` in order. A rule that fails to compile is skipped. */
export const applyRegexRules = <R extends RegexLikeRule>(
  text: string,
  rules: R[],
  ctx: RegexApplyContext = {},
  opts: ApplyOptions<R> = {}
): string => {
  // Card-payload freeze (opt-in — see ApplyOptions.freezePayloads): stash each injected card payload
  // behind an opaque placeholder so subsequent rules scan a short token instead of the full paste;
  // restored verbatim at the end. The token is built ENTIRELY from the Unicode Private-Use Area — a
  // U+E000 delimiter, a per-call random nonce (U+E1xx), and the index encoded as PUA "digits"
  // (U+E010..U+E019) — so no ordinary card/cleanup regex (tag-, word-, or `\d`-anchored) can match,
  // split, or renumber it, and a rule replacement can't forge a colliding token. If freezing is somehow
  // corrupted anyway (only a rule that strips the raw PUA range can do it), the backstop after the
  // restore loop re-runs UNFROZEN, so the output is never worse than the un-frozen (pre-freeze) result.
  const SENT = String.fromCharCode(0xe000) // token delimiter
  // Disable freezing if the delimiter already occurs in the input (e.g. a PUA iconfont glyph) — then a
  // real payload could never be told apart from the input and must not be touched.
  const canFreeze = opts.freezePayloads === true && !text.includes(SENT)
  const nonce = canFreeze
    ? Array.from({ length: 4 }, () =>
        String.fromCharCode(0xe100 + Math.floor(Math.random() * 0x100))
      ).join('')
    : ''
  const encodeIdx = (n: number): string =>
    String(n).replace(/\d/g, (d) => String.fromCharCode(0xe010 + Number(d)))
  const tokenFor = (i: number): string => `${SENT}${nonce}${encodeIdx(i)}${SENT}`
  const frozen: string[] = []
  const freeze = (payload: string): string => {
    const token = tokenFor(frozen.length)
    frozen.push(payload)
    return token
  }

  let out = text
  for (const rule of rules) {
    if (
      opts.placement !== undefined &&
      rule.placement.length > 0 &&
      !rule.placement.includes(opts.placement)
    ) {
      continue
    }
    // ST edit gating (engine.js:356): on an edit call, skip a rule that doesn't opt into runOnEdit.
    if (opts.isEdit && rule.runOnEdit !== true) continue
    // ST depth-scoping (regex/engine.js): when a depth is supplied, skip a rule whose
    // [minDepth, maxDepth] excludes it. The latest turn is depth 0, so a `minDepth:1` rule
    // (e.g. "keep only the latest user input") never touches the live input — only older turns.
    if (typeof opts.depth === 'number') {
      const { minDepth, maxDepth } = rule
      if (minDepth != null && !Number.isNaN(minDepth) && minDepth >= -1 && opts.depth < minDepth) {
        continue
      }
      if (maxDepth != null && !Number.isNaN(maxDepth) && maxDepth >= 0 && opts.depth > maxDepth) {
        continue
      }
    }
    // ST substituteRegex (engine.js:397-409): macro-expand the FIND pattern before compiling. When set
    // (RAW/ESCAPED) the effective source depends on ctx, so bypass the compile cache and build fresh.
    const subMode = Number(rule.substituteRegex ?? 0)
    let re: RegExp
    try {
      re =
        subMode === 1 || subMode === 2
          ? new RegExp(substituteFindSource(rule.source, subMode, ctx), rule.flags)
          : opts.compile
            ? opts.compile(rule)
            : new RegExp(rule.source, rule.flags)
    } catch {
      continue
    }
    re.lastIndex = 0 // reset stateful (global) regexes — important for cached instances
    const before = out
    out = out.replace(re, (...args) => {
      const { match, groups, named } = replaceArgs(args)
      const repl = buildReplacement(rule, match, groups, named, ctx)
      const mk = opts.marker?.(rule)
      const full = mk ? mk + repl : repl
      // Freeze a genuine card payload so LATER rules scan the token, not the paste. Plain-text
      // replacements (the common case, and every prompt-path rule) pass through unchanged.
      return canFreeze && isCardPayload(full) ? freeze(full) : full
    })
    // Per-rule lineage: report only when this rule actually changed the text (issue 14 / M1 finding 3).
    if (opts.onRuleApplied && out !== before) opts.onRuleApplied(rule, before, out)
  }
  // Restore frozen payloads. REVERSE creation order: a later payload may embed an earlier token (a
  // rule that echoed its match via `$&`/`{{match}}`), so the outer token must expand first. split/join
  // (not String.replace) so a payload's literal `$&`/`$1` is never reinterpreted as a capture ref.
  for (let i = frozen.length - 1; i >= 0; i--) {
    out = out.split(tokenFor(i)).join(frozen[i])
  }
  // Backstop: a stray delimiter surviving the restore means a rule mangled a token (only a raw-PUA
  // strip can), so the "a later rule can't corrupt a frozen payload" guarantee is broken here. Re-run
  // WITHOUT freezing — the exact un-frozen output (slower, but never wrong). Guarded by `canFreeze` so
  // the un-frozen re-run (which produces no tokens) can't recurse.
  if (canFreeze && out.includes(SENT)) {
    return applyRegexRules(text, rules, ctx, { ...opts, freezePayloads: false })
  }
  return out
}
