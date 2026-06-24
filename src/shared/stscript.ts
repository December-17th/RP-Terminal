/**
 * STScript subset (TH-8) — a clean-room interpreter for the common SillyTavern
 * slash-command language: pipes (`|`), named args (`key=value`), quoted values,
 * closures (`{: ... :}`), `{{pipe}}` threading, and `{{...}}` macro interpolation, over
 * a small set of built-ins (echo/setvar/getvar/addvar/.../if/run/abort/comment). Anything
 * else is delegated to the host's command registry (so /gen, plugin commands, etc. work).
 *
 * Timeboxed to the common subset (not full STScript): no while/loops, sub-pipes, or the
 * long-tail command set. Parsing is pure + unit-tested; side effects go through injected
 * ctx callbacks. Reimplemented from public docs — no js-slash-runner code.
 */
import { expandMacros } from './macros'

export interface StCommand {
  name: string
  named: Record<string, string>
  value: string
}

export interface StCtx {
  /** Local variable snapshot (mutated as the script runs). */
  vars: Record<string, unknown>
  /** Global variable snapshot. */
  globals: Record<string, unknown>
  /** Persist a variable write. */
  setVar: (key: string, value: unknown, scope: 'local' | 'global') => Promise<void> | void
  /** Run a command this interpreter doesn't handle (delegates to the host registry). */
  fallback: (cmd: StCommand, pipe: string) => Promise<string> | string
  rng?: () => number
}

class StAbort extends Error {}

/** A line is STScript (vs a single legacy /command) when it pipes or uses a closure. */
export const looksLikeStScript = (line: string): boolean =>
  line.includes('|') || line.includes('{:')

const isClosure = (s: string): boolean => s.trim().startsWith('{:') && s.trim().endsWith(':}')
const closureBody = (s: string): string => s.trim().slice(2, -2).trim()

/** Split a script into top-level commands on `|`, respecting quotes + nested closures. */
export const splitPipes = (src: string): string[] => {
  const out: string[] = []
  let buf = ''
  let quote = false
  let depth = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const two = src.slice(i, i + 2)
    if (quote) {
      if (c === '"') quote = false
      buf += c
    } else if (two === '{:') {
      depth++
      buf += two
      i++
    } else if (two === ':}') {
      depth = Math.max(0, depth - 1)
      buf += two
      i++
    } else if (c === '"') {
      quote = true
      buf += c
    } else if (c === '|' && depth === 0) {
      out.push(buf)
      buf = ''
    } else {
      buf += c
    }
  }
  out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

// Read one value token (quoted string, closure, or bareword) starting at pos.
const readValue = (s: string, pos: number): { value: string; end: number } => {
  if (s[pos] === '"') {
    let i = pos + 1
    let v = ''
    while (i < s.length && s[i] !== '"') v += s[i++]
    return { value: v, end: i + 1 }
  }
  if (s.slice(pos, pos + 2) === '{:') {
    let depth = 0
    let i = pos
    while (i < s.length) {
      const two = s.slice(i, i + 2)
      if (two === '{:') {
        depth++
        i += 2
      } else if (two === ':}') {
        depth--
        i += 2
        if (depth === 0) break
      } else i++
    }
    return { value: s.slice(pos, i), end: i }
  }
  let i = pos
  while (i < s.length && !/\s/.test(s[i])) i++
  return { value: s.slice(pos, i), end: i }
}

/** Parse one `/name key=value ... rest` segment into a command. */
export const parseCommand = (segment: string): StCommand | null => {
  const t = segment.trim()
  if (!t.startsWith('/')) return null
  const sp = t.search(/\s/)
  const name = (sp < 0 ? t.slice(1) : t.slice(1, sp)).toLowerCase()
  let body = sp < 0 ? '' : t.slice(sp + 1)

  const named: Record<string, string> = {}
  // Consume a leading run of key=value pairs.
  for (;;) {
    const m = /^\s*([A-Za-z_]\w*)=/.exec(body)
    if (!m) break
    const valStart = m[0].length
    const { value, end } = readValue(body, valStart)
    named[m[1]] = value
    body = body.slice(end)
  }
  return { name, named, value: body.trim() }
}

export const parseScript = (src: string): StCommand[] =>
  splitPipes(src)
    .map(parseCommand)
    .filter((c): c is StCommand => c !== null)

