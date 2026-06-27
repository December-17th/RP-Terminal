import { IpcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { getAppDir } from '../services/storageService'
import { readLocationPointer, writeLocationPointer } from '../services/locationPointer'

export const registerStorageIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-data-location', () => ({
    path: getAppDir(),
    pointer: readLocationPointer()?.dataDir ?? null,
    envOverride: process.env.RPT_DATA_DIR ?? null
  }))

  ipcMain.handle('set-data-location-dialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const pick = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || !pick.filePaths[0]) return null
    writeLocationPointer(pick.filePaths[0])
    return pick.filePaths[0]
  })

  ipcMain.handle('open-data-location', () => shell.openPath(getAppDir()))

  ipcMain.handle('reset-data-location', () => {
    writeLocationPointer(null)
    return true
  })

  ipcMain.handle('restart-app', () => {
    app.relaunch()
    app.exit(0)
  })
}
