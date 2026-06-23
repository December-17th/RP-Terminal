// src/renderer/src/cardBridge/createCardBridge.ts
//
// Renderer-side card API bridge — the SAME TavernHelper/Mvu/SillyTavern/EJS surface as the WCV
// preload (src/preload/wcvPreload.ts), but for same-origin inline iframes. Sync getters read the
// renderer's live zustand stores; async ops go through window.api. Clean-room: not derived from JSR.
//
// Dynamically typed throughout (card args are user-supplied) — `any` is intentional, matching
// wcvPreload (the repo disables @typescript-eslint/no-explicit-any globally).
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { evalTemplate } from '../../../shared/templateEngine'
import { buildRenderContext } from '../plugin/renderTemplate'
import { setVarOps, assignVarOps, replaceStatDataOps, type VarOp } from './ops'

export type CardCtx = { profileId: string; chatId: string; characterId: string }

// --- store-read helpers (kept at module top so every import lives here). Deliberately NOT named
// with a `use` prefix: they are plain store getters, not React hooks (the prefix would trip
// react-hooks/rules-of-hooks). -------------------------------------------------------------------
const readRegexRules = (): any[] => useRegexStore.getState().rules
const applyDisplayRegex = (text: string): string => useRegexStore.getState().apply(text)
const readPersonaName = (): string => useSettingsStore.getState().settings?.persona?.name || 'User'

// --- live store reads (always the active chat/character the card is rendered in) -----------------
const latestFloor = (): any => {
  const floors = useChatStore.getState().floors
  return floors[floors.length - 1]
}
const latestVars = (): Record<string, any> => latestFloor()?.variables ?? {}
const statData = (): any => {
  const v = latestVars()
  return v && typeof v === 'object' && 'stat_data' in v ? (v as any).stat_data : v
}
const cardData = (): any => useCharacterStore.getState().activeCharacter?.card?.data ?? null

// --- per-frame event bus (mirrors wcvPreload's local bus) ---------------------------------------
const makeBus = (): {
  on: (n: string, cb: (...a: any[]) => void) => void
  emit: (n: string, ...a: any[]) => void
  off: (n: string, cb: (...a: any[]) => void) => void
} => {
  const map: Record<string, Array<(...a: any[]) => void>> = {}
  return {
    on: (n, cb) => {
      ;(map[n] ||= []).push(cb)
    },
    emit: (n, ...a) => {
      for (const cb of map[n] || []) {
        try {
          cb(...a)
        } catch (e) {
          console.error('[rpt card event]', n, e)
        }
      }
    },
    off: (n, cb) => {
      map[n] = (map[n] || []).filter((f) => f !== cb)
    }
  }
}

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

