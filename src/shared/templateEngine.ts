// The quickjs bridge is dynamically typed (vm.dump → any, helper args are user-supplied), so `any` is
// intentional throughout this file — same as the original engine in templateService.
// Type-only import — the shared engine never pulls a runtime quickjs variant; the host injects one via
// `initEngine(loader)` (main → wasmfile variant; renderer → embedded singlefile variant).
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten'
import { toParts, getPath, setPath } from './objectPath'
import { SANDBOX_LIB_JS } from './sandboxLib'

/**
 * ST-Prompt-Template compatible EJS engine — the PURE core, shared by the main
 * process (prompt-build time) and the renderer (render-time). Card/preset/lore
 * templates are EJS-style (`<% %>`, `<%- %>`, `<%= %>`) and compile to JS, so
 * they run inside a quickjs WASM sandbox, fully isolated from Node/the DOM.
 *
 * This module imports NOTHING from `src/main` or `src/renderer`. Host-specific
 * pieces (logging, the JSON-patch impl) are injected via `setEngineDeps`; global
 * persistence stays in the main-process wrapper (`templateService`). Any failure
 * falls back to stripping the tags so a bad template can never break output.
 */

// --- injectable host deps (main wires the real ones; renderer/tests get safe no-ops) ---
type LogFn = (level: string, msg: string, detail?: string) => void
type PatchFn = (root: Record<string, any>, ops: any[]) => unknown
type YamlStringifyFn = (val: any, opts?: any) => string
type YamlParseFn = (text: string) => any
let logFn: LogFn = () => {}
let patchFn: PatchFn = () => {}
// YAML for the `YAML` sandbox global (world-info/status entries call YAML.stringify/parse). Defaults to a
// JSON round-trip (JSON is valid YAML, so values still reach the AI) and main overrides with the real
// `yaml` package for faithful block-style output. Never throw — a bad serialize would strip the entry.
let yamlStringifyFn: YamlStringifyFn = (val) => {
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return ''
  }
}
let yamlParseFn: YamlParseFn = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Wire host-specific deps. Call before `initEngine`. */
export const setEngineDeps = (deps: {
  log?: LogFn
  applyJsonPatch?: PatchFn
  yamlStringify?: YamlStringifyFn
  yamlParse?: YamlParseFn
}): void => {
  if (deps.log) logFn = deps.log
  if (deps.applyJsonPatch) patchFn = deps.applyJsonPatch
  if (deps.yamlStringify) yamlStringifyFn = deps.yamlStringify
  if (deps.yamlParse) yamlParseFn = deps.yamlParse
}

/** Read-only data exposed to the TH-3 template helpers (getchar/getwi/…). */
export interface TemplateData {
  charData?: Record<string, unknown>
  worldInfo?: Array<{ name: string; content: string }>
  messages?: Array<{ user: string; assistant: string }>
  chatName?: string
  presetName?: string
  /** The active preset's prompt blocks (for getPreset(name) → a named block's content). */
  presetPrompts?: Array<{ name: string; identifier: string; content: string }>
}

/**
 * Escaper profile for `<%= … %>` (ST-Prompt-Template splits this by phase):
 *  · 'identity' (GENERATION, default) — `<%=` returns its value UNCHANGED, so `<%=` and `<%-` produce
 *    identical PROMPT text (the profile's generation escaper is the identity function).
 *  · 'html' (RENDER / DOM display) — `<%=` HTML-escapes so card markup can't break the rendered DOM,
 *    while `<%-` still emits raw. This is the profile's distinct render escaper.
 * See docs/research/sillytavern-prompt-compatibility.md §6 (generation options vs render escaper).
 */
export type EscapeMode = 'identity' | 'html'

