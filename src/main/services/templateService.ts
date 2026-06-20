import path from 'path'
import { getQuickJS, QuickJSContext, QuickJSWASMModule } from 'quickjs-emscripten'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { log } from './logService'

/**
 * ST-Prompt-Template compatible engine. Card/preset templates are EJS-style
 * (`<% %>`, `<%- %>`, `<%= %>`) and compile to JavaScript, so they run inside a
 * quickjs WASM sandbox — fully isolated from Node/the filesystem. Helper
 * functions (getvar/setvar/…) bridge back to the chat's variables. Any failure
 * falls back to stripping the tags so generation never breaks.
 */

let QJS: QuickJSWASMModule | null = null

export const initTemplates = async (): Promise<void> => {
  if (QJS) return
  try {
    QJS = await getQuickJS()
  } catch (e: any) {
    log('error', 'Template engine failed to initialize', e?.message || String(e))
  }
}

export interface TemplateContext {
  vars: Record<string, any> // chat/local variables (mutated by setvar)
  globals: Record<string, any> // global variables (persisted per profile)
  constants: Record<string, unknown> // userName, charName, lastUserMessage, …
}

const hasTags = (s: string): boolean => s.includes('<%')
const stripTags = (s: string): string => s.replace(/<%[\s\S]*?%>/g, '')

// --- dot/bracket path get/set on the host side (lodash-ish, minimal) ---
const toParts = (p: string): string[] =>
  String(p)
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)

const getPath = (obj: any, p: string | null): any => {
  if (p == null) return obj
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

/** Compile an EJS-style template into a JS function body that builds `__out`. */
const compile = (tmpl: string): string => {
  let body = ''
  const re = /<%([=_-]?)([\s\S]*?)[-_]?%>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(tmpl)) !== null) {
    const lit = tmpl.slice(last, m.index)
    if (lit) body += `__out += ${JSON.stringify(lit)};\n`
    const kind = m[1]
    const code = m[2]
    if (kind === '=' || kind === '-') body += `__out += __str(${code});\n`
    else body += `${code}\n`
    last = m.index + m[0].length
  }
  const tail = tmpl.slice(last)
  if (tail) body += `__out += ${JSON.stringify(tail)};\n`
  return body
}

const jsToHandle = (vm: QuickJSContext, val: any) => {
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
  `
  const r = vm.evalCode(boot)
  if (r.error) r.error.dispose()
  else r.value.dispose()
}

/**
 * Render a template string. No `<%` → returned unchanged. On any error, the
 * tags are stripped (matching the previous strip-only behavior) so a bad
 * template can never break generation.
 */
export const evalTemplate = (template: string, ctx: TemplateContext): string => {
  if (!template || !hasTags(template)) return template
  if (!QJS) return stripTags(template)

  const vm = QJS.newContext()
  try {
    installBridge(vm, ctx)
    const program = `(function(){let __out="";\n${compile(template)}return __out;})()`
    const res = vm.evalCode(program)
    if (res.error) {
      const err = vm.dump(res.error)
      res.error.dispose()
      log('error', 'Template error', typeof err === 'object' ? JSON.stringify(err) : String(err))
      return stripTags(template)
    }
    const out = vm.getString(res.value)
    res.value.dispose()
    return out
  } catch (e: any) {
    log('error', 'Template eval failed', e?.message || String(e))
    return stripTags(template)
  } finally {
    vm.dispose()
  }
}

// --- per-profile global variable persistence (JSON file) ---
const globalsPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'template-globals.json')

export const loadGlobals = (profileId: string): Record<string, any> =>
  readJsonSync<Record<string, any>>(globalsPath(profileId)) || {}

export const saveGlobals = (profileId: string, globals: Record<string, any>): void => {
  try {
    writeJsonSyncAtomic(globalsPath(profileId), globals)
  } catch {
    /* non-fatal */
  }
}
