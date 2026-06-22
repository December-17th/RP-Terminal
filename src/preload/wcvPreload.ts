/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports --
   spike shim: it bridges the untyped ST / TavernHelper / MVU host globals into the card page, a flat bag
   of small dynamic stubs whose placeholder params (_d/_o/_a) mirror the real host-API signatures; jQuery
   is lazily require()'d on first use (importing it at preload load crashes — see below). */
import { ipcRenderer } from 'electron'
import _ from 'lodash'
import { z as zod } from 'zod'
import variant from '@jitl/quickjs-singlefile-browser-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import {
  initEngine,
  evalTemplate as ejsEval,
  evalTemplateDetailed as ejsEvalDetailed,
  setEngineDeps,
  TemplateContext
} from '../shared/templateEngine'

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
  setInput: (text: any) => ipcRenderer.send('wcv-host-set-input', text),
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

// --- TavernHelper event enum (snake_case, mirrors ST event_types) + host event delivery. The host
// computes these from the chat-store transition and pushes them here; we re-emit on the local bus so a
// card's eventOn(tavern_events.X, fn) listeners fire. ---
const tavern_events = {
  GENERATION_STARTED: 'generation_started',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SWIPED: 'message_swiped',
  CHAT_CHANGED: 'chat_changed',
  STREAM_TOKEN_RECEIVED: 'stream_token_received'
}
ipcRenderer.on('wcv-event', (_e: any, d: any) => {
  if (d && d.name) emit(d.name, d.payload)
})

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
// The ST chat array (each message carries its swipes) — built SYNC at load from the host's floors and
// kept mutable, so the home's "start game" can select a greeting swipe (chat[0].swipe_id/.mes) before
// saveChat() persists it. The env guard cards use is `!SillyTavern.chat || chat.length === 0`.
const stChat: any[] = ipcRenderer.sendSync('wcv-host-get-chat-sync') || []
const context = {
  chat: stChat,
  eventSource: { on, emit, makeFirst: on, once: on, removeListener: () => {} },
  eventTypes: tavern_events,
  event_types: tavern_events,
  // home/custom_start probe the environment: report EjsTemplate (ST-Prompt-Template) as enabled.
  extensionSettings: { EjsTemplate: { enabled: true } },
  getContext: () => context
}
w.SillyTavern = {
  chat: stChat,
  getContext: () => {
    note('SillyTavern.getContext')
    return context
  },
  substituteParams: (t: string) => {
    note('SillyTavern.substituteParams')
    return t
  },
  // The home's "start game" mutates chat[0] (swipe_id/mes) then persists + reloads the chat.
  saveChat: async () => {
    note('SillyTavern.saveChat')
    return ipcRenderer.invoke('wcv-host-save-chat', w.SillyTavern.chat)
  },
  reloadCurrentChat: async () => {
    note('SillyTavern.reloadCurrentChat')
    return ipcRenderer.invoke('wcv-host-reload-chat')
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
    if (entries.length)
      void rptHost.applyVariableOps(
        entries.map(([k, v]) => ({ op: 'add', path: '/' + k, value: v }))
      )
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
  setChatMessages: (msgs: any, ..._a: any[]) => {
    note('setChatMessages')
    return ipcRenderer.invoke('wcv-host-set-chat-messages', msgs)
  },
  deleteChatMessages: (ids: any, ..._a: any[]) => {
    note('deleteChatMessages')
    return ipcRenderer.invoke('wcv-host-delete-chat-messages', ids)
  },
  getCurrentMessageId: () => {
    note('getCurrentMessageId')
    const m = ipcRenderer.sendSync('wcv-host-get-messages-sync')
    return Array.isArray(m) ? Math.max(0, m.length - 1) : 0
  },
  // home's launcher GATES onboarding on a minimum TavernHelper version (命定之诗 wants >= 4.3.17 —
  // it warns "版本过低"/too-low below that). Report the card's required minimum so the gate passes;
  // bump if a future card demands higher (cards use their build-target API surface regardless).
  getTavernHelperVersion: () => {
    note('getTavernHelperVersion')
    return '4.3.17'
  },
  // custom_start's "embark" flow awaits this before proceeding — report "already initialized".
  waitGlobalInitialized: (..._a: any[]) => {
    note('waitGlobalInitialized')
    return Promise.resolve(true)
  },
  // Onboarding finish — default is to INJECT the starting prompt into RP Terminal's input box (the
  // player presses Send). These fire once at finish, so they log their args (always) to confirm the
  // exact shapes; auto-start (create session + message + generate) is the opt-in alternative.
  createChat: (...a: any[]) => {
    note('createChat')
    if (DEBUG) console.info('[card createChat]', JSON.stringify(a)?.slice(0, 200))
    return ''
  },
  createChatMessages: (msgs: any, _o?: any) => {
    note('createChatMessages')
    if (DEBUG) {
      try {
        console.info('[card createChatMessages]', JSON.stringify(msgs)?.slice(0, 500))
      } catch {
        /* unserializable */
      }
    }
    const arr = Array.isArray(msgs) ? msgs : [msgs]
    const last = arr[arr.length - 1]
    const text =
      (last && (last.message ?? last.content ?? last.mes)) || (typeof last === 'string' ? last : '')
    if (text) rptHost.setInput(String(text)) // inject mode: starting prompt → the input box
    return ''
  },
  triggerSlash: (cmd: any, ..._a: any[]) => {
    note('triggerSlash')
    if (DEBUG) console.info('[card triggerSlash]', cmd)
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
  generate: async (a: any) => {
    note('generate')
    const text = typeof a === 'string' ? a : (a?.user_input ?? a?.userInput ?? a?.text ?? '')
    return ipcRenderer.invoke('wcv-host-generate', String(text ?? ''))
  },
  generateRaw: async (cfg: any) => {
    note('generateRaw')
    const c = cfg && typeof cfg === 'object' ? cfg : {}
    return ipcRenderer.invoke('wcv-host-generate-raw', {
      userInput: c.user_input ?? c.userInput ?? c.prompt,
      prompt: c.prompt,
      systemPrompt: c.system_prompt ?? c.systemPrompt,
      maxChatHistory: c.max_chat_history ?? c.maxChatHistory ?? 0,
      maxTokens: c.max_tokens ?? c.maxTokens,
      overrides: c.overrides
    })
  },
  // Worldbook (lorebook) access — backed by the host's file-based lorebookService over IPC. The card
  // reads its expansions/cores from its own book and toggles them; the host applies enabled-changes back.
  // SYNC (sendSync): cards call these worldbook-NAME getters synchronously (no await) — an async Promise
  // would make `.primary` read as undefined and the card bails. The heavier entry getters below stay async.
  getCharWorldbookNames: (..._a: any[]) => {
    note('getCharWorldbookNames')
    return ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')
  },
  getWorldbookNames: (..._a: any[]) => {
    note('getWorldbookNames')
    const r = ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')
    return [r?.primary, ...(r?.additional || [])].filter(Boolean)
  },
  getWorldbook: (name: any) => {
    note('getWorldbook')
    return ipcRenderer.invoke('wcv-host-get-worldbook', name)
  },
  replaceWorldbook: (name: any, entries: any) => {
    note('replaceWorldbook')
    return ipcRenderer.invoke('wcv-host-replace-worldbook', name, entries)
  },
  updateWorldbookWith: async (name: any, updater: any) => {
    note('updateWorldbookWith')
    const entries = await ipcRenderer.invoke('wcv-host-get-worldbook', name)
    const updated = typeof updater === 'function' ? await updater(entries) : entries
    await ipcRenderer.invoke('wcv-host-replace-worldbook', name, updated)
    return updated
  },
  getCurrentCharPrimaryLorebook: () => {
    note('getCurrentCharPrimaryLorebook')
    return ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')?.primary ?? null
  },
  getCharLorebooks: (..._a: any[]) => {
    note('getCharLorebooks')
    const r = ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')
    return [r?.primary, ...(r?.additional || [])].filter(Boolean)
  },
  getLorebookEntries: (name: any) => {
    note('getLorebookEntries')
    return ipcRenderer.invoke('wcv-host-get-worldbook', name)
  },
  getLorebookSettings: () => {
    note('getLorebookSettings')
    return {}
  },
  setLorebookSettings: () => note('setLorebookSettings'),

  // --- character / preset / regex reads (Track C0) — sync getters, ctx-scoped via scriptApiService ---
  getCharData: (..._a: any[]) => {
    note('getCharData')
    return ipcRenderer.sendSync('wcv-host-get-char-data')
  },
  getCharAvatarPath: (..._a: any[]) => {
    note('getCharAvatarPath')
    return ipcRenderer.sendSync('wcv-host-get-char-avatar')
  },
  getPreset: (..._a: any[]) => {
    note('getPreset')
    return ipcRenderer.sendSync('wcv-host-get-preset')
  },
  getPresetNames: (..._a: any[]) => {
    note('getPresetNames')
    return ipcRenderer.sendSync('wcv-host-get-preset-names')
  },
  getTavernRegexes: (..._a: any[]) => {
    note('getTavernRegexes')
    return ipcRenderer.sendSync('wcv-host-get-regexes')
  },
  formatAsTavernRegexedString: (text: any, ..._a: any[]) => {
    note('formatAsTavernRegexedString')
    return ipcRenderer.sendSync('wcv-host-format-regex', text)
  },
  // replaceTavernRegexes — writing the regex store at runtime is risky (it can break the card's own
  // beautification) and rare; stubbed (logged) for now. The regex READS above are wired.
  replaceTavernRegexes: (..._a: any[]) => {
    note('replaceTavernRegexes')
    return Promise.resolve()
  },
  // Audio — cards play their own audio directly (the CSP allows media:), so these are no-op stubs that
  // keep TH-audio-API cards from crashing; native <audio>/WebAudio is the real path.
  audioImport: (..._a: any[]) => note('audioImport'),
  audioPlay: (..._a: any[]) => note('audioPlay'),
  audioPause: (..._a: any[]) => note('audioPause'),
  audioMode: (..._a: any[]) => note('audioMode'),
  audioEnable: (..._a: any[]) => note('audioEnable')
}
Object.assign(w, helpers)
// Some cards call these via a TavernHelper namespace instead of bare globals.
w.TavernHelper = helpers
// Cards reference the event enum as a bare global too: eventOn(tavern_events.MESSAGE_RECEIVED, fn).
w.tavern_events = tavern_events

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

// --- EjsTemplate API (Phase E): the ST-Prompt-Template engine running in the card's WCV context, so cards
// can call globalThis.EjsTemplate.* directly (SYNC, like the other host globals). Its own quickjs singlefile
// instance (the card CSP allows WASM); evalTemplate strips tags as a fail-safe until the WASM has loaded. ---
setEngineDeps({ log: (_l: any, m: any, d: any) => DEBUG && console.warn('[ejs]', m, d) })
void initEngine(() => newQuickJSWASMModuleFromVariant(variant))

const buildEjsCtx = (data?: any): TemplateContext => {
  const sd = data?.variables ?? statData ?? {}
  // Hoist stat_data to the root (like render-time) so variables.主角 AND variables.stat_data.主角 resolve.
  const vars = sd && typeof sd === 'object' ? { ...sd, stat_data: sd } : {}
  return {
    vars,
    globals: {},
    constants: { ...(data?.constants || {}) },
    data: data?.data || {},
    enabled: true
  }
}

w.EjsTemplate = {
  evalTemplate: (tmpl: any, data?: any) => ejsEval(String(tmpl ?? ''), buildEjsCtx(data)),
  prepareContext: (data?: any) => buildEjsCtx(data),
  getSyntaxErrorInfo: (tmpl: any, data?: any) => {
    const err = ejsEvalDetailed(String(tmpl ?? ''), buildEjsCtx(data)).error
    return err ? { message: err } : null
  },
  allVariables: () => statData,
  saveVariables: (vars: any) => {
    statData = vars || {}
    rptHost.setVariables(statData)
    return true
  },
  compileTemplate: (tmpl: any) => (data?: any) => ejsEval(String(tmpl ?? ''), buildEjsCtx(data)),
  // Thin stubs — RPT has no engine feature flags or a card-open preload phase.
  setFeatures: (..._a: any[]) => undefined,
  getFeatures: () => ({}),
  resetFeatures: () => undefined,
  refreshWorldInfo: (..._a: any[]) => undefined,
  defines: {},
  initialVariables: () => statData
}

if (DEBUG) console.info('[rpt-shim] starter shim installed (WebContentsView card panel)')
