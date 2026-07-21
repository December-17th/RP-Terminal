import { IpcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { getAppDir } from '../services/storageService'
import { readLocationPointer, writeLocationPointer } from '../services/locationPointer'
import { gate } from './ipcGuards'
import { appExitGuard, runShutdownCleanup } from '../appExit'

export const registerStorageIpc = (ipcMain: IpcMain): void => {
  // Read-only: safe for any frame (no data-location mutation / no host reach).
  ipcMain.handle('get-data-location', () => ({
    path: getAppDir(),
    pointer: readLocationPointer()?.dataDir ?? null,
    envOverride: process.env.RPT_DATA_DIR ?? null
  }))

  ipcMain.handle(
    'set-data-location-dialog',
    gate('set-data-location-dialog', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const pick = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory']
      })
      if (pick.canceled || !pick.filePaths[0]) return null
      writeLocationPointer(pick.filePaths[0])
      return pick.filePaths[0]
    })
  )

  ipcMain.handle(
    'open-data-location',
    gate('open-data-location', () => shell.openPath(getAppDir()))
  )

  ipcMain.handle(
    'reset-data-location',
    gate('reset-data-location', () => {
      writeLocationPointer(null)
      return true
    })
  )

  ipcMain.handle(
    'restart-app',
    // `app.exit(0)` terminates immediately: it emits neither `before-quit` nor `will-quit`, so this
    // path used to discard in-flight work with no warning AND skip shutdown cleanup entirely. It now
    // asks the SAME exit guard (shared latch — no stacked dialog if a quit prompt is already open)
    // and, once cleared, runs the same cleanup explicitly before terminating. With nothing running,
    // confirmExit() short-circuits and the restart behaves exactly as it did before.
    gate('restart-app', async () => {
      if (!(await appExitGuard.confirmExit())) return false
      runShutdownCleanup()
      try {
        app.relaunch()
        app.exit(0)
        return true
      } finally {
        // `app.exit(0)` does not return, so this runs ONLY if relaunch/exit threw. The app is then
        // still alive with the latch armed, which would silently skip the next quit's confirmation —
        // disarm it. `gate` does not catch, so the rejection still surfaces to the renderer.
        appExitGuard.releaseConfirmation()
      }
    })
  )
}