/**
 * OBSERVATION-ONLY notification that a variable-writing helper (`setvar`/`incvar`/`decvar`/`delvar`
 * and their scope aliases) just wrote the store. Purely additive: it fires AFTER the mutation, its
 * return value is discarded, and a throw is swallowed — it can change neither the rendered output
 * nor a helper's return value.
 *
 * `path` is the key exactly as the template passed it (the bracket-aware dialect `setPath` uses);
 * `store` is the object the write LANDED ON, so a recorder can tell a floor-store write apart from a
 * `scope:'global'` one (→ `ctx.globals`) or a write against a derived read-only snapshot (the L1
 * frozen frontier renders with `vars` swapped for `frozenVars`). Reporting every write is the point;
 * deciding which ones matter belongs to the host, the only side that knows those stores apart.
 */
export type VarWriteHook = (
  path: string,
  kind: 'set' | 'delete',
  store: Record<string, any>
) => void

export interface TemplateContext {
  vars: Record<string, any> // chat/local variables (mutated by setvar)
  globals: Record<string, any> // global variables (persisted per profile)
  constants: Record<string, unknown> // userName, charName, lastUserMessage, …
  data?: TemplateData // TH-3: card/world-info/history/preset accessors
  /** When false, the EJS engine is OFF (settings toggle) — tags are stripped, not evaluated. */
  enabled?: boolean
  /** `<%=` escaper profile. Omitted/undefined → 'identity' (generation). Render/display passes 'html'. */
  escape?: EscapeMode
  /** Optional write recorder (see `VarWriteHook`). Absent → the helpers behave exactly as before. */
  onVarWrite?: VarWriteHook
}

export interface TemplateContextOpts {
  globals?: Record<string, any>
  constants?: Record<string, unknown>
  data?: TemplateData
  enabled?: boolean
  escape?: EscapeMode
  onVarWrite?: VarWriteHook
}

/**
 * Canonical `TemplateContext` constructor — the SINGLE construction path shared by all three execution
 * contexts (prompt-build, render-time, WCV), so they stop drifting on the globals/constants/enabled
 * defaults (WS-1). `vars` is the variable store the helpers read/write; the engine resolves BOTH
 * `getvar('x')` and `getvar('stat_data.x')` from it (the stat_data read-fallback), so callers don't need
 * to pre-hoist for reads. Defaults: `globals`/`constants` → `{}`, `enabled` → true.
 */
export const buildTemplateContext = (
  vars: Record<string, any>,
  opts: TemplateContextOpts = {}
): TemplateContext => ({
  vars: vars || {},
  globals: opts.globals ?? {},
  constants: opts.constants ?? {},
  data: opts.data,
  enabled: opts.enabled ?? true,
  escape: opts.escape,
  onVarWrite: opts.onVarWrite
})

let QJS: QuickJSWASMModule | null = null

/**
 * Hard wall-clock cap on a single template eval. quickjs `evalCode` is SYNCHRONOUS and, without an
 * interrupt handler, an unbounded template (`<% while(true){} %>` a card/AI emits, or a pathological
 * loop over the vars) hangs the thread FOREVER — freezing the renderer on display and the main process
 * at prompt-build, and re-freezing on every reload of that floor. The interrupt handler below aborts
 * past this deadline; evalCode then returns an interrupt error and we fall through to the empty-output
 * error path (fail-safe: a bad template can't brick the app). Generous vs any legit EJS interpolation.
 */
const EVAL_DEADLINE_MS = 1000

/**
 * Load the quickjs WASM module via the host-provided `loader` (main passes the default
 * wasmfile variant; the renderer passes a singlefile browser variant so the WASM is
 * embedded — no .wasm fetch under a bundler). Idempotent; each process loads its own.
 */
export const initEngine = async (loader: () => Promise<QuickJSWASMModule>): Promise<void> => {
  if (QJS) return
  try {
    QJS = await loader()
  } catch (e: any) {
    logFn('error', 'Template engine failed to initialize', e?.message || String(e))
  }
}

