// src/preload/wcvHost.ts
//
// WCV transport adapter for the unified TH runtime (shared/thRuntime). It wraps the same `ipcRenderer`
// channels wcvPreload used directly; the WCV preload has NO per-slot ctx — main resolves the calling
// panel's session from `e.sender`, so these methods call IPC WITHOUT passing ctx (the placeholder ctx is
// only here to satisfy the Host interface). The quickjs EJS engine stays in the preload and is injected
// via deps.evalTemplate / deps.evalTemplateError.
import { ipcRenderer } from 'electron'
import type { Host, CardCtx, FloorLike, VarsOrigin } from '../shared/thRuntime/types'
import type { VarOp } from '../shared/thRuntime/ops'

type Deps = {
  ctx: CardCtx
  evalTemplate: (tmpl: string, data?: any) => string
  evalTemplateError: (tmpl: string, data?: any) => string | null
  prepareContext: (data?: any) => any
}

export function createWcvHost(deps: Deps): Host {
  const wbNames = (): any => ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')
  return {
    ctx: deps.ctx,
    statData: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-vars-sync') || {}
      } catch {
        return {}
      }
    },
    floors: () => {
      try {
        return (ipcRenderer.sendSync('wcv-host-get-floors-sync') as FloorLike[]) || []
      } catch {
        return []
      }
    },
    charData: () => ipcRenderer.sendSync('wcv-host-get-char-data'),
    charAvatarPath: () => ipcRenderer.sendSync('wcv-host-get-char-avatar'),
    preset: () => ipcRenderer.sendSync('wcv-host-get-preset'),
    presetNames: () => ipcRenderer.sendSync('wcv-host-get-preset-names'),
    worldbookNames: () => {
      const r = wbNames()
      return { primary: r?.primary ?? null, additional: r?.additional || [] }
    },
    regexes: () => ipcRenderer.sendSync('wcv-host-get-regexes'),
    regexesFull: (option) => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-regexes-full', option) || []
      } catch {
        return []
      }
    },
    isCharacterRegexesEnabled: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-is-char-regex-enabled') !== false
      } catch {
        return true
      }
    },
    formatRegex: (t) => ipcRenderer.sendSync('wcv-host-format-regex', t),
    personaName: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-persona-name') || 'User'
      } catch {
        return 'User'
      }
    },
    currentChatId: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-chat-id-sync') || ''
      } catch {
        return ''
      }
    },
    getScriptVars: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-script-vars-get-sync') || {}
      } catch {
        return {}
      }
    },
    getChatVars: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-chat-vars-get-sync') || {}
      } catch {
        return {}
      }
    },

    applyVariableOps: (ops: VarOp[]) => ipcRenderer.invoke('wcv-host-apply-vars', ops),
    replaceRegexes: (regexes, option) =>
      ipcRenderer.invoke('wcv-host-replace-regexes', regexes, option),
    setScriptVars: (vars) => ipcRenderer.invoke('wcv-host-script-vars-set', vars),
    setChatVars: (vars) => ipcRenderer.invoke('wcv-host-chat-vars-set', vars),
    setButtons: (buttons) => ipcRenderer.send('wcv-register-button', buttons),
    setVariables: (sd: any) => ipcRenderer.invoke('wcv-host-set-vars', sd),
    generate: (input: string) => ipcRenderer.invoke('wcv-host-generate', input),
    generateRaw: (cfg) => ipcRenderer.invoke('wcv-host-generate-raw', cfg),
    getWorldbook: async (name) => {
      const entries = await ipcRenderer.invoke('wcv-host-get-worldbook', name)
      return { entries: Array.isArray(entries) ? entries : (entries?.entries ?? []) }
    },
    saveWorldbook: (name, entries) =>
      ipcRenderer.invoke('wcv-host-replace-worldbook', name, entries),
    // Worldbook CRUD/bind — full library via ctx-scoped IPC. list/chat-ids are sync (sendSync).
    listWorldbooks: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-list-worldbooks-sync') || []
      } catch {
        return []
      }
    },
    chatWorldbookIds: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-chat-worldbook-ids-sync') || []
      } catch {
        return []
      }
    },
    createWorldbook: (name) => ipcRenderer.invoke('wcv-host-create-worldbook', name),
    deleteWorldbook: (id) => ipcRenderer.invoke('wcv-host-delete-worldbook', id),
    getWorldbookById: async (id) => {
      const r = await ipcRenderer.invoke('wcv-host-get-worldbook-by-id', id)
      return { name: r?.name, entries: Array.isArray(r?.entries) ? r.entries : [] }
    },
    saveWorldbookById: (id, entries) =>
      ipcRenderer.invoke('wcv-host-save-worldbook-by-id', id, entries),
    bindWorldbook: (id, on) => ipcRenderer.invoke('wcv-host-bind-worldbook', id, on),
    setChatMessages: (m) => ipcRenderer.invoke('wcv-host-set-chat-messages', m),
    deleteChatMessages: (ids) => ipcRenderer.invoke('wcv-host-delete-chat-messages', ids),
    createChat: () => Promise.resolve(''),
    saveChat: (chat) => ipcRenderer.invoke('wcv-host-save-chat', chat),
    reloadChat: () => ipcRenderer.invoke('wcv-host-reload-chat'),
    setInput: (text) => ipcRenderer.send('wcv-host-set-input', text),
    submitInput: () => ipcRenderer.send('wcv-host-submit-input'),
    getGlobalVars: () => ipcRenderer.invoke('wcv-host-get-global-vars'),
    setGlobalVar: (key, value) => ipcRenderer.invoke('wcv-host-set-global-var', key, value),
    // Whole-object global vars (getVariables/replaceVariables({type:'global'})). SYNC read (blocks
    // briefly, once) so the card reads its saved settings before its first render — matches the
    // stat/chat/script sync getters.
    getGlobalVarsSync: () => {
      try {
        return ipcRenderer.sendSync('wcv-host-get-global-vars-sync') || {}
      } catch {
        return {}
      }
    },
    setGlobalVars: (vars) => ipcRenderer.invoke('wcv-host-set-global-vars', vars),
    assetUrl: (name: string, type: string, mood?: string) =>
      ipcRenderer.invoke('wcv-host-asset-url', name, type, mood),
    // WA-3: enumerate one entry's variants; ctx resolves from e.sender main-side (like asset-url).
    assetList: (name: string, type: string) =>
      ipcRenderer.invoke('wcv-host-asset-list', name, type),
    // WA-3: picker-backed import — main opens the OS image picker, copies into the calling card's world,
    // returns the new rptasset:// URL (null on cancel/invalid). ctx resolves from e.sender.
    requestAssetImport: (arg: { name: string; type: string; variant?: string }) =>
      ipcRenderer.invoke('wcv-host-request-asset-import', arg),
    getDuelPreview: () => ipcRenderer.invoke('wcv-host-duel-preview'),
    // Overlay surfaces (PM-A7): main validates the id against the calling card's panel_ui.overlays
    // (resolved from e.sender), mounts/closes the overlay WCV, and returns whether it opened.
    requestOverlay: (id: string) => ipcRenderer.invoke('wcv-host-request-overlay', id),
    closeOverlay: () => ipcRenderer.invoke('wcv-host-close-overlay'),

    onVarsChanged: (cb) => {
      // Forward the origin (2nd IPC arg) so the runtime fires MVU events only for non-card-write changes
      // (a card's own write echoed back must not re-fire its events and loop — the WS-3 fix). Absent ⇒
      // undefined meta ⇒ the runtime treats it as a fold (events fire) for back-compat.
      const l = (_e: any, v: any, origin?: VarsOrigin): void =>
        cb(v, origin ? { origin } : undefined)
      ipcRenderer.on('wcv-vars-changed', l)
      return () => ipcRenderer.removeListener('wcv-vars-changed', l)
    },
    onHostEvent: (cb) => {
      const l = (_e: any, d: any): void => d && d.name && cb(d.name, d.payload)
      ipcRenderer.on('wcv-event', l)
      return () => ipcRenderer.removeListener('wcv-event', l)
    },
    evalTemplate: deps.evalTemplate,
    evalTemplateError: deps.evalTemplateError,
    prepareContext: deps.prepareContext
  }
}
