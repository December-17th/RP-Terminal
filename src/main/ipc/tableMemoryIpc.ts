import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as tableTemplateService from '../services/tableTemplateService'
import * as tableDbService from '../services/tableDbService'
import * as chatService from '../services/chatService'

/**
 * IPC for SQL-table memory (issue 02): file-based table templates, per-chat assignment (which
 * instantiates/removes the sandbox DB), and a read-only projection of a chat's tables. Import
 * surfaces parser errors as `{ error }` rather than throwing across IPC (mirrors how
 * tableTemplateService returns import results); the renderer localizes/toasts them.
 */
export const registerTableMemoryIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('table-templates-list', (_, profileId) =>
    tableTemplateService.listTableTemplates(profileId)
  )
  ipcMain.handle('table-template-get', (_, profileId, id) =>
    tableTemplateService.getTableTemplateById(profileId, id)
  )
  ipcMain.handle('table-template-delete', (_, profileId, id) => {
    tableTemplateService.deleteTableTemplate(profileId, id)
    // Any chat that had it assigned loses its sandbox too.
    chatService.removeTableTemplateIdFromChats(profileId, id)
  })
  ipcMain.handle('table-template-import-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'Table Template', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return tableTemplateService.importTableTemplateFromFile(profileId, result.filePaths[0])
  })

  // Per-chat assignment. Setting a new id (re)instantiates the sandbox; null removes it (both
  // destructive — the renderer confirms first).
  ipcMain.handle('chat-table-template-get', (_, profileId, chatId) =>
    chatService.getChatTableTemplateId(profileId, chatId)
  )
  ipcMain.handle('chat-table-template-set', (_, profileId, chatId, id) =>
    chatService.setChatTableTemplateId(profileId, chatId, id)
  )

  // Read-only: every table of the chat's assigned template, with current rows (v1 = header/initial).
  ipcMain.handle('chat-tables-read', (_, profileId, chatId) => {
    const id = chatService.getChatTableTemplateId(profileId, chatId)
    if (!id) return []
    const template = tableTemplateService.getTableTemplateById(profileId, id)
    if (!template) return []
    return tableDbService.readAllTables(profileId, chatId, template)
  })
}
