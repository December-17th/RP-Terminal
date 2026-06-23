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
  void ctx // reserved for Phase C async writes (profileId/chatId/characterId)
  const bus = makeBus()

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
    getCharWorldbookNames: (..._a: any[]) => ({ primary: null, additional: [] }), // refined in Phase C
    getWorldbookNames: (..._a: any[]) => [],
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

    // ASYNC ops — implemented in Phase C; here they no-op safely so a read-only card never crashes.
    replaceVariables: async (..._a: any[]) => undefined,
    insertOrAssignVariables: async (..._a: any[]) => undefined,
    updateVariablesWith: async (..._a: any[]) => undefined,
    setChatMessages: async (..._a: any[]) => false,
    deleteChatMessages: async (..._a: any[]) => false,
    createChat: async (..._a: any[]) => '',
    createChatMessages: async (..._a: any[]) => '',
    triggerSlash: async (..._a: any[]) => '',
    generate: async (..._a: any[]) => '',
    generateRaw: async (..._a: any[]) => '',
    getWorldbook: async (..._a: any[]) => [],
    replaceWorldbook: async (..._a: any[]) => false,
    updateWorldbookWith: async (..._a: any[]) => [],
    getLorebookEntries: async (..._a: any[]) => [],
    replaceTavernRegexes: async (..._a: any[]) => undefined
  }

  // ---- Mvu ---------------------------------------------------------------------------------------
  const Mvu = {
    getMvuData: (_o?: any) => ({ stat_data: statData(), schema: {} }),
    getMvuVariable: (_d: any, path: string, o?: any) => {
      const v = getByPath(statData(), path)
      return v === undefined ? o?.default_value : v
    },
    setMvuVariable: (_d: any, _path: string, _value: any, _o?: any) => undefined, // write: Phase C
    replaceMvuData: (_d: any, _o?: any) => undefined, // write: Phase C
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
    z: undefined
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
