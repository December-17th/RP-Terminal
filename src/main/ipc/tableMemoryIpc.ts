import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as tableTemplateService from '../services/tableTemplateService'
import * as tableDbService from '../services/tableDbService'
import * as chatService from '../services/chatService'
import { applyEdit, TableEditOp } from '../services/tableEditService'
import { getTablesStatus } from '../services/tableStatusService'
import { templateSqlNames } from '../services/tableDbService'

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

  // Read: every table of the chat's assigned template, with current rows + per-row rowids (issue 06).
  ipcMain.handle('chat-tables-read', (_, profileId, chatId) => {
    const id = chatService.getChatTableTemplateId(profileId, chatId)
    if (!id) return []
    const template = tableTemplateService.getTableTemplateById(profileId, id)
    if (!template) return []
    return tableDbService.readAllTables(profileId, chatId, template)
  })

  // Hand edit (issue 06): a cell edit / row add / row delete / table reset. The renderer sends only a
  // column INDEX for cell edits; main maps it → the REAL sandbox column name (never a renderer-
  // supplied name), then routes through `applyEdit` (the SAME op-logged write path as AI writes).
  // Returns `{ ok, changes } | { error }` — the error string is the SQLite/validation message the
  // renderer toasts. `columnIndex` is validated against the sandbox's column list.
  ipcMain.handle(
    'chat-tables-edit',
    (
      _,
      profileId: string,
      chatId: string,
      edit: {
        kind: 'cell' | 'insert' | 'delete' | 'reset'
        table: string
        rowid?: number
        columnIndex?: number
        value?: string
        values?: (string | null)[]
      }
    ) => {
      const id = chatService.getChatTableTemplateId(profileId, chatId)
      if (!id) return { error: 'tables.editNoTemplate' }
      const template = tableTemplateService.getTableTemplateById(profileId, id)
      if (!template) return { error: 'tables.editNoTemplate' }
      // The target table must be a registered template table (the same allowlist AI writes use).
      if (!templateSqlNames(template).has(edit.table)) {
        return { error: 'tables.editUnknownTable' }
      }

      const op: TableEditOp = { kind: edit.kind, table: edit.table }
      if (edit.kind === 'cell') {
        const cols = tableDbService.sandboxColumns(profileId, chatId, edit.table)
        const idx = edit.columnIndex
        if (idx == null || idx < 0 || idx >= cols.length) {
          return { error: 'tables.editBadColumn' }
        }
        op.column = cols[idx] // the REAL column name, resolved from the index main-side
        op.rowid = edit.rowid
        op.value = edit.value ?? ''
      } else if (edit.kind === 'insert') {
        op.values = edit.values ?? []
      } else if (edit.kind === 'delete') {
        op.rowid = edit.rowid
      }
      return applyEdit(profileId, chatId, template, op)
    }
  )

  // Last-maintained-floor per table (issue 06): merged from every table.gate node's durable state in
  // the chat's resolved workflow. Best-effort → `{}` on any failure.
  ipcMain.handle('chat-tables-status', (_, profileId, chatId) =>
    getTablesStatus(profileId, chatId)
  )

  // Export the chat's (or a stored) template back to chatSheets v2 JSON behind a save dialog (issue
  // 06). `chatId` present = export WITH that chat's current data as initial rows. Mirrors the
  // workflow export-dialog precedent (workflowIpc `export-workflow-dialog`).
  ipcMain.handle(
    'table-template-export-dialog',
    async (event, profileId: string, templateId: string, chatId?: string | null) => {
      const template = tableTemplateService.getTableTemplateById(profileId, templateId)
      const defaultName = (template?.name || templateId).replace(/[\\/:*?"<>|]/g, '_')
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        defaultPath: `${defaultName}.json`,
        filters: [{ name: 'Table Template', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return false
      return tableTemplateService.exportTableTemplateToFile(
        profileId,
        templateId,
        result.filePath,
        chatId
      )
    }
  )
}
