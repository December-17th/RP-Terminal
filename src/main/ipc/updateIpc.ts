import { app, IpcMain, shell } from 'electron'
import { getAppDir } from '../services/storageService'
import { createUpdateNotifier, type UpdateNotifier } from '../services/updateNotifier'
import { gate } from './ipcGuards'

const defaultNotifier = createUpdateNotifier({
  isPackaged: () => app.isPackaged,
  getVersion: () => app.getVersion(),
  dataDir: getAppDir,
  openExternal: (url) => shell.openExternal(url),
  warn: (message, error) => console.warn(`[update notifier] ${message}`, error)
})

export const registerUpdateIpc = (
  ipcMain: IpcMain,
  notifier: UpdateNotifier = defaultNotifier
): void => {
  ipcMain.handle(
    'check-for-update',
    gate('check-for-update', () => notifier.check())
  )
  ipcMain.handle(
    'open-update-release',
    gate('open-update-release', () => notifier.openRelease())
  )
}
