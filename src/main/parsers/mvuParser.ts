/**
 * MagVarUpdate (MVU) command protocol — clean-room (Track R / R1).
 *
 * MVU cards keep an RPG state object (`stat_data`) in sync with the story by having
 * the model emit update commands wrapped in an `<UpdateVariable>` block, e.g.
 *
 *   <UpdateVariable>
 *   _.set('主角.生命值', 100, 80);//受到攻击
 *   _.add('命运点数', 1);//完成任务
 *   _.assign('关系列表.艾莉', '好感', 5);
 *   _.insert('任务列表', 0, { 名: '寻找钥匙' });
 *   _.remove('世界.地点');
 *   </UpdateVariable>
 *
 * MVU grammar (verified against MagVarUpdate, MIT): the **new value is always the LAST
 * argument** — `_.set(path, old, new)` records `old` but applies `new` (the old value "isn't
 * actually checked"), and `_.set(path, new)` is also valid. The **reason is the trailing
 * `//comment`**, never a positional argument. This module parses those blocks (sibling to
 * `contentParser`'s `<rpt-event>`) and applies them to `stat_data`, recording a per-turn
 * `delta_data` audit. Reimplemented from the documented grammar — no MVU code is copied (MVU
 * is MIT and could be, but we keep it clean). Args are read by a tolerant JS-literal reader,
 * NOT `eval`.
 */

export interface MvuCommand {
  op: 'set' | 'add' | 'assign' | 'insert' | 'remove' | 'move'
  path: string
  value?: unknown
  /** insert position; omitted = append. */
  index?: number
  /** assign/remove member key or array index (3-arg assign sets it; 2-arg remove deletes it). */
  key?: string | number
  /** move destination path. */
  to?: string
  /** human-readable reason — MVU's trailing `//comment`, recorded in delta_data. */
  reason?: string
}

export interface MvuDelta {
  path: string
  old: unknown
  new: unknown
  reason?: string
}

/** A single RFC-6902 JSON Patch op — the `<JSONPatch>` MVU dialect (e.g. 命定之诗). */
export interface JsonPatchOp {
  op: string // add | remove | replace | move | copy | test
  /** JSON Pointer resolved against stat_data, e.g. "/角色/梅芙/HP". */
  path: string
  value?: unknown
  /** source pointer for move/copy. */
  from?: string
}

export interface ParsedMvu {
  /** Narrative text with the `<UpdateVariable>` blocks stripped. */
  text: string
  /** `_.set(...)`-style commands (classic MagVarUpdate dialect). */
  commands: MvuCommand[]
  /** `<JSONPatch>[…]` ops (the JSON-Patch dialect). */
  patches: JsonPatchOp[]
}

// --- dot/bracket path helpers (independent copy; parsers don't import services) ---
const toParts = (p: string): string[] =>
  String(p)
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)

const getPath = (obj: any, p: string): any => {
  let cur = obj
  for (const part of toParts(p)) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

const setPath = (obj: any, p: string, val: any): void => {
  const parts = toParts(p)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = val
}

const delPath = (obj: any, p: string): void => {
  const parts = toParts(p)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return
    cur = cur[parts[i]]
  }
  if (cur) delete cur[parts[parts.length - 1]]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

// --- tolerant JS-literal argument reader (handles single/double quotes, numbers,
// booleans, null, arrays, and objects with quoted OR unquoted keys) ---
const parseArgList = (src: string): unknown[] => {
  let i = 0
  const s = src
  const ws = (): void => {
    while (i < s.length && /\s/.test(s[i])) i++
  }
  const str = (q: string): string => {
    i++ // opening quote
    let out = ''
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const n = s[i + 1]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
        i += 2
      } else {
        out += s[i]
        i++
      }
    }
    i++ // closing quote
    return out
  }
  const token = (): unknown => {
    const start = i
    while (i < s.length && s[i] !== ',' && s[i] !== ']' && s[i] !== '}') i++
    const t = s.slice(start, i).trim()
    if (t === 'true') return true
    if (t === 'false') return false
    if (t === '' || t === 'null' || t === 'undefined') return null
    const n = Number(t)
    return Number.isNaN(n) ? t : n
  }
  const arr = (): unknown[] => {
    i++ // [
    const out: unknown[] = []
    ws()
    if (s[i] === ']') {
      i++
      return out
    }
    for (;;) {
      out.push(value())
      ws()
      if (s[i] === ',') {
        i++
        continue
      }
      if (s[i] === ']') i++
      break
    }
    return out
  }
  const key = (): string => {
    ws()
    const c = s[i]
    if (c === '"' || c === "'") return str(c)
    const start = i
    while (i < s.length && s[i] !== ':' && !/\s/.test(s[i])) i++
    return s.slice(start, i).trim()
  }
  const obj = (): Record<string, unknown> => {
    i++ // {
    const out: Record<string, unknown> = {}
    ws()
    if (s[i] === '}') {
      i++
      return out
    }
    for (;;) {
      const k = key()
      ws()
      if (s[i] === ':') i++
      out[k] = value()
      ws()
      if (s[i] === ',') {
        i++
        ws()
        continue
      }
      if (s[i] === '}') i++
      break
    }
    return out
  }
  const value = (): unknown => {
    ws()
    const c = s[i]
    if (c === '"' || c === "'") return str(c)
    if (c === '[') return arr()
    if (c === '{') return obj()
    return token()
  }

  const list: unknown[] = []
  ws()
  if (i >= s.length) return list
  for (;;) {
    list.push(value())
    ws()
    if (s[i] === ',') {
      i++
      continue
    }
    break
  }
  return list
}

