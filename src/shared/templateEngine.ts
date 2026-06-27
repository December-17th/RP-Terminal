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
let logFn: LogFn = () => {}
let patchFn: PatchFn = () => {}

/** Wire host-specific deps. Call before `initEngine`. */
export const setEngineDeps = (deps: { log?: LogFn; applyJsonPatch?: PatchFn }): void => {
  if (deps.log) logFn = deps.log
  if (deps.applyJsonPatch) patchFn = deps.applyJsonPatch
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

export interface TemplateContext {
  vars: Record<string, any> // chat/local variables (mutated by setvar)
  globals: Record<string, any> // global variables (persisted per profile)
  constants: Record<string, unknown> // userName, charName, lastUserMessage, …
  data?: TemplateData // TH-3: card/world-info/history/preset accessors
  /** When false, the EJS engine is OFF (settings toggle) — tags are stripped, not evaluated. */
  enabled?: boolean
}

export interface TemplateContextOpts {
  globals?: Record<string, any>
  constants?: Record<string, unknown>
  data?: TemplateData
  enabled?: boolean
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
  enabled: opts.enabled ?? true
})

let QJS: QuickJSWASMModule | null = null

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

export const hasTags = (s: string): boolean => s.includes('<%')
export const stripTags = (s: string): string => s.replace(/<%[\s\S]*?%>/g, '')

// dot/bracket path get/set live in the shared objectPath module

/** Compile an EJS-style template into a JS function body that builds `__out`. */
const compile = (tmpl: string): string => {
  let body = ''
  const re = /<%([=#_-]?)([\s\S]*?)[-_]?%>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(tmpl)) !== null) {
    const lit = tmpl.slice(last, m.index)
    if (lit) body += `__out += ${JSON.stringify(lit)};\n`
    const kind = m[1]
    const code = m[2]
    if (kind === '#') {
      /* <%# comment %> — emit nothing */
    } else if (kind === '=' || kind === '-') {
      body += `__out += __str(${code});\n`
    } else {
      body += `${code}\n`
    }
    last = m.index + m[0].length
  }
  const tail = tmpl.slice(last)
  if (tail) body += `__out += ${JSON.stringify(tail)};\n`
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
    } else setPath(store, key, value)
    return undefined
  })
  reg('incvar', (key: any, value: any, opt: any) => {
    const store = storeFor(opt)
    const cur = Number(getPath(store, key)) || 0
    const next = cur + (value === undefined ? 1 : Number(value))
    setPath(store, key, next)
    return next
  })
  reg('decvar', (key: any, value: any, opt: any) => {
    const store = storeFor(opt)
    const cur = Number(getPath(store, key)) || 0
    const next = cur - (value === undefined ? 1 : Number(value))
    setPath(store, key, next)
    return next
  })
  reg('delvar', (key: any, opt: any) => {
    const store = storeFor(opt)
    const parts = toParts(key)
    let cur = store
    for (let i = 0; i < parts.length - 1; i++) cur = cur?.[parts[i]]
    if (cur) delete cur[parts[parts.length - 1]]
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
    installBridge(vm, ctx)
    const program = `(function(){let __out="";\n${compile(template)}return __out;})()`
    const res = vm.evalCode(program)
    if (res.error) {
      const err = vm.dump(res.error)
      res.error.dispose()
      let msg = typeof err === 'object' ? JSON.stringify(err) : String(err)
      // Pinpoint the offending COMPILED line (program line N == eval.js:N) so a missing helper
      // ("not a function") or bad construct ("expecting ';'") is obvious without guessing. The error
      // carries `lineNumber` (SyntaxError) and/or a stack frame "eval.js:N:col" (runtime).
      const lineNo =
        (err && typeof err === 'object' && Number(err.lineNumber)) ||
        Number(/eval\.js:(\d+)/.exec(err && typeof err === 'object' ? err.stack || '' : '')?.[1])
      if (lineNo) {
        const srcLine = program.split('\n')[lineNo - 1]
        if (srcLine) msg += ` | compiled L${lineNo}: ${srcLine.trim().slice(0, 200)}`
      }
      logFn('error', 'Template error', msg)
      return { output: '', error: msg }
    }
    const out = vm.getString(res.value)
    res.value.dispose()
    return { output: out, error: null }
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
