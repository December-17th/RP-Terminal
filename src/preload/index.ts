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
  getFloor: (profileId: string, chatId: string, floorIndex: number) => ipcRenderer.invoke('get-floor', profileId, chatId, floorIndex),
  saveFloor: (profileId: string, chatId: string, floor: any) => ipcRenderer.invoke('save-floor', profileId, chatId, floor),
  apiComplete: (settings: any, messages: any[]) => ipcRenderer.invoke('api-complete', settings, messages)
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
