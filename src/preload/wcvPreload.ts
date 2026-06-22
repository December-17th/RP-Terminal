/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars --
   spike shim: it bridges the untyped ST / TavernHelper / MVU host globals into the card page, a flat bag
   of small dynamic stubs whose placeholder params (_d/_o/_a) mirror the real host-API signatures. */
import { ipcRenderer } from 'electron'

/**
 * STARTER SHIM (spike) for a card's own frontend running in a WebContentsView — e.g. 命定之诗's React
 * status UI, which reads `window.Mvu.getMvuData()` and the bare TavernHelper globals. Runs in the
 * page's MAIN world (contextIsolation:false) so it can DEFINE those globals; every host call is
 * wrapped in a LOGGER so the first load prints exactly what the card reaches for. Reads come from a
 * synchronous `stat_data` mirror (MVU getters are sync; our IPC is async, so we hydrate + push);
 * writes go through the host bridge (`apply-variable-ops`). The heavy MVU update-pipeline deps
 * (lorebook/generate/getChatMessages) are stubs — we do that natively (`mvuParser`).
 *
 * Trusted-card only: a main-world shim + a remote page sharing the bridge. The WCV is still a
 * separate process with nodeIntegration:false (no host/Node reach); production vendors assets +
 * hardens (contextBridge / CSP).
 */
const w = window as any

// --- host bridge (IPC) ---
const rptHost = {
  getVariables: (): Promise<any> => ipcRenderer.invoke('wcv-host-get-vars'),
  applyVariableOps: (ops: any[]): Promise<any> => ipcRenderer.invoke('wcv-host-apply-vars', ops),
  onVarsChanged: (cb: (v: any) => void) => {
    const l = (_e: any, v: any): void => cb(v)
    ipcRenderer.on('wcv-vars-changed', l)
    return () => ipcRenderer.removeListener('wcv-vars-changed', l)
  }
}
w.rptHost = rptHost

// --- missing-API logger: print each unique host call once ---
const seen = new Set<string>()
const note = (name: string) => {
  if (!seen.has(name)) {
    seen.add(name)
    console.warn('[rpt-shim] card called:', name)
  }
}

// --- event bus (eventOn / eventEmit) ---
const bus: Record<string, Array<(...a: any[]) => void>> = {}
const on = (name: string, cb: (...a: any[]) => void) => {
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
  emit('mag_variable_initialized', statData)
  emit('mag_variable_updated', statData)
}
rptHost.getVariables().then(hydrate)
rptHost.onVarsChanged(hydrate)

const getByPath = (root: any, path: string) =>
  String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), root)
const toPointer = (path: string) => '/' + String(path).replace(/\./g, '/')

// --- window.Mvu (thin: display reads from the mirror, writes through the bridge) ---
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
    void rptHost.applyVariableOps([{ op: 'add', path: toPointer(path), value }])
    return value
  },
  replaceMvuData: (_d: any, _o?: any) => note('Mvu.replaceMvuData'),
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
  getContext: () => context
}
w.SillyTavern = {
  getContext: () => {
    note('SillyTavern.getContext')
    return context
  }
}

// --- bare TavernHelper globals (wired where we can; logged stubs otherwise) ---
const helpers: Record<string, any> = {
  getVariables: async (_o?: any) => {
    note('getVariables')
    return statData
  },
  replaceVariables: (..._a: any[]) => note('replaceVariables'),
  insertOrAssignVariables: (vars: any, _o?: any) => {
    note('insertOrAssignVariables')
    const ops = Object.entries(vars || {}).map(([k, v]) => ({ op: 'add', path: '/' + k, value: v }))
    if (ops.length) void rptHost.applyVariableOps(ops)
  },
  updateVariablesWith: (..._a: any[]) => note('updateVariablesWith'),
  getChatMessages: (..._a: any[]) => {
    note('getChatMessages')
    return []
  },
  setChatMessages: (..._a: any[]) => note('setChatMessages'),
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

console.info('[rpt-shim] starter shim installed (WebContentsView card panel)')