/** Find `_.op(...)` calls in a block, extracting balanced `(...)` args (so parens
 * inside strings/objects don't truncate the match the way a naive regex would). */
const findCalls = (block: string): Array<{ op: string; argsSrc: string; comment?: string }> => {
  const out: Array<{ op: string; argsSrc: string; comment?: string }> = []
  const re = /_\.(set|add|delta|assign|insert|remove|unset|delete|move)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const op = m[1]
    let i = re.lastIndex
    const start = i
    let depth = 1
    let inStr: string | null = null
    while (i < block.length && depth > 0) {
      const c = block[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === inStr) inStr = null
      } else if (c === '"' || c === "'") inStr = c
      else if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
      i++
    }
    // MVU's reason is a trailing `//comment` on the SAME line (after an optional `;`).
    // Use [ \t]* (not \s*) so it can't reach a `//` on a following line.
    const tail = block.slice(i).match(/^[ \t]*;?[ \t]*\/\/([^\n\r]*)/)
    out.push({ op, argsSrc: block.slice(start, i - 1), comment: tail ? tail[1].trim() : undefined })
    re.lastIndex = i
  }
  return out
}

const keyArg = (a: unknown): string | number =>
  typeof a === 'number' ? a : typeof a === 'string' ? a : String(a)

const normalize = (op: string, args: unknown[], comment?: string): MvuCommand | null => {
  const path = typeof args[0] === 'string' ? args[0] : args[0] == null ? '' : String(args[0])
  if (!path) return null
  const reason = comment || undefined
  // MVU's new value is ALWAYS the last argument; any earlier value arg is the OLD value, which
  // MVU records but does not apply.
  const last = args[args.length - 1]
  switch (op) {
    case 'set':
      if (args.length < 2) return null
      return { op: 'set', path, value: last, reason }
    case 'add':
    case 'delta':
      if (args.length < 2) return null
      return { op: 'add', path, value: last, reason }
    case 'assign':
      if (args.length < 2) return null
      // (path, key, value) sets a specific member; (path, value) merges.
      return args.length >= 3
        ? { op: 'assign', path, key: keyArg(args[1]), value: last, reason }
        : { op: 'assign', path, value: last, reason }
    case 'insert':
      if (args.length < 2) return null
      // (path, index, value) inserts at index; (path, value) appends.
      return args.length >= 3 && typeof args[1] === 'number'
        ? { op: 'insert', path, index: args[1], value: last, reason }
        : { op: 'insert', path, value: last, reason }
    case 'remove':
    case 'unset':
    case 'delete':
      // (path, key) removes a member; (path) removes the whole path.
      return args.length >= 2
        ? { op: 'remove', path, key: keyArg(args[1]), reason }
        : { op: 'remove', path, reason }
    case 'move':
      if (args.length < 2) return null
      return { op: 'move', path, to: String(args[1]), reason }
    default:
      return null
  }
}

