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
  const sdRoot =
    ctx.vars && typeof ctx.vars === 'object' ? (ctx.vars as any).stat_data : undefined
  const hoistedVars =
    sdRoot && typeof sdRoot === 'object' ? { ...ctx.vars, ...sdRoot } : ctx.vars
  setConst('variables', hoistedVars)
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
    // Clean-room lodash subset (dot-path get/set + the common collection/object/lang helpers a card's
    // status panel uses) + a no-op console — ST-PT exposes _ and console. Reimplemented from the public
    // lodash API contract; no lodash source is copied. cloneDeep is JSON-based (stat_data is plain JSON,
    // so this is faithful + loses nothing that matters). Key args accept a string OR array (lodash does).
    function __ks(p){ return String(p==null?'':p).split('.').filter(Boolean); }
    function __arr(k){ return Array.isArray(k)?k:(k==null?[]:[k]); }
    function __it(fn){ if(fn==null) return function(x){return x;}; return typeof fn==='function'?fn:function(x){return x==null?undefined:x[fn];}; }
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
      upperFirst: function(s){ s=String(s==null?'':s); return s.charAt(0).toUpperCase()+s.slice(1); },
      merge: function(t){ for(var i=1;i<arguments.length;i++){ var s=arguments[i]; if(s) for(var k in s) t[k]=s[k]; } return t; },
      pick: function(o,ks){ var r={}; __arr(ks).forEach(function(k){ if(o&&k in o) r[k]=o[k]; }); return r; },
      omit: function(o,ks){ var ex=__arr(ks),r={}; for(var k in o){ if(ex.indexOf(k)<0) r[k]=o[k]; } return r; },
      cloneDeep: function(o){ if(o==null||typeof o!=='object') return o; try { return JSON.parse(JSON.stringify(o)); } catch(e){ return o; } },
      clone: function(o){ if(o==null||typeof o!=='object') return o; return Array.isArray(o)?o.slice():Object.assign({},o); },
      defaults: function(t){ t=t||{}; for(var i=1;i<arguments.length;i++){ var s=arguments[i]; if(s) for(var k in s){ if(t[k]===undefined) t[k]=s[k]; } } return t; },
      defaultTo: function(v,d){ return (v==null||(typeof v==='number'&&isNaN(v)))?d:v; },
      isEqual: function(a,b){ try { return JSON.stringify(a)===JSON.stringify(b); } catch(e){ return a===b; } },
      isNil: function(v){ return v==null; },
      isArray: Array.isArray,
      isObject: function(v){ return v!=null && typeof v==='object'; },
      isPlainObject: function(v){ return v!=null && typeof v==='object' && !Array.isArray(v); },
      isString: function(v){ return typeof v==='string'; },
      isNumber: function(v){ return typeof v==='number' && !isNaN(v); },
      isFunction: function(v){ return typeof v==='function'; },
      size: function(o){ if(o==null) return 0; if(Array.isArray(o)||typeof o==='string') return o.length; return Object.keys(o).length; },
      forEach: function(c,fn){ if(Array.isArray(c)){ for(var i=0;i<c.length;i++) fn(c[i],i,c); } else if(c){ for(var k in c) fn(c[k],k,c); } return c; },
      map: function(c,fn){ var g=__it(fn),r=[]; if(Array.isArray(c)){ for(var i=0;i<c.length;i++) r.push(g(c[i],i,c)); } else if(c){ for(var k in c) r.push(g(c[k],k,c)); } return r; },
      filter: function(c,fn){ var g=__it(fn),r=[]; if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(g(c[i],i,c)) r.push(c[i]); } else if(c){ for(var k in c) if(g(c[k],k,c)) r.push(c[k]); } return r; },
      find: function(c,fn){ var g=__it(fn); if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(g(c[i],i,c)) return c[i]; } else if(c){ for(var k in c) if(g(c[k],k,c)) return c[k]; } return undefined; },
      some: function(c,fn){ var g=__it(fn); if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(g(c[i],i,c)) return true; } return false; },
      every: function(c,fn){ var g=__it(fn); if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(!g(c[i],i,c)) return false; } return true; },
      reduce: function(c,fn,acc){ if(Array.isArray(c)){ for(var i=0;i<c.length;i++) acc=fn(acc,c[i],i,c); } else if(c){ for(var k in c) acc=fn(acc,c[k],k,c); } return acc; },
      includes: function(c,v){ if(Array.isArray(c)||typeof c==='string') return c.indexOf(v)>=0; if(c){ for(var k in c){ if(c[k]===v) return true; } } return false; },
      first: function(a){ return Array.isArray(a)&&a.length?a[0]:undefined; },
      head: function(a){ return Array.isArray(a)&&a.length?a[0]:undefined; },
      last: function(a){ return Array.isArray(a)&&a.length?a[a.length-1]:undefined; },
      compact: function(a){ return Array.isArray(a)?a.filter(function(x){return !!x;}):[]; },
      flatten: function(a){ return Array.isArray(a)?a.reduce(function(r,x){ return r.concat(x); },[]):[]; },
      toPairs: function(o){ return o?Object.keys(o).map(function(k){return [k,o[k]];}):[]; },
      fromPairs: function(p){ var r={}; (p||[]).forEach(function(kv){ if(kv) r[kv[0]]=kv[1]; }); return r; },
      entries: function(o){ return o?Object.keys(o).map(function(k){return [k,o[k]];}):[]; },
      mapValues: function(o,fn){ var g=__it(fn),r={}; if(o) for(var k in o) r[k]=g(o[k],k,o); return r; },
      groupBy: function(c,fn){ var g=__it(fn),r={}; (Array.isArray(c)?c:[]).forEach(function(x){ var key=g(x); (r[key]=r[key]||[]).push(x); }); return r; },
      keyBy: function(c,fn){ var g=__it(fn),r={}; (Array.isArray(c)?c:[]).forEach(function(x){ r[g(x)]=x; }); return r; },
      sortBy: function(c,fn){ var g=__it(fn); return (Array.isArray(c)?c.slice():[]).sort(function(a,b){ var av=g(a),bv=g(b); return av<bv?-1:av>bv?1:0; }); },
      sum: function(a){ return (Array.isArray(a)?a:[]).reduce(function(s,x){ return s+(Number(x)||0); },0); },
      sumBy: function(c,fn){ var g=__it(fn); return (Array.isArray(c)?c:[]).reduce(function(s,x){ return s+(Number(g(x))||0); },0); },
      maxBy: function(c,fn){ var g=__it(fn),best,bv=-Infinity; (Array.isArray(c)?c:[]).forEach(function(x){ var v=Number(g(x)); if(v>bv){bv=v;best=x;} }); return best; },
      minBy: function(c,fn){ var g=__it(fn),best,bv=Infinity; (Array.isArray(c)?c:[]).forEach(function(x){ var v=Number(g(x)); if(v<bv){bv=v;best=x;} }); return best; },
      round: function(n,p){ p=p||0; var f=Math.pow(10,p); return Math.round((Number(n)||0)*f)/f; },
      padStart: function(s,len,ch){ s=String(s==null?'':s); ch=ch||' '; while(s.length<len) s=ch+s; return s.slice(s.length-Math.max(len,s.length)); }
    };
    // Aliases + a second batch of common methods (added as properties so they can reference the above).
    _.each = _.forEach; _.forOwn = _.forEach; _.collect = _.map; _.detect = _.find;
    _.orderBy = _.sortBy; // single-key ascending approximation of lodash orderBy
    _.reject = function(c,fn){ var g=__it(fn); return _.filter(c,function(x,i,cc){ return !g(x,i,cc); }); };
    _.findKey = function(o,fn){ var g=__it(fn); for(var k in o){ if(g(o[k],k,o)) return k; } return undefined; };
    _.mapKeys = function(o,fn){ var g=__it(fn),r={}; for(var k in o) r[g(o[k],k,o)]=o[k]; return r; };
    _.countBy = function(c,fn){ var g=__it(fn),r={}; (Array.isArray(c)?c:[]).forEach(function(x){ var key=g(x); r[key]=(r[key]||0)+1; }); return r; };
    _.flatMap = function(c,fn){ var g=__it(fn); return _.flatten(_.map(c,g)); };
    _.times = function(n,fn){ n=Number(n)||0; var r=[]; for(var i=0;i<n;i++) r.push(fn?fn(i):i); return r; };
    _.max = function(a){ return (Array.isArray(a)&&a.length)?a.reduce(function(m,x){return x>m?x:m;}):undefined; };
    _.min = function(a){ return (Array.isArray(a)&&a.length)?a.reduce(function(m,x){return x<m?x:m;}):undefined; };
    _.mean = function(a){ a=Array.isArray(a)?a:[]; return a.length?_.sum(a)/a.length:0; };
    _.meanBy = function(c,fn){ c=Array.isArray(c)?c:[]; return c.length?_.sumBy(c,fn)/c.length:0; };
    _.toNumber = function(v){ var n=Number(v); return isNaN(n)?0:n; };
    _.toString = function(v){ return v==null?'':String(v); };
    _.trim = function(s){ return String(s==null?'':s).trim(); };
    _.startsWith = function(s,t){ return String(s==null?'':s).indexOf(t)===0; };
    _.endsWith = function(s,t){ s=String(s==null?'':s); t=String(t); return t===''?true:s.indexOf(t,s.length-t.length)!==-1; };
    _.repeat = function(s,n){ s=String(s==null?'':s); n=Number(n)||0; var r=''; for(var i=0;i<n;i++) r+=s; return r; };
    _.isUndefined = function(v){ return v===undefined; };
    _.isNull = function(v){ return v===null; };
    _.isBoolean = function(v){ return typeof v==='boolean'; };
    _.isInteger = function(v){ return typeof v==='number' && isFinite(v) && Math.floor(v)===v; };
    _.noop = function(){};
    _.identity = function(v){ return v; };
    _.take = function(a,n){ return Array.isArray(a)?a.slice(0,n==null?1:n):[]; };
    _.takeRight = function(a,n){ n=n==null?1:n; return Array.isArray(a)?a.slice(Math.max(a.length-n,0)):[]; };
    _.drop = function(a,n){ return Array.isArray(a)?a.slice(n==null?1:n):[]; };
    _.chunk = function(a,n){ n=Math.max(Number(n)||1,1); var r=[]; a=Array.isArray(a)?a:[]; for(var i=0;i<a.length;i+=n) r.push(a.slice(i,i+n)); return r; };
    _.findIndex = function(a,fn){ var g=__it(fn); a=Array.isArray(a)?a:[]; for(var i=0;i<a.length;i++) if(g(a[i],i,a)) return i; return -1; };
    _.nth = function(a,i){ if(!Array.isArray(a)) return undefined; i=Number(i)||0; return i<0?a[a.length+i]:a[i]; };
    _.invert = function(o){ var r={}; for(var k in o) r[o[k]]=k; return r; };
    _.uniqBy = function(c,fn){ var g=__it(fn),seen={},r=[]; (Array.isArray(c)?c:[]).forEach(function(x){ var k=g(x); if(!seen[k]){seen[k]=1;r.push(x);} }); return r; };
    _.concat = function(){ var r=[]; for(var i=0;i<arguments.length;i++){ var a=arguments[i]; if(Array.isArray(a)) r=r.concat(a); else r.push(a); } return r; };
    _.difference = function(a){ var ex=Array.prototype.slice.call(arguments,1).reduce(function(s,x){return s.concat(x);},[]); return (Array.isArray(a)?a:[]).filter(function(x){return ex.indexOf(x)<0;}); };
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
