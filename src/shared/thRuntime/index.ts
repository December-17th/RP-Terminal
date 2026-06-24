// src/shared/thRuntime/index.ts
import type { Host, ThGlobals } from './types'
import { floorsToThMessages, floorsToStChat, currentMessageId } from './shapes'
import { setVarOps, assignVarOps, replaceStatDataOps, type VarOp } from './ops'
import { expandMacros } from '../macros'
import { runScript, type StCtx } from '../stscript'

const TAVERN_EVENTS = {
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
const MVU_EVENTS = {
  VARIABLE_INITIALIZED: 'mag_variable_initialized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  VARIABLE_UPDATED: 'mag_variable_updated'
}

const getByPath = (root: any, path: string): any =>
  String(path)
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), root)

const clone = (v: any): any => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

export function createThRuntime(host: Host): ThGlobals {
  // --- event bus ---
  const map: Record<string, Array<(...a: any[]) => void>> = {}
  const on = (n: string, cb: (...a: any[]) => void): void => {
    ;(map[n] ||= []).push(cb)
  }
  const off = (n: string, cb: (...a: any[]) => void): void => {
    map[n] = (map[n] || []).filter((f) => f !== cb)
  }
  const emit = (n: string, ...a: any[]): void => {
    for (const cb of map[n] || []) {
      try {
        cb(...a)
      } catch (e) {
        console.error('[th event]', n, e)
      }
    }
  }

  // --- statData cache (authoritative refresh via host.onVarsChanged; optimistic on write) ---
  let stat: any = host.statData() || {}
  const offVars = host.onVarsChanged((sd) => {
    stat = sd || {}
    emit(MVU_EVENTS.VARIABLE_UPDATE_STARTED, stat)
    emit(MVU_EVENTS.VARIABLE_UPDATED, stat)
    emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, stat)
    emit(TAVERN_EVENTS.MESSAGE_UPDATED)
  })
  const offHost = host.onHostEvent((name, payload) => emit(name, payload))

  const writeVars = (ops: VarOp[]): Promise<void> =>
    ops.length ? host.applyVariableOps(ops) : Promise.resolve()

  // Expand {{macros}} (substituteParams / substitudeMacros) over the card's live context: char/user/persona
  // names + the cached stat_data as chat vars. Pure (shared/macros); leaves <% %> EJS alone.
  const substMacros = (t: any): any =>
    typeof t === 'string'
      ? expandMacros(t, {
          char: host.charData()?.name,
          user: host.personaName(),
          persona: host.personaName(),
          vars: stat
        })
      : t

  const errorCatched =
    (fn: any) =>
    (...args: any[]): any => {
      try {
        const r = typeof fn === 'function' ? fn(...args) : undefined
        if (r && typeof r.then === 'function')
          return r.catch((e: any) => console.error('[card]', e))
        return r
      } catch (e) {
        console.error('[card]', e)
        return undefined
      }
    }

  const normRaw = (c: any): any => ({
    userInput: c?.user_input ?? c?.userInput ?? c?.prompt,
    prompt: c?.prompt,
    systemPrompt: c?.system_prompt ?? c?.systemPrompt,
    maxChatHistory: c?.max_chat_history ?? c?.maxChatHistory ?? 0,
    maxTokens: c?.max_tokens ?? c?.maxTokens,
    overrides: c?.overrides
  })

  // STScript / triggerSlash — run the common slash-command subset over the Host. The interpreter lives in
  // shared/stscript; here we build its StCtx from the Host so it reaches parity by construction (both
  // adapters already implement every method it touches). Local/chat vars = the cached stat_data (read +
  // optimistic in-place write, persisted via setVarOps/writeVars exactly like setMvuVariable); globals = the
  // persistent per-profile store (host.getGlobalVars/setGlobalVar); the fallback maps the non-built-in
  // commands /gen·/genraw·/trigger·/send onto the card-facing generate/setInput.
  const genText = (r: any): string => (typeof r === 'string' ? r : (r?.content ?? ''))
  const runTriggerSlash = async (command: string): Promise<string> => {
    const ctx: StCtx = {
      vars: stat,
      globals: (await host.getGlobalVars()) || {},
      char: host.charData()?.name,
      user: host.personaName(),
      persona: host.personaName(),
      setVar: async (key, value, scope) => {
        if (scope === 'global') await host.setGlobalVar(key, value)
        else await writeVars(setVarOps(key, value))
      },
      fallback: async (cmd, pipe) => {
        const text = cmd.value || pipe
        switch (cmd.name) {
          case 'gen':
            return genText(await host.generate(text))
          case 'genraw':
            return host.generateRaw(normRaw({ user_input: text, ...cmd.named }))
          case 'trigger':
            return genText(await host.generate(''))
          case 'send':
            host.setInput(text)
            return ''
          default:
            console.warn('[triggerSlash] unsupported command', cmd.name)
            return ''
        }
      }
    }
    try {
      return await runScript(String(command ?? ''), ctx)
    } catch (e) {
      console.error('[triggerSlash]', e)
      return ''
    }
  }

  // Worldbook id↔name map (TH addresses by name; RPT by id). Seeded from the library, refreshed on miss /
  // create / delete. resolveWbId(name) → the library id, or undefined (own-book convenience / unknown).
  const wbIdByName = new Map<string, string>()
  const seedWb = (): void => {
    wbIdByName.clear()
    for (const w of host.listWorldbooks() || []) wbIdByName.set(String(w.name).toLowerCase(), w.id)
  }
  seedWb()
  const resolveWbId = (name?: any): string | undefined => {
    const key = String(name ?? '').toLowerCase()
    if (!key) return undefined
    if (!wbIdByName.has(key)) seedWb()
    return wbIdByName.get(key)
  }
  // Map RPT entries to the TavernHelper worldbook-entry shape cards read: add `uid` (array index) + `name`
  // (= our `comment`/title). Cards like the 命定之诗 home display `entry.name`; without this the raw
  // entries (no `name`) show blank. Done HERE so EVERY read path — both transports, own book or by-id —
  // is consistent (previously only the WCV own-book handler mapped, so by-id + all inline reads were raw).
  const toThWbEntry = (en: any, i: number): any => ({
    ...en,
    uid: typeof en?.uid === 'number' ? en.uid : i,
    name: en?.name || en?.comment || `Entry ${i + 1}`
  })
  const wbEntries = async (name?: any): Promise<any[]> => {
    const id = resolveWbId(name)
    const r = id ? await host.getWorldbookById(id) : await host.getWorldbook(name)
    return (r.entries || []).map(toThWbEntry)
  }
  const doCreateWb = async (name: any): Promise<string> => {
    const nm = String(name ?? 'New Worldbook')
    await host.createWorldbook(nm)
    seedWb()
    return nm
  }
  const doDeleteWb = async (name: any): Promise<boolean> => {
    const id = resolveWbId(name)
    if (!id) return false
    const ok = await host.deleteWorldbook(id)
    seedWb()
    return ok
  }
  const doBindWb = async (name: any, on: any): Promise<boolean> => {
    const id = resolveWbId(name)
    if (!id) return false
    await host.bindWorldbook(id, on !== false)
    return true
  }

  // --- TavernHelper helpers (bare + namespaced) ---
  const helpers: Record<string, any> = {
    // SYNC getters
    getVariables: () => ({ stat_data: stat }),
    getChatMessages: () => floorsToThMessages(host.floors()),
    getCurrentMessageId: () => currentMessageId(host.floors()),
    getTavernHelperVersion: () => '4.3.17',
    getCharData: () => host.charData(),
    getCharAvatarPath: () => host.charAvatarPath(),
    getPreset: () => host.preset(),
    getPresetNames: () => host.presetNames(),
    getCharWorldbookNames: () => host.worldbookNames(),
    getWorldbookNames: () => host.listWorldbooks().map((w) => w.name),
    getLorebooks: () => host.listWorldbooks(),
    getWorldbooks: () => host.listWorldbooks(),
    getCurrentCharPrimaryLorebook: () => host.worldbookNames().primary,
    getCharLorebooks: () => {
      const r = host.worldbookNames()
      return [r.primary, ...(r.additional || [])].filter(Boolean)
    },
    getTavernRegexes: () => host.regexes(),
    formatAsTavernRegexedString: (t: any) => (typeof t === 'string' ? host.formatRegex(t) : t),
    // EVENTS
    eventOn: on,
    eventMakeFirst: on,
    eventOnce: on,
    eventEmit: emit,
    eventRemoveListener: off,
    // misc
    waitGlobalInitialized: async () => true,
    substitudeMacros: substMacros,
    getLorebookSettings: () => ({}),
    setLorebookSettings: () => {},
    audioImport: () => {},
    audioPlay: () => {},
    audioPause: () => {},
    audioMode: () => {},
    audioEnable: () => {},
    errorCatched,
    // ASYNC writes
    insertOrAssignVariables: async (vars: any) => {
      const obj = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      stat = { ...stat, ...(obj || {}) }
      await writeVars(assignVarOps(obj || {}))
    },
    replaceVariables: async (vars: any) => {
      const next = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
    },
    updateVariablesWith: async (updater: any) => {
      if (typeof updater !== 'function') return
      const next = updater(clone(stat))
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
    },
    generate: async (a: any) => {
      const input = typeof a === 'string' ? a : (a?.user_input ?? a?.userInput ?? a?.text ?? '')
      const r = await host.generate(String(input ?? ''))
      return typeof r === 'string' ? r : (r?.content ?? '')
    },
    generateRaw: async (cfg: any) => host.generateRaw(normRaw(cfg)),
    getWorldbook: async (name: any) => wbEntries(name),
    getLorebookEntries: async (name: any) => wbEntries(name),
    replaceWorldbook: async (name: any, entries: any) => {
      const id = resolveWbId(name)
      if (id) await host.saveWorldbookById(id, entries)
      else await host.saveWorldbook(name, entries)
      return true
    },
    updateWorldbookWith: async (name: any, updater: any) => {
      const cur = await wbEntries(name)
      const next = typeof updater === 'function' ? await updater(cur) : cur
      const id = resolveWbId(name)
      if (id) await host.saveWorldbookById(id, next)
      else await host.saveWorldbook(name, next)
      return next
    },
    createWorldbook: doCreateWb,
    createLorebook: doCreateWb,
    deleteWorldbook: doDeleteWb,
    deleteLorebook: doDeleteWb,
    bindLorebook: doBindWb,
    setChatWorldbook: doBindWb,
    setChatMessages: async (m: any) => host.setChatMessages(m),
    deleteChatMessages: async (ids: any) => host.deleteChatMessages(ids),
    createChat: async (a?: any) => host.createChat(a),
    createChatMessages: async (m: any) => {
      // Repurposed (as ST/JSR cards' onboarding finish does): inject the LAST message's text into the host
      // composer for the player to send — NOT a real history insert (deferred; floor-model decision).
      // Routes through host.setInput so both transports share one path (inline → composer store; WCV →
      // wcv-host-set-input).
      const arr = Array.isArray(m) ? m : [m]
      const last = arr[arr.length - 1]
      const text =
        (last && (last.message ?? last.content ?? last.mes)) ||
        (typeof last === 'string' ? last : '')
      if (text) host.setInput(String(text))
      return ''
    },
    triggerSlash: (c: any) => runTriggerSlash(String(c ?? '')),
    replaceTavernRegexes: async () => undefined
  }

  // --- Mvu ---
  const Mvu = {
    getMvuData: () => ({ stat_data: stat, schema: {} }),
    getMvuVariable: (_d: any, path: string, o?: any) => {
      const v = getByPath(stat, path)
      return v === undefined ? o?.default_value : v
    },
    setMvuVariable: (_d: any, path: string, value: any) => {
      const next = clone(stat) || {}
      const parts = String(path).split('.').filter(Boolean)
      let o = next
      for (let i = 0; i < parts.length - 1; i++) {
        if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
        o = o[parts[i]]
      }
      if (parts.length) o[parts[parts.length - 1]] = value
      stat = next
      void writeVars(setVarOps(path, value))
      return value
    },
    replaceMvuData: (d: any) => {
      const next = d?.stat_data && typeof d.stat_data === 'object' ? d.stat_data : d
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      void writeVars(ops)
    },
    parseMessage: () => undefined,
    reloadInitVar: () => undefined,
    events: MVU_EVENTS
  }

  // --- SillyTavern ---
  const stChat = (): any[] => {
    const cd = host.charData()
    const greetings = [cd?.first_mes, ...(cd?.alternate_greetings || [])].filter((g: any) => !!g)
    return floorsToStChat(host.floors(), {
      charName: cd?.name || 'Character',
      userName: host.personaName(),
      greetings
    })
  }
  const eventSource = { on, emit, makeFirst: on, once: on, removeListener: off }
  const getContext = (): any => ({
    chat: stChat(),
    eventSource,
    eventTypes: TAVERN_EVENTS,
    event_types: TAVERN_EVENTS,
    extensionSettings: { EjsTemplate: { enabled: true } },
    getContext: () => getContext()
  })
  const SillyTavern = {
    chat: stChat(),
    getContext,
    substituteParams: substMacros,
    saveChat: async () => host.saveChat(SillyTavern.chat),
    reloadCurrentChat: async () => host.reloadChat()
  }

  // --- EjsTemplate (engine lives in the transport via host.evalTemplate) ---
  const EjsTemplate = {
    evalTemplate: (tmpl: string, data?: any) => host.evalTemplate(tmpl, data),
    prepareContext: (data?: any) => host.prepareContext(data),
    getSyntaxErrorInfo: (tmpl: string, data?: any) => {
      const e = host.evalTemplateError(tmpl, data)
      return e ? { message: e } : null
    },
    allVariables: () => stat,
    saveVariables: (vars: any) => {
      stat = vars || {}
      void host.setVariables(stat)
      return true
    },
    compileTemplate: (tmpl: string) => (data?: any) => host.evalTemplate(tmpl, data),
    setFeatures: () => undefined,
    getFeatures: () => ({}),
    resetFeatures: () => undefined,
    refreshWorldInfo: () => undefined,
    defines: {},
    initialVariables: () => stat
  }

  const toastr = {
    success: (m?: any) => console.info('[toast]', m),
    error: (m?: any) => console.error('[toast]', m),
    info: (m?: any) => console.info('[toast]', m),
    warning: (m?: any) => console.warn('[toast]', m),
    clear: () => {},
    remove: () => {},
    options: {}
  }

  return {
    TavernHelper: helpers,
    ...helpers,
    Mvu,
    SillyTavern,
    tavern_events: TAVERN_EVENTS,
    EjsTemplate,
    toastr,
    __rptDispose: () => {
      offVars()
      offHost()
    }
  }
}