/** Parse `<UpdateVariable>` blocks out of model output into normalized commands. */
export const parseMvuCommands = (content: string): ParsedMvu => {
  const commands: MvuCommand[] = []
  const patches: JsonPatchOp[] = []
  // Tempered match: the inner part can't span ANOTHER `<UpdateVariable>` opening, so a STRAY
  // unclosed mention (e.g. the model narrating "Output <UpdateVariable> ...") no longer makes the
  // lazy match run from that mention to the real closing tag and delete the narrative between.
  const blockRe =
    /<(UpdateVariable|update|updatevariable)>((?:(?!<(?:UpdateVariable|update|updatevariable)>)[\s\S])*?)<\/\1>/gi
  const text = content.replace(blockRe, (_full, _tag, inner) => {
    // <JSONPatch>[…]</JSONPatch> dialect (this card): one JSON array of RFC-6902 ops.
    const jp = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(inner)
    if (jp) for (const p of parseJsonPatch(jp[1])) patches.push(p)
    // `_.set(...)` dialect (classic MagVarUpdate).
    for (const { op, argsSrc, comment } of findCalls(inner)) {
      const cmd = normalize(op, parseArgList(argsSrc), comment)
      if (cmd) commands.push(cmd)
    }
    return ''
  })
  return { text: text.trim(), commands, patches }
}

/** Parse a block as a single JS object — JSON first, then the tolerant reader
 * (unquoted keys / single quotes). Returns null if it isn't an object. Used by the
 * init-var seeding (R2) to read `[initvar]` code blocks. */
export const parseJsObject = (src: string): Record<string, any> | null => {
  const t = src.trim()
  if (!t) return null
  try {
    const v = JSON.parse(t)
    return isObj(v) ? (v as Record<string, any>) : null
  } catch {
    /* fall through to the tolerant reader */
  }
  try {
    const list = parseArgList(t)
    const v = list.length ? list[0] : undefined
    return isObj(v) ? (v as Record<string, any>) : null
  } catch {
    return null
  }
}

/** Apply commands to a mutable `stat_data` object; returns a per-command delta log. */
export const applyMvuCommands = (
  statData: Record<string, any>,
  commands: MvuCommand[]
): MvuDelta[] => {
  const deltas: MvuDelta[] = []
  for (const c of commands) {
    const before = clone(getPath(statData, c.path))
    switch (c.op) {
      case 'set':
        setPath(statData, c.path, c.value)
        break
      case 'add': {
        const cur = Number(getPath(statData, c.path)) || 0
        setPath(statData, c.path, cur + (Number(c.value) || 0))
        break
      }
      case 'assign': {
        if (c.key != null) {
          // (path, key, value): set a specific member on the collection at path.
          let coll = getPath(statData, c.path)
          if (coll == null || typeof coll !== 'object') {
            coll = typeof c.key === 'number' ? [] : {}
            setPath(statData, c.path, coll)
          }
          coll[c.key] = c.value
          break
        }
        const cur = getPath(statData, c.path)
        if (Array.isArray(cur) && Array.isArray(c.value))
          setPath(statData, c.path, [...cur, ...c.value])
        else if (isObj(cur) && isObj(c.value)) setPath(statData, c.path, { ...cur, ...c.value })
        else setPath(statData, c.path, c.value)
        break
      }
      case 'insert': {
        let arr = getPath(statData, c.path)
        if (!Array.isArray(arr)) {
          arr = []
          setPath(statData, c.path, arr)
        }
        if (typeof c.index === 'number') arr.splice(c.index, 0, c.value)
        else arr.push(c.value)
        break
      }
      case 'remove': {
        if (c.key != null) {
          // (path, key): remove one member from the collection at path.
          const cur = getPath(statData, c.path)
          if (Array.isArray(cur) && typeof c.key === 'number') cur.splice(c.key, 1)
          else if (isObj(cur)) delete cur[c.key]
          break
        }
        delPath(statData, c.path)
        break
      }
      case 'move': {
        // (from, to): relocate the value, recording the destination delta too.
        const v = clone(getPath(statData, c.path))
        if (c.to) {
          const beforeTo = clone(getPath(statData, c.to))
          setPath(statData, c.to, v)
          deltas.push({ path: c.to, old: beforeTo, new: clone(v), reason: c.reason })
        }
        delPath(statData, c.path)
        break
      }
    }
    deltas.push({
      path: c.path,
      old: before,
      new: clone(getPath(statData, c.path)),
      reason: c.reason
    })
  }
  return deltas
}

// --- JSON Patch (RFC 6902) — the `<JSONPatch>` MVU dialect. JSON Pointer paths are resolved
// against stat_data (the same root as `_.set`). Implemented from the spec; no code copied. ---

const ptrSegments = (pointer: string): string[] =>
  String(pointer)
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))