// errorCatched(fn): wrap fn, swallow + log throws/rejections (cards call it bare in onMounted).
const errorCatched =
  (fn: any) =>
  (...args: any[]): any => {
    try {
      const r = typeof fn === 'function' ? fn(...args) : undefined
      if (r && typeof r.then === 'function') return r.catch((e: any) => console.error('[card]', e))
      return r
    } catch (e) {
      console.error('[card]', e)
      return undefined
    }
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

export function createCardBridge(ctx: CardCtx): Record<string, unknown> {
  const bus = makeBus()

  let lastVarsJson = ''
  const unsub = useChatStore.subscribe((state) => {
    const f = state.floors[state.floors.length - 1]
    const json = JSON.stringify(f?.variables ?? null)
    if (json !== lastVarsJson) {
      lastVarsJson = json
      bus.emit(MVU_EVENTS.VARIABLE_UPDATED, statData())
      bus.emit(TAVERN_EVENTS.MESSAGE_UPDATED)
    }
  })

  // ---- variable-write path (Phase C) ------------------------------------------------------------
  // The target floor is the latest floor's own `.floor` value (NOT an array index) — chatStore's
  // applyVariableOps matches ops against `f.floor`, and defaults to the latest floor when omitted.
  const floorIndex = (): number => {
    const floors = useChatStore.getState().floors
    return floors.length ? (floors[floors.length - 1].floor ?? floors.length - 1) : 0
  }
  const writeVars = async (ops: VarOp[]): Promise<void> => {
    if (!ops.length) return
    // Optimistic: chatStore.applyVariableOps persists via window.api AND folds the returned floor
    // back into the store, so the card sees its own change immediately. Don't double-call window.api.
    try {
      await useChatStore.getState().applyVariableOps(ctx.profileId, ops, floorIndex())
    } catch (e) {
      console.error('[card writeVars]', e)
    }
  }

  // ---- worldbook (lorebook) write path (Phase C) ------------------------------------------------
  // A card's own book is keyed by characterId (WCV invariant: lorebookService.getLorebookById uses
  // the character id; preload getLorebook/saveLorebook are id-keyed). getLorebook → { name, entries }.
  const fetchWorldbook = async (_name?: any): Promise<any> => {
    try {
      return await window.api.getLorebook(ctx.profileId, ctx.characterId)
    } catch {
      return { entries: [] }
    }
  }
  const saveWorldbook = async (_name: any, entries: any): Promise<void> => {
    const lb = (await fetchWorldbook()) || { name: '', entries: [] }
    const next = Array.isArray(entries) ? { ...lb, entries } : entries
    try {
      await window.api.saveLorebook(ctx.profileId, ctx.characterId, next)
    } catch (e) {
      console.error('[card saveWorldbook]', e)
    }
  }
  const normalizeWb = (lb: any): any[] =>
    Array.isArray(lb?.entries) ? lb.entries : Array.isArray(lb) ? lb : []

  // ---- EjsTemplate: reuse the renderer's already-initialized shared engine -----------------------
  const EjsTemplate = {
    evalTemplate: (tmpl: string, _data?: any): string =>
      evalTemplate(tmpl, buildRenderContext(latestVars())),
    prepareContext: (_data?: any) => buildRenderContext(latestVars()),
    getSyntaxErrorInfo: (_tmpl: string, _data?: any) => null,
    allVariables: () => statData(),
    saveVariables: (_vars: any) => true,
    compileTemplate: (tmpl: string) => () => evalTemplate(tmpl, buildRenderContext(latestVars())),
    setFeatures: () => undefined,
    getFeatures: () => ({}),
    resetFeatures: () => undefined,
    refreshWorldInfo: () => undefined,
    defines: {},
    initialVariables: () => statData()
  }

  // ---- TavernHelper helpers (bare globals) ------------------------------------------------------
  const helpers: Record<string, any> = {
    // SYNC getters (store reads)
    getVariables: (_opts?: any) => ({ stat_data: statData() }),
    getChatMessages: (..._a: any[]) => {
      const floors = useChatStore.getState().floors
      const out: any[] = []
      floors.forEach((f: any, i: number) => {
        out.push({ message_id: i * 2, role: 'user', message: f.user_message?.content ?? '' })
        out.push({ message_id: i * 2 + 1, role: 'assistant', message: f.response?.content ?? '' })
      })
      return out
    },
    getCurrentMessageId: () => {
      const n = useChatStore.getState().floors.length
      return n > 0 ? n * 2 - 1 : 0
    },
    getTavernHelperVersion: () => '4.3.17',
    getCharData: (..._a: any[]) => cardData(),
    getCharAvatarPath: (..._a: any[]) => null,
    getPreset: (..._a: any[]) => {
      const p = usePresetStore.getState().preset
      return p ? { name: p.name, parameters: p.parameters } : null
    },
    getPresetNames: (..._a: any[]) => usePresetStore.getState().presets.map((p: any) => p.name),
    getCharWorldbookNames: (..._a: any[]) => {
      const name = useCharacterStore.getState().activeCharacter?.card?.data?.name || null
      return { primary: name, additional: [] }
    },
    getWorldbookNames: (..._a: any[]) => {
      const name = useCharacterStore.getState().activeCharacter?.card?.data?.name
      return name ? [name] : []
    },
    getCurrentCharPrimaryLorebook: () => null,
    getCharLorebooks: (..._a: any[]) => [],
    getTavernRegexes: (..._a: any[]) =>
      readRegexRules().map((r: any) => ({ find: r.source, replace: r.replace })),
    formatAsTavernRegexedString: (text: any, ..._a: any[]) =>
      typeof text === 'string' ? applyDisplayRegex(text) : text,

    // EVENT bus
    eventOn: (n: string, cb: any) => bus.on(n, cb),
    eventMakeFirst: (n: string, cb: any) => bus.on(n, cb),
    eventOnce: (n: string, cb: any) => bus.on(n, cb),
    eventEmit: (n: string, ...a: any[]) => bus.emit(n, ...a),
    eventRemoveListener: (n: string, cb: any) => bus.off(n, cb),

    // misc sync stubs (parity with wcvPreload)
    waitGlobalInitialized: async (..._a: any[]) => true,
    substitudeMacros: (text: string) => text,
    getLorebookSettings: () => ({}),
    setLorebookSettings: () => {},
    audioImport: () => {},
    audioPlay: () => {},
    audioPause: () => {},
    audioMode: () => {},
    audioEnable: () => {},
    errorCatched,

    // ASYNC write ops — Phase C: real window.api persistence + optimistic store updates.
    insertOrAssignVariables: async (vars: any, _opts?: any) => {
      // Deep-assign the given object's top-level keys into stat_data.
      const obj = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      await writeVars(assignVarOps(obj))
    },
    replaceVariables: async (vars: any, _opts?: any) => {
      // Wholesale replace stat_data (expressed per top-level key — see ops.ts).
      const next = vars?.stat_data && typeof vars.stat_data === 'object' ? vars.stat_data : vars
      await writeVars(replaceStatDataOps(statData(), next))
    },
    updateVariablesWith: async (updater: any, _opts?: any) => {
      if (typeof updater !== 'function') return
      const next = updater(structuredClone(statData()))
      await writeVars(replaceStatDataOps(statData(), next))
    },
    generate: async (a: any) => {
      const action = typeof a === 'string' ? a : (a?.user_input ?? a?.injects ?? '')
      const r: any = await window.api.generate(ctx.profileId, ctx.chatId, action)
      return typeof r === 'string' ? r : (r?.content ?? '')
    },
    generateRaw: async (config: any) => {
      const r: any = await window.api.generateRaw(ctx.profileId, ctx.chatId, config)
      return typeof r === 'string' ? r : (r?.content ?? '')
    },
    getWorldbook: async (name: any) => normalizeWb(await fetchWorldbook(name)),
    getLorebookEntries: async (name: any) => normalizeWb(await fetchWorldbook(name)),
    replaceWorldbook: async (name: any, entries: any) => {
      await saveWorldbook(name, entries)
      return true
    },
    updateWorldbookWith: async (name: any, updater: any) => {
      const cur = normalizeWb(await fetchWorldbook(name))
      const next = typeof updater === 'function' ? updater(cur) : cur
      await saveWorldbook(name, next)
      return next
    },

    // ASYNC ops still stubbed (out of C1 scope) — no-op safely so a card never crashes.
    setChatMessages: async (..._a: any[]) => false,
    deleteChatMessages: async (..._a: any[]) => false,
    createChat: async (..._a: any[]) => '',
    createChatMessages: async (..._a: any[]) => '',
    triggerSlash: async (..._a: any[]) => '',
    replaceTavernRegexes: async (..._a: any[]) => undefined
  }

  // ---- Mvu ---------------------------------------------------------------------------------------
  const Mvu = {
    getMvuData: (_o?: any) => ({ stat_data: statData(), schema: {} }),
    getMvuVariable: (_d: any, path: string, o?: any) => {
      const v = getByPath(statData(), path)
      return v === undefined ? o?.default_value : v
    },
    setMvuVariable: (_d: any, path: string, value: any, _o?: any) => {
      bus.emit(MVU_EVENTS.VARIABLE_UPDATE_STARTED, statData())
      void writeVars(setVarOps(path, value)).then(() => {
        bus.emit(MVU_EVENTS.VARIABLE_UPDATED, statData())
        bus.emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, statData())
      })
      return value
    },
    replaceMvuData: (d: any, _o?: any) => {
      const next = d?.stat_data && typeof d.stat_data === 'object' ? d.stat_data : d
      void writeVars(replaceStatDataOps(statData(), next))
    },
    parseMessage: (..._a: any[]) => undefined,
    reloadInitVar: (..._a: any[]) => undefined,
    events: MVU_EVENTS
  }

  // ---- SillyTavern -------------------------------------------------------------------------------
  const stChat = (): any[] => {
    const floors = useChatStore.getState().floors
    const charName = cardData()?.name || 'Character'
    const userName = readPersonaName()
    const out: any[] = []
    floors.forEach((f: any) => {
      out.push({
        is_user: true,
        name: userName,
        mes: f.user_message?.content ?? '',
        send_date: '',
        swipes: [],
        swipe_id: 0,
        extra: {}
      })
      out.push({
        is_user: false,
        name: charName,
        mes: f.response?.content ?? '',
        send_date: '',
        swipes: f.swipes ?? [f.response?.content ?? ''],
        swipe_id: f.swipe_id ?? 0,
        extra: {}
      })
    })
    return out
  }
  const eventSource = {
    on: bus.on,
    emit: bus.emit,
    makeFirst: bus.on,
    once: bus.on,
    removeListener: bus.off
  }
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
    substituteParams: (text: string) => text,
    saveChat: async () => true, // write: Phase C
    reloadCurrentChat: async () => true
  }

  return {
    TavernHelper: helpers,
    ...helpers,
    Mvu,
    SillyTavern,
    tavern_events: TAVERN_EVENTS,
    EjsTemplate,
    toastr,
    _: undefined, // overwritten below by index.ts globals (lodash)
    z: undefined,
    __rptDispose: () => unsub()
  }
}

// --- small helpers ------------------------------------------------------------------------------
function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((c: any, k) => (c == null ? c : c[k]), obj)
}
