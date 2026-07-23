import { IpcMain } from 'electron'
import { openDebugWindow } from '../services/debugWindowService'

/** IPC for the separate Debug window (WP-D1): the TopStrip button asks main to open/focus it. */
export const registerDebugIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('open-debug-window', () => openDebugWindow())
}
