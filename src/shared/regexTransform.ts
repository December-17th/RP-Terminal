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
}

export interface RegexApplyContext {
  user?: string
  char?: string
}

/** Build a rule's replacement for one match: trimStrings stripped from `{{match}}`,
 * the `{{match}}`/`{{user}}`/`{{char}}` macros, `$N`/`$&` capture groups, and `\n`. */
const buildReplacement = (
  rule: RegexLikeRule,
  match: string,
  groups: Array<string | undefined>,
  ctx: RegexApplyContext
): string => {
  let trimmed = match
  for (const t of rule.trimStrings) if (t) trimmed = trimmed.split(t).join('')
  return rule.replace
    .replace(/\{\{match\}\}/gi, trimmed)
    .replace(/\{\{user\}\}/gi, ctx.user ?? '')
    .replace(/\{\{char\}\}/gi, ctx.char ?? '')
    .replace(/\$&/g, match)
    .replace(/\$(\d{1,2})/g, (_, n) => groups[Number(n) - 1] ?? '')
    .replace(/\\n/g, '\n')
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
  /** Supply a compiled RegExp for a rule (e.g. a cache); defaults to a fresh `new RegExp`. */
  compile?: (rule: R) => RegExp
}

/** Apply rules to `text` in order. A rule that fails to compile is skipped. */
export const applyRegexRules = <R extends RegexLikeRule>(
  text: string,
  rules: R[],
  ctx: RegexApplyContext = {},
  opts: ApplyOptions<R> = {}
): string => {
  let out = text
  for (const rule of rules) {
    if (
      opts.placement !== undefined &&
      rule.placement.length > 0 &&
      !rule.placement.includes(opts.placement)
    ) {
      continue
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
      return buildReplacement(rule, match, groups, ctx)
    })
  }
  return out
}
