import { IpcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import * as saveTransferService from '../services/saveTransferService'
import { gate } from './ipcGuards'

/** Export / import a single save (session) as a `.rpsave` zip (Feature 2). Mirrors the other
 *  export-dialog IPCs (characterIpc/worldAssetIpc): the service builds the bytes, the handler drives
 *  the native file dialog + host-path write. Both are GATED (arbitrary host-path read/write). */
export const registerSaveTransferIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    'export-save-dialog',
    gate('export-save-dialog', async (event, profileId: string, chatId: string) => {
      const built = saveTransferService.buildSaveZip(profileId, chatId)
      if ('error' in built) return built // { error } — renderer shows the reason (e.g. memory busy)
      const win = BrowserWindow.fromWebContents(event.sender)!
      const result = await dialog.showSaveDialog(win, {
        defaultPath: `${built.name}.rpsave`,
        filters: [{ name: 'RP Terminal Save', extensions: ['rpsave'] }]
      })
      if (result.canceled || !result.filePath) return null
      fs.writeFileSync(result.filePath, built.buffer)
      return { name: built.name }
    })
  )

  ipcMain.handle(
    'import-save-dialog',
    gate('import-save-dialog', async (event, profileId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const pick = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'RP Terminal Save', extensions: ['rpsave', 'zip'] }]
      })
      if (pick.canceled || !pick.filePaths[0]) return null
      return saveTransferService.importSave(profileId, pick.filePaths[0])
    })
  )
}
