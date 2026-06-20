import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  createProfile: (name: string) => ipcRenderer.invoke('create-profile', name),
  getSettings: (profileId: string) => ipcRenderer.invoke('get-settings', profileId),
  saveSettings: (profileId: string, settings: any) => ipcRenderer.invoke('save-settings', profileId, settings),
  getCharacters: (profileId: string) => ipcRenderer.invoke('get-characters', profileId),
  saveCharacter: (profileId: string, charId: string, card: any) => ipcRenderer.invoke('save-character', profileId, charId, card),
  importCharacterDialog: (profileId: string) => ipcRenderer.invoke('import-character-dialog', profileId),
  getChats: (profileId: string) => ipcRenderer.invoke('get-chats', profileId),
  createChat: (profileId: string, charId: string) => ipcRenderer.invoke('create-chat', profileId, charId),
  getFloors: (profileId: string, chatId: string) => ipcRenderer.invoke('get-floors', profileId, chatId),
  generate: (profileId: string, chatId: string, userAction: string) =>
    ipcRenderer.invoke('generate', profileId, chatId, userAction),
  regenerate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('regenerate', profileId, chatId),
  deleteChat: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('delete-chat', profileId, chatId),
  deleteCharacter: (profileId: string, charId: string) =>
    ipcRenderer.invoke('delete-character', profileId, charId),
  listPresets: (profileId: string) => ipcRenderer.invoke('list-presets', profileId),
  getActivePresetId: (profileId: string) => ipcRenderer.invoke('get-active-preset-id', profileId),
  getActivePreset: (profileId: string) => ipcRenderer.invoke('get-active-preset', profileId),
  getPreset: (profileId: string, presetId: string) => ipcRenderer.invoke('get-preset', profileId, presetId),
  setActivePreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('set-active-preset', profileId, presetId),
  createPreset: (profileId: string, name: string) => ipcRenderer.invoke('create-preset', profileId, name),
  savePreset: (profileId: string, presetId: string, preset: any) =>
    ipcRenderer.invoke('save-preset', profileId, presetId, preset),
  deletePreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('delete-preset', profileId, presetId),
  importPresetDialog: (profileId: string) => ipcRenderer.invoke('import-preset-dialog', profileId),
  getLorebook: (profileId: string, charId: string) => ipcRenderer.invoke('get-lorebook', profileId, charId),
  saveLorebook: (profileId: string, charId: string, lorebook: any) =>
    ipcRenderer.invoke('save-lorebook', profileId, charId, lorebook),
  // Subscribe to incremental generation text. Returns an unsubscribe function.
  onGenerationDelta: (cb: (payload: { chatId: string; delta: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string; delta: string }) => cb(payload)
    ipcRenderer.on('generation-delta', listener)
    return () => ipcRenderer.removeListener('generation-delta', listener)
  },
  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
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
