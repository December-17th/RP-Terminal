/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars, @typescript-eslint/no-require-imports --
   spike shim: it bridges the untyped ST / TavernHelper / MVU host globals into the card page, a flat bag
   of small dynamic stubs whose placeholder params (_d/_o/_a) mirror the real host-API signatures; jQuery
   is lazily require()'d on first use (importing it at preload load crashes — see below). */
import { ipcRenderer } from 'electron'
import _ from 'lodash'
import { z as zod } from 'zod'

/**
 * SHIM for a card's own frontend running in a WebContentsView — e.g. 命定之诗's React status UI, which
 * reads `window.Mvu.getMvuData()` + the bare TavernHelper globals. Runs in the page's MAIN world
 * (contextIsolation:false) so it can DEFINE those globals. READS come from a synchronous `stat_data`
 * mirror (MVU getters are sync; our IPC is async, so we hydrate via sendSync + keep fresh by push).
 * WRITES go through the host bridge (apply-variable-ops / set-vars), updating the mirror optimistically
 * so the card sees its own edit instantly. Heavy MVU update-pipeline deps (lorebook/generate) are
 * stubs — we do that natively (mvuParser).
 *
 * Trusted-card only: a main-world shim + a remote page sharing the bridge. The WCV is still a separate
 * process with nodeIntegration:false (no host/Node reach); production vendors assets + hardens.
 *
 * Diagnostics are OFF by default; add `#rptdebug` to the panel URL to log every host call + subscription.
 */
const w = window as any
const DEBUG = typeof location !== 'undefined' && /rptdebug/i.test(location.hash + location.search)

// --- host bridge (IPC) ---
const rptHost = {
  getVariables: (): Promise<any> => ipcRenderer.invoke('wcv-host-get-vars'),
  applyVariableOps: (ops: any[]): Promise<any> => ipcRenderer.invoke('wcv-host-apply-vars', ops),
  setVariables: (sd: any): Promise<any> => ipcRenderer.invoke('wcv-host-set-vars', sd),
  onVarsChanged: (cb: (v: any) => void) => {
    const l = (_e: any, v: any): void => cb(v)
    ipcRenderer.on('wcv-vars-changed', l)
    return () => ipcRenderer.removeListener('wcv-vars-changed', l)
  }
}
w.rptHost = rptHost

// --- missing-API logger: print each unique host call once (DEBUG only) ---
const seen = new Set<string>()
const note = (name: string) => {
  if (!DEBUG || seen.has(name)) return
  seen.add(name)
  console.warn('[rpt-shim] card called:', name)
}

// --- event bus (eventOn / eventEmit) ---
const bus: Record<string, Array<(...a: any[]) => void>> = {}
const on = (name: string, cb: (...a: any[]) => void) => {
  if (DEBUG) console.info('[rpt-shim] subscribe:', name)
  ;(bus[name] ||= []).push(cb)
}
const emit = (name: string, ...args: any[]) => {
  for (const f of bus[name] || []) {
    try {
      f(...args)
    } catch {
      /* a card handler threw — keep going */
    }
  }
}

// --- synchronous stat_data mirror (hydrated async, kept fresh by push) ---
let statData: any = {}
const hydrate = (v: any) => {
  statData = v || {}
  // Fire the full MVU update cycle (names match Mvu.events) so whichever event the card listens to fires.
  emit('mag_variable_update_started', statData)
  emit('mag_variable_updated', statData)
  emit('mag_variable_update_ended', statData)
}
// Sync initial read so the mirror is populated BEFORE the card's first render (an async IPC read would
// land after the React app has already rendered defaults). sendSync blocks briefly — fine once.
try {
  statData = ipcRenderer.sendSync('wcv-host-get-vars-sync') || {}
} catch {
  statData = {}
}
rptHost.onVarsChanged(hydrate)

const getByPath = (root: any, path: string) =>
  String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), root)
const setByPath = (root: any, path: string, value: any) => {
  const parts = String(path).split('.')
  let o = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
    o = o[parts[i]]
  }
  o[parts[parts.length - 1]] = value
}
const toPointer = (path: string) => '/' + String(path).replace(/\./g, '/')

// --- window.Mvu (display reads from the mirror; writes persist via the bridge + update the mirror) ---
w.Mvu = {
  getMvuData: (_o?: any) => {
    note('Mvu.getMvuData')
    return { stat_data: statData, schema: {} }
  },
  getMvuVariable: (_d: any, path: string, o?: any) => {
    note('Mvu.getMvuVariable')
    const v = getByPath(statData, path)
    return v === undefined ? o?.default_value : v
  },
  setMvuVariable: (_d: any, path: string, value: any, _o?: any) => {
    note('Mvu.setMvuVariable')
    setByPath(statData, path, value) // optimistic — card sees its own write instantly
    void rptHost.applyVariableOps([{ op: 'add', path: toPointer(path), value }])
    return value
  },
  replaceMvuData: (d: any, _o?: any) => {
    note('Mvu.replaceMvuData')
    statData = (d && d.stat_data) || d || {}
    void rptHost.setVariables(statData)
  },
  parseMessage: (..._a: any[]) => note('Mvu.parseMessage'),
  reloadInitVar: (..._a: any[]) => note('Mvu.reloadInitVar'),
  events: {
    VARIABLE_INITIALIZED: 'mag_variable_initialized',
    VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
    VARIABLE_UPDATED: 'mag_variable_updated'
  }
}