const getAtSeg = (obj: any, segs: string[]): any => {
  let cur = obj
  for (const s of segs) {
    if (cur == null) return undefined
    cur = cur[s]
  }
  return cur
}

const setAtSeg = (obj: any, segs: string[], val: any): void => {
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]
    // The container's type is decided by the NEXT segment: the array-append token `-` or a numeric
    // index ⇒ an array; anything else ⇒ an object. Creating it as the wrong type is why `add
    // /主角/身份/-` was building `{ "-": … }` instead of `[ … ]` (failing the card's array schema).
    const next = segs[i + 1]
    const wantArray = next === '-' || /^\d+$/.test(next)
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = wantArray ? [] : {}
    cur = cur[k]
  }
  const last = segs[segs.length - 1]
  if (Array.isArray(cur) && last === '-')
    cur.push(val) // JSON Patch array-append token
  else cur[last] = val
}

const removeAtSeg = (obj: any, segs: string[]): void => {
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur == null) return
    cur = cur[segs[i]]
  }
  if (cur == null) return
  const last = segs[segs.length - 1]
  if (Array.isArray(cur)) cur.splice(Number(last), 1)
  else delete cur[last]
}

/** Parse a `<JSONPatch>` body (a JSON array of ops). Tolerant: invalid JSON → []. */
export const parseJsonPatch = (src: string): JsonPatchOp[] => {
  let arr: unknown
  try {
    arr = JSON.parse(String(src).trim())
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: JsonPatchOp[] = []
  for (const o of arr) {
    if (
      o &&
      typeof o === 'object' &&
      typeof (o as any).op === 'string' &&
      typeof (o as any).path === 'string'
    ) {
      const a = o as any
      out.push({ op: a.op, path: a.path, value: a.value, from: a.from })
    }
  }
  return out
}

/** Apply RFC-6902 ops to a mutable root (stat_data); returns a per-op delta log (mag_* events). */
/** Apply a numeric `delta` (increment/decrement) to a stat value, honoring the common MVU value
 *  shapes: a plain number, a `[value, …]` tuple, or a "current/max" string. Missing → starts at 0. */
const applyNumericDelta = (cur: any, delta: number): any => {
  if (cur == null) return delta
  if (typeof cur === 'number') return cur + delta
  if (Array.isArray(cur) && typeof cur[0] === 'number') return [cur[0] + delta, ...cur.slice(1)]
  if (typeof cur === 'string') {
    const cm = cur.match(/^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(.+)$/) // "current/max"
    if (cm) return `${parseFloat(cm[1]) + delta}/${cm[2].trim()}`
    const n = parseFloat(cur)
    if (!Number.isNaN(n) && /^\s*-?\d/.test(cur)) return String(n + delta)
  }
  return cur // not a number-bearing shape — leave unchanged
}

export const applyJsonPatch = (root: Record<string, any>, ops: JsonPatchOp[]): MvuDelta[] => {
  const deltas: MvuDelta[] = []
  for (const o of ops) {
    const segs = ptrSegments(o.path)
    if (!segs.length) continue
    const before = clone(getAtSeg(root, segs))
    switch (o.op) {
      // RFC-6902 `add`/`replace` plus the non-standard aliases real MVU/variable frameworks emit
      // (e.g. this card initializes keys with `insert`).
      case 'add':
      case 'insert':
      case 'set':
      case 'replace':
        setAtSeg(root, segs, o.value)
        break
      case 'remove':
      case 'delete':
      case 'unset':
        removeAtSeg(root, segs)
        break
      case 'move': {
        if (!o.from) continue
        const fromSegs = ptrSegments(o.from)
        const v = clone(getAtSeg(root, fromSegs))
        removeAtSeg(root, fromSegs)
        setAtSeg(root, segs, v)
        break
      }
      case 'copy': {
        if (!o.from) continue
        setAtSeg(root, segs, clone(getAtSeg(root, ptrSegments(o.from))))
        break
      }
      // Non-standard MVU op: increment the existing numeric stat by `value` (e.g. EXP +30, MP -500).
      case 'delta': {
        const d = typeof o.value === 'number' ? o.value : parseFloat(String(o.value))
        if (Number.isNaN(d)) continue
        setAtSeg(root, segs, applyNumericDelta(getAtSeg(root, segs), d))
        break
      }
      case 'test':
      default:
        continue // assertions + unknown ops don't mutate
    }
    deltas.push({ path: segs.join('.'), old: before, new: clone(getAtSeg(root, segs)) })
  }
  return deltas
}
