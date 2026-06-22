// The quickjs bridge is dynamically typed (vm.dump → any, helper args are user-supplied), so `any` is
// intentional throughout this file — same as the original engine in templateService.
// Type-only import — the shared engine never pulls a runtime quickjs variant; the host injects one via
// `initEngine(loader)` (main → wasmfile variant; renderer → embedded singlefile variant).
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten'
import { toParts, getPath, setPath } from './objectPath'

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
    let v = getPath(storeFor(opt), key ?? null)
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
  setConst('variables', ctx.vars)
  for (const [k, v] of Object.entries(ctx.constants)) setConst(k, v)

  // Scope alias helpers (getLocalVar / setGlobalVar / …).
  const boot = `
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
    // Minimal clean-room faker subset for generated placeholder data (not the real lib).
    var faker = {
      number: function(a,b){ if(a==null){a=0;b=100;} if(b==null){b=a;a=0;} return Math.floor(Math.random()*(b-a+1))+a; },
      float: function(a,b){ a=a||0; b=(b==null)?1:b; return a+Math.random()*(b-a); },
      bool: function(){ return Math.random()<0.5; },
      pick: function(arr){ return (arr&&arr.length)?arr[Math.floor(Math.random()*arr.length)]:undefined; },
      uuid: function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);}); },
      name: function(){ return faker.pick(['Aria','Bjorn','Cora','Darian','Eira','Finn','Gwen','Hale','Iris','Joran']); },
      word: function(){ return faker.pick(['ember','hollow','thorn','willow','quartz','raven','mist','dawn','vale','cinder']); },
      lorem: function(n){ n=n||8; var w=[]; for(var i=0;i<n;i++) w.push(faker.word()); return w.join(' '); }
    };
    // Minimal clean-room lodash subset (dot-path only) + a no-op console — ST-PT exposes _ and console.
    function __ks(p){ return String(p==null?'':p).split('.').filter(Boolean); }
    var _ = {
      get: function(o,p,d){ var ks=__ks(p),c=o; for(var i=0;i<ks.length;i++){ if(c==null) return d; c=c[ks[i]]; } return c===undefined?d:c; },
      set: function(o,p,v){ var ks=__ks(p),c=o; for(var i=0;i<ks.length-1;i++){ if(typeof c[ks[i]]!=='object'||c[ks[i]]==null) c[ks[i]]={}; c=c[ks[i]]; } if(ks.length) c[ks[ks.length-1]]=v; return o; },
      has: function(o,p){ return _.get(o,p,undefined)!==undefined; },
      keys: function(o){ return o?Object.keys(o):[]; },
      values: function(o){ return o?Object.keys(o).map(function(k){return o[k];}):[]; },
      isEmpty: function(o){ if(o==null) return true; if(Array.isArray(o)||typeof o==='string') return o.length===0; return Object.keys(o).length===0; },
      clamp: function(n,a,b){ return Math.min(Math.max(n,a),b); },
      random: function(a,b){ if(b==null){b=a;a=0;} return a+Math.floor(Math.random()*(b-a+1)); },
      sample: function(a){ return (a&&a.length)?a[Math.floor(Math.random()*a.length)]:undefined; },
      uniq: function(a){ return Array.isArray(a)?a.filter(function(x,i){return a.indexOf(x)===i;}):[]; },
      range: function(a,b,s){ if(b==null){b=a;a=0;} s=s||1; var r=[]; for(var i=a;(s>0?i<b:i>b);i+=s) r.push(i); return r; },
      capitalize: function(s){ s=String(s==null?'':s); return s.charAt(0).toUpperCase()+s.slice(1).toLowerCase(); },
      merge: function(t){ for(var i=1;i<arguments.length;i++){ var s=arguments[i]; if(s) for(var k in s) t[k]=s[k]; } return t; },
      pick: function(o,ks){ var r={}; (ks||[]).forEach(function(k){ if(o&&k in o) r[k]=o[k]; }); return r; },
      omit: function(o,ks){ var r={}; for(var k in o){ if((ks||[]).indexOf(k)<0) r[k]=o[k]; } return r; }
    };
    var console = { log: function(){}, info: function(){}, warn: function(){}, error: function(){} };
  `
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
 * Render a template, returning both the output and any error message (null when clean). On any error the
 * output is the tag-stripped template (fail-safe). No `<%`, engine off, or not-yet-initialized → no error.
 * `evalTemplate` wraps this for the common output-only path; `getSyntaxErrorInfo` uses the error.
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
      const msg = typeof err === 'object' ? JSON.stringify(err) : String(err)
      logFn('error', 'Template error', msg)
      return { output: stripTags(template), error: msg }
    }
    const out = vm.getString(res.value)
    res.value.dispose()
    return { output: out, error: null }
  } catch (e: any) {
    const msg = e?.message || String(e)
    logFn('error', 'Template eval failed', msg)
    return { output: stripTags(template), error: msg }
  } finally {
    vm.dispose()
  }
}

export const evalTemplate = (template: string, ctx: TemplateContext): string =>
  evalTemplateDetailed(template, ctx).output