// --- SillyTavern.getContext() (minimal; the card may probe more fields → logged) ---
const context = {
  chat: [] as any[],
  eventSource: { on, emit, makeFirst: on, once: on, removeListener: () => {} },
  eventTypes: {},
  // home/custom_start probe the environment: report EjsTemplate (ST-Prompt-Template) as enabled.
  extensionSettings: { EjsTemplate: { enabled: true } },
  getContext: () => context
}
w.SillyTavern = {
  getContext: () => {
    note('SillyTavern.getContext')
    return context
  },
  substituteParams: (t: string) => {
    note('SillyTavern.substituteParams')
    return t
  }
}

// --- bare TavernHelper globals (wired where we can; logged stubs otherwise) ---
const helpers: Record<string, any> = {
  getVariables: (_o?: any) => {
    note('getVariables')
    // TavernHelper returns the scope's variable object, which for MVU wraps stat_data.
    return { stat_data: statData }
  },
  replaceVariables: (vars: any, _o?: any) => {
    note('replaceVariables')
    statData = (vars && vars.stat_data) || vars || {}
    void rptHost.setVariables(statData)
  },
  insertOrAssignVariables: (vars: any, _o?: any) => {
    note('insertOrAssignVariables')
    const entries = Object.entries(vars || {})
    for (const [k, v] of entries) statData[k] = v // optimistic
    if (entries.length) void rptHost.applyVariableOps(entries.map(([k, v]) => ({ op: 'add', path: '/' + k, value: v })))
  },
  updateVariablesWith: (..._a: any[]) => note('updateVariablesWith'),
  getChatMessages: (..._a: any[]) => {
    note('getChatMessages')
    try {
      return ipcRenderer.sendSync('wcv-host-get-messages-sync') || []
    } catch {
      return []
    }
  },
  setChatMessages: (..._a: any[]) => note('setChatMessages'),
  getCurrentMessageId: () => {
    note('getCurrentMessageId')
    return 0
  },
  // home's launcher checks the TavernHelper version is present.
  getTavernHelperVersion: () => {
    note('getTavernHelperVersion')
    return '3.0.0'
  },
  // custom_start starts the game after creation. Stubbed for now — wire to our session system later.
  createChat: (..._a: any[]) => {
    note('createChat')
    return ''
  },
  triggerSlash: (..._a: any[]) => {
    note('triggerSlash')
    return ''
  },
  eventOn: (n: string, cb: any) => {
    note('eventOn')
    on(n, cb)
  },
  eventMakeFirst: (n: string, cb: any) => {
    note('eventMakeFirst')
    on(n, cb)
  },
  eventOnce: (n: string, cb: any) => {
    note('eventOnce')
    on(n, cb)
  },
  eventEmit: (n: string, ...a: any[]) => {
    note('eventEmit')
    emit(n, ...a)
  },
  eventRemoveListener: (..._a: any[]) => note('eventRemoveListener'),
  substitudeMacros: (t: string) => {
    note('substitudeMacros')
    return t
  },
  generate: async (..._a: any[]) => {
    note('generate')
    return ''
  },
  generateRaw: async (..._a: any[]) => {
    note('generateRaw')
    return ''
  },
  getCurrentCharPrimaryLorebook: () => {
    note('getCurrentCharPrimaryLorebook')
    return null
  },
  getCharLorebooks: () => {
    note('getCharLorebooks')
    return []
  },
  getLorebookEntries: () => {
    note('getLorebookEntries')
    return []
  },
  getLorebookSettings: () => {
    note('getLorebookSettings')
    return {}
  },
  setLorebookSettings: () => note('setLorebookSettings')
}
Object.assign(w, helpers)
// Some cards call these via a TavernHelper namespace instead of bare globals.
w.TavernHelper = helpers

// --- libraries the card bundle externalizes as bare globals (lodash `_`, Zod `z`, jQuery `$`, `toastr`) ---
w._ = _
w.z = zod
// jQuery: required LAZILY on first access. Requiring at preload load crashes — jQuery probes
// document.documentElement at import time, which is null before the page parses (and that failure takes
// the whole preload down). The card only touches `$` once its deferred module runs, by which point the
// DOM is ready, so a getter that requires on first access is safe.
let jqCache: any = null
const getJq = (): any => {
  if (!jqCache) {
    const m: any = require('jquery')
    jqCache = m && m.fn ? m : typeof m === 'function' ? m(w) : m
  }
  return jqCache
}
Object.defineProperty(w, '$', { configurable: true, get: getJq })
Object.defineProperty(w, 'jQuery', { configurable: true, get: getJq })
// Vue ecosystem: home/custom_start expect these as window globals. Lazy-required (defensive, like
// jQuery — only resolved when the card's deferred bundle first touches them).
const lazyGlobal = (name: string, mod: string) => {
  let cache: any = null
  Object.defineProperty(w, name, { configurable: true, get: () => (cache ||= require(mod)) })
}
lazyGlobal('Vue', 'vue')
lazyGlobal('VueRouter', 'vue-router')
lazyGlobal('Pinia', 'pinia')
const toast = (level: string) => (msg?: any) => {
  note('toastr.' + level)
  if (DEBUG) console.info('[card toastr.' + level + ']', msg)
}
w.toastr = {
  success: toast('success'),
  error: toast('error'),
  info: toast('info'),
  warning: toast('warning'),
  clear: () => {},
  remove: () => {},
  options: {}
}

if (DEBUG) console.info('[rpt-shim] starter shim installed (WebContentsView card panel)')