/**
 * Has a quickjs module been loaded (`initEngine`) in THIS process? Callers that must distinguish
 * "the engine ran and the template failed" from "there is no engine yet" need this: without it both
 * look like a clean `evalTemplateDetailed` result, because the not-initialized path deliberately
 * strips tags instead of erroring. Agent prompt rendering uses it to fall back to the RAW text.
 */
export const isEngineReady = (): boolean => QJS !== null

export const hasTags = (s: string): boolean => s.includes('<%')
export const stripTags = (s: string): string => s.replace(/<%[\s\S]*?%>/g, '')

// dot/bracket path get/set live in the shared objectPath module

// Sentinels for the `<%%`/`%%>` literal escapes (EJS: `<%%` → literal `<%`, `%%>` → literal `%>`). We swap
// them out BEFORE the tag scan so they can never be read as delimiters, then restore them as literal text
// when a literal chunk is emitted. Chosen to be vanishingly unlikely in real template prose and to contain
// no `<%`/`%>` themselves (so the tag regex never trips on a sentinel).
const SENT_OPEN = '__RPT_EJS_LITERAL_OPEN__'
const SENT_CLOSE = '__RPT_EJS_LITERAL_CLOSE__'

// ST-Prompt-Template protected regions: EJS-looking text inside these is NOT evaluated (emitted literally).
// `<escape-ejs>` is a pure directive — its wrapper tags are dropped and the inner text passes through raw.
// `<thinking>`/`<think>`/`<reasoning>` are semantic reasoning markers — the wrapper tags are KEPT and only
// EJS evaluation is suppressed inside. Clean-room from docs §6 (utils/prompts.ts protected-region rewrite).
const PROTECTED_RE = /<(thinking|think|reasoning|escape-ejs)>([\s\S]*?)<\/\1>/gi

/** Emit one literal chunk as an `__append(...)` call, restoring the `<%%`/`%%>` escapes to literal text. */
const emitLiteral = (text: string): string => {
  if (!text) return ''
  const restored = text.split(SENT_OPEN).join('<%').split(SENT_CLOSE).join('%>')
  return `__append(${JSON.stringify(restored)});\n`
}

/**
 * Compile ONE non-protected segment: walk the EJS tags, honoring the trailing newline-trim (`-%>`/`_%>`).
 * `<%=` → escaped append (identity in generation, HTML at render); `<%-` → raw append; `<%#` → comment;
 * `<%`/`<%_` → scriptlet. Whitespace-slurp of same-line spaces/tabs is done by the caller's pre-pass.
 */
