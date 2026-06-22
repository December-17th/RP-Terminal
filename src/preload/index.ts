import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  createProfile: (name: string) => ipcRenderer.invoke('create-profile', name),
  getSettings: (profileId: string) => ipcRenderer.invoke('get-settings', profileId),
  saveSettings: (profileId: string, settings: any) =>
    ipcRenderer.invoke('save-settings', profileId, settings),
  getCharacters: (profileId: string) => ipcRenderer.invoke('get-characters', profileId),
  saveCharacter: (profileId: string, charId: string, card: any) =>
    ipcRenderer.invoke('save-character', profileId, charId, card),
  importCharacterDialog: (profileId: string) =>
    ipcRenderer.invoke('import-character-dialog', profileId),
  exportCharacterDialog: (profileId: string, characterId: string) =>
    ipcRenderer.invoke('export-character-dialog', profileId, characterId),
  getChats: (profileId: string) => ipcRenderer.invoke('get-chats', profileId),
  createChat: (profileId: string, charId: string) =>
    ipcRenderer.invoke('create-chat', profileId, charId),
  getFloors: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-floors', profileId, chatId),
  reevaluateVariables: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('reevaluate-variables', profileId, chatId),
  applyVariableOps: (profileId: string, chatId: string, floor: number, ops: unknown[]) =>
    ipcRenderer.invoke('apply-variable-ops', profileId, chatId, floor, ops),
  // WebContentsView card-UI panels (spike): position/lifecycle, fire-and-forget.
  wcvEnsure: (id: string, bounds: unknown, url: string, ctx: unknown) =>
    ipcRenderer.send('wcv-ensure', id, bounds, url, ctx),
  wcvSetBounds: (id: string, bounds: unknown) => ipcRenderer.send('wcv-set-bounds', id, bounds),
  wcvSetVisible: (id: string, visible: boolean) =>
    ipcRenderer.send('wcv-set-visible', id, visible),
  wcvDestroy: (id: string) => ipcRenderer.send('wcv-destroy', id),
  wcvBroadcastVars: (chatId: string, statData: unknown) =>
    ipcRenderer.send('wcv-broadcast-vars', chatId, statData),
  generate: (profileId: string, chatId: string, userAction: string) =>
    ipcRenderer.invoke('generate', profileId, chatId, userAction),
  regenerate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('regenerate', profileId, chatId),
  abortGeneration: (chatId: string) => ipcRenderer.invoke('abort-generation', chatId),
  deleteChat: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('delete-chat', profileId, chatId),
  editFloor: (
    profileId: string,
    chatId: string,
    floorIndex: number,
    userContent: string | null,
    responseContent: string | null
  ) =>
    ipcRenderer.invoke('edit-floor', profileId, chatId, floorIndex, userContent, responseContent),
  deleteCharacter: (profileId: string, charId: string) =>
    ipcRenderer.invoke('delete-character', profileId, charId),
  listPresets: (profileId: string) => ipcRenderer.invoke('list-presets', profileId),
  getActivePresetId: (profileId: string) => ipcRenderer.invoke('get-active-preset-id', profileId),
  getActivePreset: (profileId: string) => ipcRenderer.invoke('get-active-preset', profileId),
  getPreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('get-preset', profileId, presetId),
  setActivePreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('set-active-preset', profileId, presetId),
  createPreset: (profileId: string, name: string) =>
    ipcRenderer.invoke('create-preset', profileId, name),
  savePreset: (profileId: string, presetId: string, preset: any) =>
    ipcRenderer.invoke('save-preset', profileId, presetId, preset),
  deletePreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('delete-preset', profileId, presetId),
  importPresetDialog: (profileId: string) => ipcRenderer.invoke('import-preset-dialog', profileId),
  // Lorebook library (id-keyed; a character's own lorebook has id == characterId)
  listLorebooks: (profileId: string) => ipcRenderer.invoke('list-lorebooks', profileId),
  getLorebook: (profileId: string, id: string) =>
    ipcRenderer.invoke('get-lorebook', profileId, id),
  saveLorebook: (profileId: string, id: string, lorebook: any) =>
    ipcRenderer.invoke('save-lorebook', profileId, id, lorebook),
  createLorebook: (profileId: string, name: string) =>
    ipcRenderer.invoke('create-lorebook', profileId, name),
  deleteLorebook: (profileId: string, id: string) =>
    ipcRenderer.invoke('delete-lorebook', profileId, id),
  importLorebookDialog: (profileId: string) =>
    ipcRenderer.invoke('import-lorebook-dialog', profileId),
  exportLorebookDialog: (profileId: string, id: string, name: string) =>
    ipcRenderer.invoke('export-lorebook-dialog', profileId, id, name),
  getChatLorebooks: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-chat-lorebooks', profileId, chatId),
  setChatLorebooks: (profileId: string, chatId: string, ids: string[] | null) =>
    ipcRenderer.invoke('set-chat-lorebooks', profileId, chatId, ids),
  getChatMode: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-chat-mode', profileId, chatId),
  setChatMode: (profileId: string, chatId: string, mode: string) =>
    ipcRenderer.invoke('set-chat-mode', profileId, chatId, mode),
  // TH-2 swipes
  setActiveSwipe: (profileId: string, chatId: string, floorIndex: number, swipeId: number) =>
    ipcRenderer.invoke('set-active-swipe', profileId, chatId, floorIndex, swipeId),
  generateSwipe: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('generate-swipe', profileId, chatId),
  // Card-script runtime (P1)
  pluginVars: (profileId: string, chatId: string, action: any) =>
    ipcRenderer.invoke('plugin-vars', profileId, chatId, action),
  pluginGetVars: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('plugin-get-vars', profileId, chatId),
  pluginGetMessages: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('plugin-get-messages', profileId, chatId),
  pluginSetMessage: (profileId: string, chatId: string, floorIndex: number, patch: any) =>
    ipcRenderer.invoke('plugin-set-message', profileId, chatId, floorIndex, patch),
  pluginDeleteMessages: (profileId: string, chatId: string, fromIndex: number) =>
    ipcRenderer.invoke('plugin-delete-messages', profileId, chatId, fromIndex),
  pluginCreateMessage: (profileId: string, chatId: string, msg: any) =>
    ipcRenderer.invoke('plugin-create-message', profileId, chatId, msg),
  // TH-4 generation control
  generateRaw: (profileId: string, chatId: string, config: any) =>
    ipcRenderer.invoke('generate-raw', profileId, chatId, config),
  generateImage: (profileId: string, prompt: string) =>
    ipcRenderer.invoke('generate-image', profileId, prompt),
  // TH-3 read/CRUD API
  scriptCardData: (profileId: string, chatId: string, cardId?: string) =>
    ipcRenderer.invoke('script-card-data', profileId, chatId, cardId),
  scriptCardAvatar: (profileId: string, chatId: string, cardId?: string) =>
    ipcRenderer.invoke('script-card-avatar', profileId, chatId, cardId),
  scriptWorldbookList: (profileId: string) => ipcRenderer.invoke('script-worldbook-list', profileId),
  scriptWorldbookGet: (profileId: string, chatId: string, id?: string, cardId?: string) =>
    ipcRenderer.invoke('script-worldbook-get', profileId, chatId, id, cardId),
  scriptWorldbookSet: (
    profileId: string,
    chatId: string,
    id: string | undefined,
    entries: any,
    cardId?: string
  ) => ipcRenderer.invoke('script-worldbook-set', profileId, chatId, id, entries, cardId),
  scriptPresetGet: (profileId: string) => ipcRenderer.invoke('script-preset-get', profileId),
  scriptPresetList: (profileId: string) => ipcRenderer.invoke('script-preset-list', profileId),
  scriptRegexFormat: (profileId: string, ctx: any, text: string, macroCtx?: any) =>
    ipcRenderer.invoke('script-regex-format', profileId, ctx, text, macroCtx),
  scriptRegexList: (profileId: string, ctx?: any) =>
    ipcRenderer.invoke('script-regex-list', profileId, ctx),
  scriptFetchText: (profileId: string, cardId: string | undefined, url: string) =>
    ipcRenderer.invoke('script-fetch-text', profileId, cardId, url),
  scriptFetchModuleGraph: (profileId: string, cardId: string | undefined, urls: string[]) =>
    ipcRenderer.invoke('script-fetch-module-graph', profileId, cardId, urls),
  pluginGetGrants: (profileId: string, cardId: string) =>
    ipcRenderer.invoke('plugin-get-grants', profileId, cardId),
  pluginSetGrants: (profileId: string, cardId: string, patch: any) =>
    ipcRenderer.invoke('plugin-set-grants', profileId, cardId, patch),
  pluginLog: (label: string, message: string) => ipcRenderer.invoke('plugin-log', label, message),
  // Plugin host/loader (P2)
  pluginsList: (profileId: string) => ipcRenderer.invoke('plugins-list', profileId),
  pluginsInstallDialog: () => ipcRenderer.invoke('plugins-install-dialog'),
  pluginsInstallZipDialog: () => ipcRenderer.invoke('plugins-install-zip-dialog'),
  pluginsUninstall: (profileId: string, id: string) =>
    ipcRenderer.invoke('plugins-uninstall', profileId, id),
  pluginsSetEnabled: (profileId: string, id: string, enabled: boolean, grants?: string[]) =>
    ipcRenderer.invoke('plugins-set-enabled', profileId, id, enabled, grants),
  pluginsSetGrants: (profileId: string, id: string, grants: string[]) =>
    ipcRenderer.invoke('plugins-set-grants', profileId, id, grants),
  pluginsScaffoldExample: () => ipcRenderer.invoke('plugins-scaffold-example'),
  pluginStorage: (profileId: string, owner: string, action: any) =>
    ipcRenderer.invoke('plugin-storage', profileId, owner, action),
  pluginNetFetch: (pluginId: string, url: string, opts: any) =>
    ipcRenderer.invoke('plugin-net-fetch', pluginId, url, opts),
  // Subscribe to incremental generation text. Returns an unsubscribe function.
  onGenerationDelta: (cb: (payload: { chatId: string; delta: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string; delta: string }) =>
      cb(payload)
    ipcRenderer.on('generation-delta', listener)
    return () => ipcRenderer.removeListener('generation-delta', listener)
  },
  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  // Regex
  getRenderRegex: (profileId: string, ctx?: { cardId?: string | null; chatId?: string | null }) =>
    ipcRenderer.invoke('get-render-regex', profileId, ctx),
  listRegex: (profileId: string) => ipcRenderer.invoke('list-regex', profileId),
  deleteRegex: (profileId: string, file: string) =>
    ipcRenderer.invoke('delete-regex', profileId, file),
  setRegexScope: (profileId: string, file: string, scope: string, owner?: string) =>
    ipcRenderer.invoke('regex-set-scope', profileId, file, scope, owner),
  setRegexDisabled: (profileId: string, file: string, disabled: boolean) =>
    ipcRenderer.invoke('regex-set-disabled', profileId, file, disabled),
  // Scripts library
  listScripts: (profileId: string) => ipcRenderer.invoke('list-scripts', profileId),
  getScript: (profileId: string, file: string) => ipcRenderer.invoke('get-script', profileId, file),
  saveScript: (profileId: string, script: any, scope?: string, owner?: string) =>
    ipcRenderer.invoke('save-script', profileId, script, scope, owner),
  updateScript: (profileId: string, file: string, patch: any) =>
    ipcRenderer.invoke('update-script', profileId, file, patch),
  setScriptScope: (profileId: string, file: string, scope: string, owner?: string) =>
    ipcRenderer.invoke('script-set-scope', profileId, file, scope, owner),
  setScriptDisabled: (profileId: string, file: string, disabled: boolean) =>
    ipcRenderer.invoke('script-set-disabled', profileId, file, disabled),
  deleteScript: (profileId: string, file: string) =>
    ipcRenderer.invoke('delete-script', profileId, file),
  importScriptDialog: (profileId: string, scope?: string, owner?: string) =>
    ipcRenderer.invoke('import-script-dialog', profileId, scope, owner),
  getRuntimeScripts: (profileId: string, cardId: string | null, chatId: string | null) =>
    ipcRenderer.invoke('get-runtime-scripts', profileId, cardId, chatId),
  getRegexRules: (profileId: string, file: string) =>
    ipcRenderer.invoke('regex-script-rules', profileId, file),
  updateRegexRule: (profileId: string, file: string, index: number, patch: any) =>
    ipcRenderer.invoke('regex-update-rule', profileId, file, index, patch),
  importRegexDialog: (profileId: string) => ipcRenderer.invoke('import-regex-dialog', profileId),
  onLog: (cb: (entry: any) => void) => {
    const listener = (_e: IpcRendererEvent, entry: any) => cb(entry)
    ipcRenderer.on('log-event', listener)
    return () => ipcRenderer.removeListener('log-event', listener)
  },
  // A WebContentsView card panel wrote variables → refresh the host's native panels.
  onWcvHostVars: (cb: (payload: { chatId: string; variables: unknown }) => void) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { chatId: string; variables: unknown }
    ): void => cb(payload)
    ipcRenderer.on('wcv-host-vars', listener)
    return () => ipcRenderer.removeListener('wcv-host-vars', listener)
  },
  // A card panel asked to set the chat input box (onboarding finish "inject prompt").
  onWcvHostInput: (cb: (payload: { chatId: string; text: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string; text: string }): void =>
      cb(payload)
    ipcRenderer.on('wcv-host-input', listener)
    return () => ipcRenderer.removeListener('wcv-host-input', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