const parseVal = (s: string): unknown => {
  const t = s.trim()
  if (t === '') return ''
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

const getPath = (obj: Record<string, unknown>, key: string): unknown => {
  let cur: unknown = obj
  for (const p of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}
const setPathLocal = (obj: Record<string, unknown>, key: string, val: unknown): void => {
  const parts = key.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = val
}

const compare = (left: string, right: string, rule: string): boolean => {
  const ln = Number(left)
  const rn = Number(right)
  const nums = Number.isFinite(ln) && Number.isFinite(rn)
  switch (rule) {
    case 'eq':
      return left === right
    case 'neq':
      return left !== right
    case 'gt':
      return nums && ln > rn
    case 'gte':
      return nums && ln >= rn
    case 'lt':
      return nums && ln < rn
    case 'lte':
      return nums && ln <= rn
    default:
      return false
  }
}

/** Run a parsed script, threading the pipe value through each command. */
export const runScript = async (src: string, ctx: StCtx): Promise<string> => {
  let pipe = ''
  try {
    for (const cmd of parseScript(src)) {
      pipe = await runCommand(cmd, pipe, ctx)
    }
  } catch (e) {
    if (e instanceof StAbort) return pipe
    throw e
  }
  return pipe
}

const runCommand = async (cmd: StCommand, pipe: string, ctx: StCtx): Promise<string> => {
  // Expand {{pipe}} + macros in args, but leave closures untouched (they run later with
  // their own pipe).
  const expand = (s: string): string =>
    isClosure(s)
      ? s
      : expandMacros(s.replace(/\{\{pipe\}\}/gi, pipe), {
          vars: ctx.vars,
          globals: ctx.globals,
          rng: ctx.rng
        })
  const named: Record<string, string> = {}
  for (const k of Object.keys(cmd.named)) named[k] = expand(cmd.named[k])
  const value = expand(cmd.value)

  const setVar = async (scope: 'local' | 'global', key: string, val: unknown): Promise<void> => {
    setPathLocal(scope === 'global' ? ctx.globals : ctx.vars, key, val)
    await ctx.setVar(key, val, scope)
  }
  const firstWord = (s: string): string => s.trim().split(/\s+/)[0] || ''
  const rest = (s: string): string => s.trim().split(/\s+/).slice(1).join(' ')

  switch (cmd.name) {
    case 'echo':
      return value || pipe
    case 'comment':
    case '#':
      return pipe
    case 'abort':
      throw new StAbort()
    case 'setvar':
    case 'setglobalvar': {
      const scope = cmd.name === 'setglobalvar' ? 'global' : 'local'
      const key = named.key || firstWord(value)
      if (!key) return pipe
      const raw = named.value != null ? named.value : named.key ? value : rest(value)
      const val = parseVal(raw || pipe)
      await setVar(scope, key, val)
      return typeof val === 'string' ? val : JSON.stringify(val)
    }
    case 'getvar':
    case 'getglobalvar': {
      const store = cmd.name === 'getglobalvar' ? ctx.globals : ctx.vars
      const key = named.key || value.trim()
      const v = getPath(store, key)
      return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
    }
    case 'addvar':
    case 'addglobalvar': {
      const scope = cmd.name === 'addglobalvar' ? 'global' : 'local'
      const store = scope === 'global' ? ctx.globals : ctx.vars
      const key = named.key || firstWord(value)
      const n = Number(named.value != null ? named.value : named.key ? value : rest(value)) || 0
      const next = (Number(getPath(store, key)) || 0) + n
      await setVar(scope, key, next)
      return String(next)
    }
    case 'if': {
      const ok = compare(named.left ?? '', named.right ?? '', (named.rule || 'eq').toLowerCase())
      const branch = ok ? cmd.value : cmd.named.else
      if (branch && isClosure(branch)) return runScript(closureBody(branch), ctx)
      return ok ? value : ''
    }
    case 'run': {
      if (isClosure(cmd.value)) return runScript(closureBody(cmd.value), ctx)
      return String(
        (await ctx.fallback({ name: firstWord(value), named, value: rest(value) }, pipe)) ?? ''
      )
    }
    default:
      return String((await ctx.fallback({ name: cmd.name, named, value }, pipe)) ?? '')
  }
}