const compileSegment = (seg: string): string => {
  let out = ''
  const re = /<%(=|-|_|#)?([\s\S]*?)([-_]?)%>/g
  let last = 0
  let trimNextNewline = false
  let m: RegExpExecArray | null
  const flushLit = (raw: string): void => {
    let lit = raw
    // `-%>`/`_%>` trim a single following newline (EJS 3.1.9 truncate mode, `_addOutput`).
    if (trimNextNewline) {
      lit = lit.replace(/^(?:\r\n|\r|\n)/, '')
      trimNextNewline = false
    }
    out += emitLiteral(lit)
  }
  while ((m = re.exec(seg)) !== null) {
    flushLit(seg.slice(last, m.index))
    const open = m[1] || ''
    const code = m[2]
    const close = m[3] || ''
    if (open === '#') {
      /* <%# comment %> — emit nothing */
    } else if (open === '=') {
      out += `__append(__escape(${code}));\n`
    } else if (open === '-') {
      out += `__append(__str(${code}));\n`
    } else {
      // '' (plain `<%`) or '_' (`<%_` whitespace-slurp scriptlet) → control flow, no output.
      out += `${code}\n`
    }
    if (close === '-' || close === '_') trimNextNewline = true
    last = m.index + m[0].length
  }
  flushLit(seg.slice(last))
  return out
}

/**
 * Compile an EJS-style template into a JS function body that appends to `__out` (via `__append`). Faithful
 * to the pinned ST-Prompt-Template profile (bundled EJS 3.1.9 + wrapper options): protected regions, the
 * `<%%`/`%%>` literal escapes, and same-line whitespace-slurp for `<%_`/`_%>`. See docs §6.
 */
const compile = (tmpl: string): string => {
  // 1. Pull the literal `<%%`/`%%>` escapes out of harm's way (restored on literal emit).
  let src = tmpl.split('<%%').join(SENT_OPEN).split('%%>').join(SENT_CLOSE)
  // 2. EJS 3.1.9 whitespace-slurp: strip spaces/tabs (NOT newlines) immediately before `<%_` and after
  //    `_%>` — mirrors EJS `generateSource`'s `/[ \t]*<%_/` + `/_%>[ \t]*/` pre-pass. The single following
  //    newline is trimmed separately in `compileSegment` (truncate mode).
  src = src.replace(/[ \t]*<%_/g, '<%_').replace(/_%>[ \t]*/g, '_%>')
  // 3. Split off protected regions; compile only the normal segments, emit the protected text literally.
  let body = ''
  let last = 0
  let m: RegExpExecArray | null
  PROTECTED_RE.lastIndex = 0
  while ((m = PROTECTED_RE.exec(src)) !== null) {
    body += compileSegment(src.slice(last, m.index))
    const tag = m[1].toLowerCase()
    body += emitLiteral(tag === 'escape-ejs' ? m[2] : m[0])
    last = m.index + m[0].length
  }
  body += compileSegment(src.slice(last))
  return body
}

const jsToHandle = (vm: QuickJSContext, val: any): QuickJSHandle => {
  if (val === undefined) return vm.undefined
  if (val === null) return vm.null
  if (typeof val === 'number') return vm.newNumber(val)
  if (typeof val === 'string') return vm.newString(val)
  if (typeof val === 'boolean') return val ? vm.true : vm.false
  // Objects/arrays: round-trip through JSON inside the VM.
  const r = vm.evalCode(`(${JSON.stringify(val)})`)
  if (r.error) {
    r.error.dispose()
    return vm.undefined
  }
  return r.value
}

const installBridge = (vm: QuickJSContext, ctx: TemplateContext): void => {
  const storeFor = (opt: any): Record<string, any> =>
    opt && opt.scope === 'global' ? ctx.globals : ctx.vars

  /**
   * Report ONE completed write to `ctx.onVarWrite` (build-time setvar journaling). Called AFTER the
   * store mutation and its result is discarded, so evaluation order, the helper's return value, and
   * the rendered output are all untouched; a throwing hook is swallowed so a recorder bug can never
   * change what a template produces. No hook installed → this is a single null check.
   */
  const noteWrite = (store: Record<string, any>, key: any, kind: 'set' | 'delete'): void => {
    const hook = ctx.onVarWrite
    if (!hook || key == null) return
    const path = String(key)
    if (!path) return
    try {
      hook(path, kind, store)
    } catch {
      /* observation must never fail a render */
    }
  }

  const reg = (name: string, fn: (...a: any[]) => any): void => {
    const h = vm.newFunction(name, (...handles) => {
      try {
        const args = handles.map((hh) => (hh ? vm.dump(hh) : undefined))
        return jsToHandle(vm, fn(...args))
      } catch {
        return vm.undefined
      }
    })
    vm.setProp(vm.global, name, h)
    h.dispose()
  }

  reg('getvar', (key: any, opt: any) => {
    const store = storeFor(opt)
    let v = getPath(store, key ?? null)
    // WS-1: stat_data read-fallback. A card EJS reads an MVU key either with the explicit `stat_data.`
    // prefix OR bare (assuming the hoisted view) — real cards use both forms. Resolve both consistently
    // in EVERY execution context (prompt-build, render-time, WCV) by falling back to `store.stat_data`
    // when the bare path misses. This unifies the variable surface WITHOUT copying/hoisting the live
    // store, so build-time setvar persistence (the store IS the persisted floor vars) is untouched.
    // Top-level wins on a name collision (we only fall back when the top-level path is undefined).
    if (v === undefined && key != null && !(opt && opt.scope === 'global')) {
      const sd = store && typeof store === 'object' ? store.stat_data : undefined
      if (sd && typeof sd === 'object') v = getPath(sd, key)
    }
    if (v === undefined && opt && 'defaults' in opt) v = opt.defaults
    return v
  })
  reg('setvar', (key: any, value: any, opt: any) => {
    const store = storeFor(opt)
    if (key == null) {
      if (value && typeof value === 'object') {
        for (const k of Object.keys(store)) delete store[k]
        Object.assign(store, value)
      }
    } else {
      setPath(store, key, value)
      noteWrite(store, key, 'set')
    }
    return undefined
  })
  reg('incvar', (key: any, value: any, opt: any) => {
    const store = storeFor(opt)
    const cur = Number(getPath(store, key)) || 0
    const next = cur + (value === undefined ? 1 : Number(value))
    setPath(store, key, next)
    noteWrite(store, key, 'set')
    return next
  })
  reg('decvar', (key: any, value: any, opt: any) => {
    const store = storeFor(opt)
    const cur = Number(getPath(store, key)) || 0
    const next = cur - (value === undefined ? 1 : Number(value))
    setPath(store, key, next)
    noteWrite(store, key, 'set')
    return next
  })
  reg('delvar', (key: any, opt: any) => {
    const store = storeFor(opt)
    const parts = toParts(key)
    let cur = store
    for (let i = 0; i < parts.length - 1; i++) cur = cur?.[parts[i]]
    if (cur) delete cur[parts[parts.length - 1]]
    noteWrite(store, key, 'delete')
    return undefined
  })

  // --- TH-3 data accessors (read-only) over card / world-info / history / preset. ---
  const data = ctx.data || {}
  reg('getchar', (field: any) => {
    const cd = data.charData || {}
    return field == null || field === '' ? cd : getPath(cd, String(field))
  })
  reg('getwi', (name: any) => {
    const wi = data.worldInfo || []
    if (name == null || name === '') return wi.map((e) => e.content).join('\n')
    const hit = wi.find((e) => (e.name || '').toLowerCase() === String(name).toLowerCase())
    return hit ? hit.content : ''
  })
  reg('getWorldInfoData', (name: any) => {
    const wi = data.worldInfo || []
    if (name == null || name === '') return wi
    return wi.find((e) => (e.name || '').toLowerCase() === String(name).toLowerCase()) || null
  })
  // Our worldInfo IS the keyword-matched/activated set for this build.
  reg('getWorldInfoActivatedData', () => data.worldInfo || [])
  reg('getMessageHistory', () => data.messages || [])
  reg('getCurrentChatName', () => data.chatName || '')
  // TavernHelper read shims (feeds the `TavernHelper.*` object defined in the boot prelude). Cards'
  // status-injection world-info entries read the live variable store + gate on a message id via
  // TavernHelper (e.g. 命定之诗's 艾莉亚 status core: `getVariables({type:'message'})` +
  // `getLastMessageId() > 0`). Without these the whole EJS block throws (TavernHelper undefined) and
  // renderLoreEntry strips it — so the current stat_data never reaches the prompt. READ-only + sync:
  //  · getVariables({type}) → the store for that scope (global → globals, else the chat/message store,
  //    which carries `stat_data`), a deep-copied snapshot (jsToHandle) so the card can't mutate the live
  //    store through it.
  //  · getLastMessageId() → the 0-based index of the last flat chat message (2 per turn); -1 with no
  //    history, so the card's `> 0` gate correctly suppresses the panel only on the very first message.
  reg('__thGetVariables', (opt: any) => (opt && opt.type === 'global' ? ctx.globals : ctx.vars))
  reg('__thGetLastMessageId', () => {
    const n = (data.messages || []).length
    return n > 0 ? n * 2 - 1 : -1
  })
  // getpreset(name): the CONTENT of the prompt entry named `name` (or matching it as a regex) in the
  // ACTIVE preset — matching ST-Prompt-Template. No name → the preset's name (RPT back-compat).
  reg('getPreset', (name: any) => {
    if (name == null || name === '') return data.presetName || ''
    const ps = data.presetPrompts || []
    const s = String(name)
    let re: RegExp | null = null
    try {
      re = new RegExp(s)
    } catch {
      /* not a valid regex — name/identifier equality only */
    }
    const hit = ps.find((p) => p.name === s || p.identifier === s || (re ? re.test(p.name) : false))
    return hit ? hit.content : null
  })
  reg('getqr', () => '') // quick-replies aren't modeled in RP Terminal — stubbed
  reg('matchChatMessages', (pattern: any) => {
    try {
      const re = new RegExp(String(pattern))
      return (data.messages || []).some((m) => re.test(m.user || '') || re.test(m.assistant || ''))
    } catch {
      return false
    }
  })
  reg('parseJSON', (s: any) => {
    try {
      return JSON.parse(String(s))
    } catch {
      return null // lenient: malformed → null rather than throw
    }
  })
  reg('jsonPatch', (obj: any, ops: any) => {
    try {
      patchFn(obj || {}, Array.isArray(ops) ? ops : []) // host-injected RFC-6902 (no-op if unwired)
    } catch {
      /* leave obj as-is on a bad patch */
    }
    return obj
  })
  // Backing for the `YAML` sandbox global (see boot prelude). Host-injected serializer; falls back to a
  // JSON round-trip so it never throws / never returns undefined (which would empty the entry's output).
  reg('__yamlStringify', (val: any, opts: any) => {
    try {
      return yamlStringifyFn(val, opts)
    } catch {
      try {
        return JSON.stringify(val, null, 2)
      } catch {
        return ''
      }
    }
  })
  reg('__yamlParse', (text: any) => {
    try {
      return yamlParseFn(String(text ?? ''))
    } catch {
      return {}
    }
  })

  // Read-only constants.
  const setConst = (name: string, val: any): void => {
    const h = jsToHandle(vm, val)
    vm.setProp(vm.global, name, h)
    if (h !== vm.undefined && h !== vm.null) h.dispose()
  }
  // WS-1: expose `variables` as the HOISTED view (stat_data keys lifted to the root, alongside the
  // `stat_data` key itself) so a card's direct `variables.主角` AND `variables.stat_data.主角` both
  // resolve, consistently across contexts. Read-only snapshot (jsToHandle deep-copies into the VM), so
  // this never touches the live store / build-time persistence. stat_data wins on a name collision
  // (spread last), matching the prior render/WCV hoisting.
  const sdRoot = ctx.vars && typeof ctx.vars === 'object' ? (ctx.vars as any).stat_data : undefined
  const hoistedVars = sdRoot && typeof sdRoot === 'object' ? { ...ctx.vars, ...sdRoot } : ctx.vars
  setConst('variables', hoistedVars)
  for (const [k, v] of Object.entries(ctx.constants)) setConst(k, v)

  // Scope alias helpers (getLocalVar / setGlobalVar / …).
  const boot =
    `
    function __str(x){return (x===undefined||x===null)?'':String(x);}
    // Render-phase escaper for <%= (the 'html' EscapeMode). Generation uses __str (identity), so <%= == <%-
    // in prompt text; the DOM/display path selects this so card markup can't break the rendered HTML.
    function __escapeHtml(x){return __str(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
    // ST-Prompt-Template's default include() is deliberately a no-op returning an empty template — RPT has
    // no server-side filesystem to include from, so <%- include('x') %> resolves to '' (never throws).
    function include(){return '';}
    function getLocalVar(k,o){return getvar(k,Object.assign({scope:'local'},o||{}));}
    function setLocalVar(k,v,o){return setvar(k,v,Object.assign({scope:'local'},o||{}));}
    function incLocalVar(k,v,o){return incvar(k,v,Object.assign({scope:'local'},o||{}));}
    function decLocalVar(k,v,o){return decvar(k,v,Object.assign({scope:'local'},o||{}));}
    function getGlobalVar(k,o){return getvar(k,Object.assign({scope:'global'},o||{}));}
    function setGlobalVar(k,v,o){return setvar(k,v,Object.assign({scope:'global'},o||{}));}
    function incGlobalVar(k,v,o){return incvar(k,v,Object.assign({scope:'global'},o||{}));}
    // Message- and chat-scoped variants (storeFor maps every non-global scope to the chat vars,
    // so these read/write the same store until a dedicated per-message store exists). Defining
    // them stops ReferenceErrors in cards that call getMessageVar/getChatVar/etc.
    function getMessageVar(k,o){return getvar(k,Object.assign({scope:'message'},o||{}));}
    function setMessageVar(k,v,o){return setvar(k,v,Object.assign({scope:'message'},o||{}));}
    function incMessageVar(k,v,o){return incvar(k,v,Object.assign({scope:'message'},o||{}));}
    function decMessageVar(k,v,o){return decvar(k,v,Object.assign({scope:'message'},o||{}));}
    function getChatVar(k,o){return getvar(k,Object.assign({scope:'chat'},o||{}));}
    function setChatVar(k,v,o){return setvar(k,v,Object.assign({scope:'chat'},o||{}));}
    // ST-Prompt-Template define(): register a reusable value/function for the rest of the template.
    function define(n,v){ if(n!=null) globalThis[n]=v; return v; }

    // Minimal sync TavernHelper surface for world-info EJS that gates/reads via TH (see the __th* host
    // shims above). Reads are live; write/side-effect APIs (triggerSlash runs slash commands,
    // insertOrAssignVariables mutates state) are NO-OPS here — a prompt build is a READ pass, and running
    // them would corrupt state. Defined (not omitted) so an entry that calls them keeps its EJS block
    // instead of throwing and getting stripped whole.
    globalThis.TavernHelper = {
      getVariables: function(o){ return __thGetVariables(o||{}); },
      getLastMessageId: function(){ return __thGetLastMessageId(); },
      getCurrentMessageId: function(){ return __thGetLastMessageId(); },
      triggerSlash: function(){ return undefined; },
      insertOrAssignVariables: function(){ return undefined; }
    };

    // YAML — MVU/data_schema/status world-info entries reference a \`YAML\` global (ST provides the yaml
    // lib). Backed by the host serializer (real \`yaml\` in main; JSON round-trip elsewhere). Without it,
    // e.g. the 命定之诗 status entry's \`<%= YAML.stringify(cleanData) %>\` throws → the whole entry is
    // stripped → <status_current_variables> reaches the AI empty.
    globalThis.YAML = {
      stringify: function(v, o){ return __str(__yamlStringify(v, o)); },
      parse: function(s){ return __yamlParse(s); }
    };

  ` + SANDBOX_LIB_JS // the clean-room lodash/faker/console subset (extracted — WS-4)
  const r = vm.evalCode(boot)
  if (r.error) r.error.dispose()
  else r.value.dispose()
}

/**
 * Render a template string. No `<%` → returned unchanged. On any error, the
 * tags are stripped (matching the previous strip-only behavior) so a bad
 * template can never break output. Engine toggled off (`ctx.enabled === false`)
 * or not yet initialized → also strips.
 */
/**
 * Render a template, returning both the output and any error message (null when clean). On an eval ERROR the
 * output is **empty** (NOT the tag-stripped template — stripping a `<% if %>…<% else %>…` entry would leak
 * every branch into the prompt) and the error is returned so the caller can fail loud. Engine off /
 * not-yet-initialized (non-errors) still strip tags. `evalTemplate` wraps this for the output-only path.
 * Error policy: the "engine eval error → empty + error" / "engine-off → strip" tiers — see
 * docs/rpt-api.md §7 (WS-9); callers (preset = fail-loud, lore = strip-and-keep-prose) own the fallback.
 */
export const evalTemplateDetailed = (
  template: string,
  ctx: TemplateContext
): { output: string; error: string | null } => {
  if (!template || !hasTags(template)) return { output: template, error: null }
  if (ctx.enabled === false) return { output: stripTags(template), error: null }
  if (!QJS) return { output: stripTags(template), error: null }

  const vm = QJS.newContext()
  try {
    // Deadline interrupt (see EVAL_DEADLINE_MS): a runaway template aborts instead of hanging the thread.
    const deadline = Date.now() + EVAL_DEADLINE_MS
    vm.runtime.setInterruptHandler(() => Date.now() > deadline)
    installBridge(vm, ctx)
    // ST-Prompt-Template profile: async compile (top-level `await`), `print` output fn, `<%=` identity
    // escaper for generation / HTML escaper for render. The body runs inside an ASYNC IIFE so templates
    // may `await`; a sync template simply returns an already-resolved promise. `__append`/`__escape`/`print`
    // are per-invocation (they close over THIS `__out`); `__str`/`__escapeHtml`/`include` are boot globals.
    const escapeFn = ctx.escape === 'html' ? '__escapeHtml' : '__str'
    const program =
      `(async function(){let __out="";const __append=(x)=>{__out+=__str(x);};` +
      `const __escape=${escapeFn};const print=__append;\n${compile(template)}return __out;})()`
    // Turn a dumped quickjs error into a message + the offending COMPILED line (program line N == eval.js:N),
    // so a missing helper ("not a function") or bad construct ("expecting ';'") is obvious without guessing.
    const describe = (err: any): string => {
      let msg = typeof err === 'object' ? JSON.stringify(err) : String(err)
      const lineNo =
        (err && typeof err === 'object' && Number(err.lineNumber)) ||
        Number(/eval\.js:(\d+)/.exec(err && typeof err === 'object' ? err.stack || '' : '')?.[1])
      if (lineNo) {
        const srcLine = program.split('\n')[lineNo - 1]
        if (srcLine) msg += ` | compiled L${lineNo}: ${srcLine.trim().slice(0, 200)}`
      }
      return msg
    }
    const fail = (err: any): { output: string; error: string } => {
      const msg = describe(err)
      logFn('error', 'Template error', msg)
      return { output: '', error: msg }
    }

    const res = vm.evalCode(program)
    // A SYNTAX error or a sync interrupt (a runaway `<% while(true){} %>` before the first await) surfaces
    // here as `res.error`. A RUNTIME throw inside the async body becomes a rejected promise instead (below).
    if (res.error) {
      const err = vm.dump(res.error)
      res.error.dispose()
      return fail(err)
    }
    // `res.value` is the async IIFE's promise. Drain the microtask queue synchronously so it settles — the
    // renderer loads a SYNC quickjs variant, so evalTemplateDetailed must stay a synchronous call; template
    // awaits resolve against already-available values (no real host async), so pending jobs finish here.
    const promise = res.value
    vm.runtime.executePendingJobs()
    const state = vm.getPromiseState(promise)
    if (state.type === 'fulfilled') {
      const out = vm.getString(state.value)
      state.value.dispose()
      promise.dispose()
      return { output: out, error: null }
    }
    if (state.type === 'rejected') {
      const err = vm.dump(state.error)
      state.error.dispose()
      promise.dispose()
      return fail(err)
    }
    // Still pending: a real async await never settled (or the deadline interrupt fired mid-job). Fail-safe.
    promise.dispose()
    return fail('template did not settle (unresolved async/await)')
  } catch (e: any) {
    const msg = e?.message || String(e)
    logFn('error', 'Template eval failed', msg)
    return { output: '', error: msg }
  } finally {
    vm.dispose()
  }
}

export const evalTemplate = (template: string, ctx: TemplateContext): string =>
  evalTemplateDetailed(template, ctx).output
