import { contextBridge, ipcRenderer } from 'electron'
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
  getPreset: (profileId: string) => ipcRenderer.invoke('get-preset', profileId),
  savePreset: (profileId: string, preset: any) => ipcRenderer.invoke('save-preset', profileId, preset),
  importPresetDialog: (profileId: string) => ipcRenderer.invoke('import-preset-dialog', profileId),
  getLorebook: (profileId: string, charId: string) => ipcRenderer.invoke('get-lorebook', profileId, charId),
  saveLorebook: (profileId: string, charId: string, lorebook: any) =>
    ipcRenderer.invoke('save-lorebook', profileId, charId, lorebook)
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
