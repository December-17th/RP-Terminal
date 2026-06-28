// src/shared/thRuntime/index.ts
import type { Host, ThGlobals } from './types'
import { floorsToThMessages, floorsToStChat, currentMessageId } from './shapes'
import { setVarOps, assignVarOps, replaceStatDataOps, type VarOp } from './ops'
import { nativeToThEntry, thToNativeEntry } from './worldbookEntry'
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
  // Fire MVU events for EVERY genuine stat_data change — including the card's OWN writes looping back.
  // Cards routinely chain initialization through their own `mag_variable_update_ended` (write a field →
  // react → write the next), and the prompt-side EJS injection reads the resulting vars via getvar; if we
  // swallowed self-write events the chain would stall after the first write and those vars would never
  // populate. We only skip a byte-identical repeat (a true no-op echo). A card that writes a constantly-
  // CHANGING value on its own event (e.g. a `date` clock) would still spin here — that runaway is broken
  // at the SOURCE instead (`generationService.applyVariableOps` caps rapid same-path writes), which stops
  // the persist+broadcast so no echo returns, without muzzling legitimate self-chained writes.
  //
  // WS-3 SPIKE (2026-06-26): this firing-on-every-change DIVERGES from real MVU. In the MIT MagVarUpdate
  // source, `mag_variable_update_*` are emitted only by `updateVariables`, called only from the AI-message
  // FOLD path — NOT from programmatic card writes (setMvuVariable/insertOrAssignVariables are pure helpers).
  // The faithful fix that also kills the loop at the source: tag each change's origin (model-fold vs
  // card-write) end-to-end and fire here ONLY for model-fold, then retire the generationService heuristic.
  // DEFERRED — behavior change on the live pipeline (both transports); a prior suppress-self-write attempt
  // was reverted (broke cards chaining init through their own events), so it needs in-app verification
  // against 命定之诗 first. See docs/structural-cleanup-log-2026-06-26.md Stage 13.
  let lastFiredJson = JSON.stringify(stat ?? null)
  const offVars = host.onVarsChanged((sd) => {
    const json = JSON.stringify(sd ?? null)
    if (json === lastFiredJson) return
    lastFiredJson = json
    // MVU event contract (JS-Slash-Runner `exported.mvu.d.ts`): VARIABLE_UPDATE_* handlers receive
    // `(variables: MvuData, variables_before_update: MvuData)` — the WRAPPED `{ stat_data }` object,
    // NOT the bare stat_data. Matches the inline transport (`plugin/mvuEvents.ts`). Emitting bare stat
    // broke cards that read `variables.stat_data` (ZodError + "reading 'stat_data' of undefined").
    const before = { stat_data: stat }
    stat = sd || {}
    const after = { stat_data: stat }
    emit(MVU_EVENTS.VARIABLE_UPDATE_STARTED, after, before)
    emit(MVU_EVENTS.VARIABLE_UPDATED, after, before)
    emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, after, before)
    // `tavern_events.MESSAGE_UPDATED` carries the updated message id (`event.d.ts`), never nothing —
    // a card reading the id (or a field off it) otherwise throws on `undefined`.
    emit(TAVERN_EVENTS.MESSAGE_UPDATED, currentMessageId(host.floors()))
  })
  const offHost = host.onHostEvent((name, payload) => emit(name, payload))

  // Stable per-runtime script id (TH getScriptId) — our card scripts share one frame, so a per-frame
  // constant is enough (cross-script isolation by id isn't modeled; matches the inline shim's behavior).
  const scriptId = 'rpt_script_' + Math.random().toString(36).slice(2, 10)

  // Script action buttons (TH replaceScriptButtons/getScriptButtons): the host renders the visible ones in
  // the menu above the input; a click comes back as a host event named getButtonEvent(name) (= the raw
  // name) → the script's eventOn(getButtonEvent(name)) fires. The button name IS the event name (identity),
  // consistent with the legacy inline `withButtons` baking.
  let scriptButtons: { name: string; visible: boolean }[] = []
  const normButtons = (b: any): { name: string; visible: boolean }[] =>
    (Array.isArray(b) ? b : [])
      .filter((x) => x && x.name != null)
      .map((x) => ({ name: String(x.name), visible: x.visible !== false }))
  const pushButtons = (): void => host.setButtons(scriptButtons.filter((b) => b.visible))

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
  // Map RPT native entries to the TavernHelper `WorldbookEntry` shape cards read — `uid`/`name` AND the
  // `strategy.{type,keys,keys_secondary}` / `position` / `extra` a card expects (shared/thRuntime/
  // worldbookEntry). Done HERE so EVERY read path — both transports, own book or by-id — is consistent;
  // without the strategy/keys, a card's diff over `entry.strategy.keys` throws and keys/constant are lost.
  const wbEntries = async (name?: any): Promise<any[]> => {
    const id = resolveWbId(name)
    const r = id ? await host.getWorldbookById(id) : await host.getWorldbook(name)
    return (r.entries || []).map(nativeToThEntry)
  }
  // Persist a full set of TavernHelper-shaped entries to a book (TH→native via the shared mapper, by id
  // when resolvable else by name). Shared by replace / update / create / delete entry paths.
  const saveWb = async (name: any, thEntries: any[]): Promise<void> => {
    const native = (Array.isArray(thEntries) ? thEntries : []).map(thToNativeEntry)
    const id = resolveWbId(name)
    if (id) await host.saveWorldbookById(id, native)
    else await host.saveWorldbook(name, native)
  }
  const doCreateWbEntries = async (name: any, newEntries: any): Promise<any> => {
    const added = Array.isArray(newEntries) ? newEntries : []
    const all = [...(await wbEntries(name)), ...added]
    await saveWb(name, all)
    return { worldbook: all, new_entries: added }
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
    // type:'script' ⇒ the card's own KV store (NOT stat_data); any other scope ⇒ the message vars.
    getVariables: (opt?: any) =>
      opt && opt.type === 'script'
        ? host.getScriptVars()
        : opt && opt.type === 'chat'
          ? host.getChatVars()
          : { stat_data: stat },
    getScriptId: () => scriptId,
    getCurrentCharacterName: () => host.charData()?.name ?? '',
    // Button name == event name (identity) — TH cards subscribe via eventOn(getButtonEvent(name), …).
    getButtonEvent: (name: any) => String(name == null ? '' : name),
    getScriptButtons: () => scriptButtons,
    replaceScriptButtons: (b: any) => {
      scriptButtons = normButtons(b)
      pushButtons()
      return scriptButtons
    },
    appendInexistentScriptButtons: (b: any) => {
      const have = new Set(scriptButtons.map((x) => x.name))
      for (const x of normButtons(b)) if (!have.has(x.name)) scriptButtons.push(x)
      pushButtons()
      return scriptButtons
    },
    updateScriptButtonsWith: (updater: any) => {
      if (typeof updater === 'function') {
        // Accept either a returned array OR in-place mutation that returns void (both are common JSR usages).
        const r = updater(scriptButtons)
        scriptButtons = normButtons(Array.isArray(r) ? r : scriptButtons)
      }
      pushButtons()
      return scriptButtons
    },
    getChatMessages: () => floorsToThMessages(host.floors()),
    getCurrentMessageId: () => currentMessageId(host.floors()),
    // TH alias: getCurrentMessageId IS getLastMessageId (both = the last message's id). The inline
    // shim already aliases them (shims/tavern.ts); the WCV runtime was missing the alias, so MVU/status
    // cards that call getLastMessageId() in their update handler threw "getLastMessageId is not defined"
    // — which aborted card init and cascaded into a downstream message_updated handler reading a field
    // off the never-set state ("reading 'event' of undefined").
    getLastMessageId: () => currentMessageId(host.floors()),
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
    getTavernRegexes: (option?: any) => host.regexesFull(option),
    isCharacterTavernRegexesEnabled: () => host.isCharacterRegexesEnabled(),
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
    // Prompt-injection API (TH injectPrompts/uninjectPrompts). RP Terminal assembles the prompt in
    // the MAIN process, so a renderer-side injection can't reach the build yet — these are safe
    // no-ops returning the documented `{ uninject }` handle, so a card that calls them every turn
    // (MVU/status cards do, on message_updated) degrades gracefully instead of throwing on a bare
    // global. (Depth-positioned injection into the build is a separate feature.)
    injectPrompts: (_prompts: any, _options?: any) => ({ uninject: () => undefined }),
    uninjectPrompts: (_ids: any) => undefined,
    // ASYNC writes
    insertOrAssignVariables: async (vars: any) => {
      const obj = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      stat = { ...stat, ...(obj || {}) }
      await writeVars(assignVarOps(obj || {}))
    },
    // TH insertVariables: insert-if-ABSENT (never overwrites an existing key) — the no-overwrite
    // sibling of insertOrAssignVariables, used by cards to seed initial MVU vars. Parity with the
    // inline shim (shims/tavern.ts), which already exposed it; the WCV runtime was missing it.
    insertVariables: async (vars: any) => {
      const obj = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      const add: Record<string, any> = {}
      for (const k of Object.keys(obj || {})) if (!(k in stat)) add[k] = obj[k]
      if (Object.keys(add).length) {
        stat = { ...stat, ...add }
        await writeVars(assignVarOps(add))
      }
    },
    replaceVariables: async (vars: any, opt?: any) => {
      if (opt && opt.type === 'chat') {
        await host.setChatVars(vars && typeof vars === 'object' ? vars : {})
        return
      }
      const next = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
    },
    updateVariablesWith: async (updater: any, opt?: any) => {
      if (typeof updater !== 'function') return
      // type:'script' ⇒ read-modify-write the card's own KV (the updater returns the FULL object), keeping
      // it out of stat_data — e.g. the workshop caches its cloud project under a script var.
      if (opt && opt.type === 'script') {
        const cur = clone(host.getScriptVars()) || {}
        const next = (await updater(cur)) || cur
        await host.setScriptVars(next)
        return next
      }
      if (opt && opt.type === 'chat') {
        const cur = clone(host.getChatVars()) || {}
        const next = (await updater(cur)) || cur
        await host.setChatVars(next)
        return next
      }
      const next = updater(clone(stat))
      const ops = replaceStatDataOps(stat, next)
      stat = clone(next) || {}
      await writeVars(ops)
      return next
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
      // Card sends TavernHelper-shaped entries; persist native (strategy.keys→keys, type:'constant'→constant).
      await saveWb(name, entries)
      return true
    },
    replaceWorldbookEntries: async (name: any, entries: any) => {
      // TH alias (older name): accept (name, entries) or (entries) for the active card's book.
      if (Array.isArray(name)) {
        entries = name
        name = undefined
      }
      await saveWb(name, entries)
      return true
    },
    updateWorldbookWith: async (name: any, updater: any) => {
      const cur = await wbEntries(name)
      const next = typeof updater === 'function' ? await updater(cur) : cur
      await saveWb(name, next)
      return next
    },
    // Append new entries (TH createWorldbookEntries) → { worldbook, new_entries }.
    createWorldbookEntries: doCreateWbEntries,
    createLorebookEntries: doCreateWbEntries,
    // Delete entries matching `predicate` (TH deleteWorldbookEntries) → { worldbook, deleted_entries }.
    // The workshop's uninstall calls this, filtering by `extra.cw_project_id`.
    deleteWorldbookEntries: async (name: any, predicate: any) => {
      const cur = await wbEntries(name)
      const kept: any[] = []
      const deleted: any[] = []
      for (const e of cur) {
        if (typeof predicate === 'function' && predicate(e)) deleted.push(e)
        else kept.push(e)
      }
      await saveWb(name, kept)
      return { worldbook: kept, deleted_entries: deleted }
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
    assetUrl: (name: string, type: string, mood?: string) => host.assetUrl(name, type, mood),
    replaceTavernRegexes: async (regexes: any, option?: any) =>
      host.replaceRegexes(Array.isArray(regexes) ? regexes : [], option),
    updateTavernRegexesWith: async (updater: any, option?: any) => {
      const cur = host.regexesFull(option)
      if (typeof updater !== 'function') return cur
      const next = await updater(cur)
      await host.replaceRegexes(Array.isArray(next) ? next : cur, option)
      return Array.isArray(next) ? next : cur
    }
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
  // ST persists global settings on a debounce; RP Terminal has no ST settings.json, so this is a no-op.
  // Cards (esp. extension-style ones) call it after mutating extensionSettings — without the function on
  // the global they throw "SillyTavern.saveSettingsDebounced is not a function" (an unhandledrejection).
  const saveSettingsDebounced = (): void => undefined
  const getContext = (): any => ({
    chat: stChat(),
    eventSource,
    eventTypes: TAVERN_EVENTS,
    event_types: TAVERN_EVENTS,
    extensionSettings: { EjsTemplate: { enabled: true } },
    saveSettingsDebounced,
    getContext: () => getContext()
  })
  const SillyTavern = {
    chat: stChat(),
    getContext,
    substituteParams: substMacros,
    getCurrentChatId: () => host.currentChatId(),
    saveChat: async () => host.saveChat(SillyTavern.chat),
    reloadCurrentChat: async () => host.reloadChat(),
    saveSettingsDebounced
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
