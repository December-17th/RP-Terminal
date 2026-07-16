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
const buildReplacement = (
  rule: RegexLikeRule,
  match: string,
  groups: Array<string | undefined>,
  ctx: RegexApplyContext
): string => {
  let trimmed = match
  for (const t of rule.trimStrings) if (t) trimmed = trimmed.split(t).join('')
  const card = isCardPayload(rule.replace)
  let out = rule.replace
    .replace(/\{\{match\}\}/gi, trimmed)
    .replace(/\{\{user\}\}/gi, ctx.user ?? '')
    .replace(/\{\{char\}\}/gi, ctx.char ?? '')
  if (!card) out = out.replace(/\$&/g, match)
  out = out.replace(/\$(\d{1,2})/g, (m, n) => {
    const groupNumber = Number(n)
    if (groupNumber === 0) return card ? m : match
    const i = groupNumber - 1
    return i < groups.length ? (groups[i] ?? '') : m
  })
  if (!card) out = out.replace(/\\n/g, '\n')
  return out
}

/** Pull (match, capture groups) out of a String.prototype.replace callback's args,
 * dropping the trailing offset/string and an optional named-groups object. */
const replaceArgs = (args: unknown[]): { match: string; groups: Array<string | undefined> } => {
  const rest = [...args]
  if (typeof rest[rest.length - 1] === 'object') rest.pop() // named-groups object (if any)
  rest.pop() // whole input string
  rest.pop() // match offset
  return { match: rest[0] as string, groups: rest.slice(1) as Array<string | undefined> }
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
  /**
   * DISPLAY-path only: when a rule injects a card payload (beautification HTML — see isCardPayload),
   * replace that injected region with an opaque placeholder so LATER rules don't rescan it, then
   * restore it verbatim at the end. A cleanup regex backtracking over a 100KB+ HTML paste stalls the
   * render for SECONDS (the plot panel re-ran this on every turn-settle and froze the whole app; the
   * repro: a preset beautifier pastes ~148KB, then two same-tier cleanups rescan it — ~5s). The
   * scope-tier ordering (regexOrder test) only shields a WORLD/SESSION-scoped beautifier from PRESET
   * cleanups; a PRESET-scoped beautifier is still rescanned by same-tier cleanups — this guards it
   * regardless of scope. OFF by default so the PROMPT path stays byte-identical (a beautifier is
   * display-only and never reaches the prompt anyway). Final output is unchanged EXCEPT that a later
   * rule can no longer match structure INSIDE an injected payload — the intended fix: a cleanup must
   * not rewrite (or backtrack over) an already-finished card.
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
  // behind an opaque Unicode Private-Use-Area placeholder (U+E000) so subsequent rules scan a short
  // token instead of the full paste; restored verbatim at the end. U+E000 never appears in card/model
  // text; if it somehow does in the input, disable freezing so a real payload can't be corrupted.
  const SENT = String.fromCharCode(0xe000)
  const canFreeze = opts.freezePayloads === true && !text.includes(SENT)
  const frozen: string[] = []
  const freeze = (payload: string): string => {
    const token = `${SENT}${frozen.length}${SENT}`
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
    let re: RegExp
    try {
      re = opts.compile ? opts.compile(rule) : new RegExp(rule.source, rule.flags)
    } catch {
      continue
    }
    re.lastIndex = 0 // reset stateful (global) regexes — important for cached instances
    out = out.replace(re, (...args) => {
      const { match, groups } = replaceArgs(args)
      const repl = buildReplacement(rule, match, groups, ctx)
      const mk = opts.marker?.(rule)
      const full = mk ? mk + repl : repl
      // Freeze a genuine card payload so LATER rules scan the token, not the paste. Plain-text
      // replacements (the common case, and every prompt-path rule) pass through unchanged.
      return canFreeze && isCardPayload(full) ? freeze(full) : full
    })
  }
  // Restore frozen payloads. REVERSE creation order: a later payload may embed an earlier token (a
  // rule that echoed its match via `$&`/`{{match}}`), so the outer token must expand first. split/join
  // (not String.replace) so a payload's literal `$&`/`$1` is never reinterpreted as a capture ref.
  for (let i = frozen.length - 1; i >= 0; i--) {
    out = out.split(`${SENT}${i}${SENT}`).join(frozen[i])
  }
  return out
}
