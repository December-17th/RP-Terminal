/** Minimal Electron stub for vitest — just enough for main-process modules to import. */
export const app = {
  getPath: (): string => '/tmp/rpt-test'
}

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  fromWebContents: (): null => null
}

export const ipcMain = { handle: (): void => {} }
export const dialog = {}
export const shell = {}
export const contextBridge = { exposeInMainWorld: (): void => {} }
export const ipcRenderer = {
  invoke: async (): Promise<void> => {},
  on: (): void => {},
  removeListener: (): void => {}
}

export default { app, BrowserWindow, ipcMain, dialog, shell, contextBridge, ipcRenderer }
