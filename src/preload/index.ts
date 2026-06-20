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
  getChats: (profileId: string) => ipcRenderer.invoke('get-chats', profileId),
  createChat: (profileId: string, charId: string) =>
    ipcRenderer.invoke('create-chat', profileId, charId),
  getFloors: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-floors', profileId, chatId),
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
  // Card-script runtime (P1)
  pluginVars: (profileId: string, chatId: string, action: any) =>
    ipcRenderer.invoke('plugin-vars', profileId, chatId, action),
  pluginGetVars: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('plugin-get-vars', profileId, chatId),
  pluginGetMessages: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('plugin-get-messages', profileId, chatId),
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
  getRegexRules: (profileId: string, file: string) =>
    ipcRenderer.invoke('regex-script-rules', profileId, file),
  updateRegexRule: (profileId: string, file: string, index: number, patch: any) =>
    ipcRenderer.invoke('regex-update-rule', profileId, file, index, patch),
  importRegexDialog: (profileId: string) => ipcRenderer.invoke('import-regex-dialog', profileId),
  onLog: (cb: (entry: any) => void) => {
    const listener = (_e: IpcRendererEvent, entry: any) => cb(entry)
    ipcRenderer.on('log-event', listener)
    return () => ipcRenderer.removeListener('log-event', listener)
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
