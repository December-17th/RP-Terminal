import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as lorebookService from '../services/lorebookService'
import * as chatService from '../services/chatService'

export const registerLorebookIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('list-lorebooks', (_, profileId) => lorebookService.listLorebooks(profileId))
  ipcMain.handle('get-lorebook', (_, profileId, id) =>
    lorebookService.getLorebookById(profileId, id)
  )
  ipcMain.handle('save-lorebook', (_, profileId, id, lorebook) => {
    const result = lorebookService.saveLorebookById(profileId, id, lorebook)
    // A book changed — drop the per-session L2 cache so edits show up next turn.
    chatService.clearWorldInfoCacheForProfile(profileId)
    return result
  })
  ipcMain.handle('create-lorebook', (_, profileId, name) =>
    lorebookService.createLorebook(profileId, name)
  )
  ipcMain.handle('delete-lorebook', (_, profileId, id) => {
    lorebookService.deleteLorebookById(profileId, id)
    // Drop the deleted book from any session that still references it.
    chatService.removeLorebookIdFromChats(profileId, id)
  })
  ipcMain.handle('import-lorebook-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'Lorebook / World Info', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return lorebookService.importLorebookFromFile(profileId, result.filePaths[0])
  })
  ipcMain.handle('export-lorebook-dialog', async (event, profileId, id, name) => {
    const safeName = String(name || 'lorebook').replace(/[^\w.-]+/g, '_')
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'Lorebook', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    return lorebookService.exportLorebookToFile(profileId, id, result.filePath)
  })
}
