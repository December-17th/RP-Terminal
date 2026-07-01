import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as workflowService from '../services/workflowService'
import * as chatService from '../services/chatService'
import { listNodeTypes } from '../services/nodes/catalog'

export const registerWorkflowIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('list-node-types', () => listNodeTypes())
  ipcMain.handle('list-workflows', (_, profileId) => workflowService.listWorkflows(profileId))
  ipcMain.handle('get-workflow', (_, profileId, id) =>
    workflowService.getWorkflowById(profileId, id)
  )
  ipcMain.handle('save-workflow', (_, profileId, id, doc) =>
    workflowService.saveWorkflow(profileId, id, doc)
  )
  ipcMain.handle('clone-workflow', (_, profileId, sourceId) =>
    workflowService.cloneWorkflow(profileId, sourceId)
  )
  ipcMain.handle('delete-workflow', (_, profileId, id) =>
    workflowService.deleteWorkflow(profileId, id)
  )
  ipcMain.handle('get-workflow-selection', (_, profileId) =>
    workflowService.getSelection(profileId)
  )
  ipcMain.handle('set-global-workflow', (_, profileId, id) =>
    workflowService.setGlobalWorkflow(profileId, id)
  )
  ipcMain.handle('set-world-workflow', (_, profileId, characterId, id) =>
    workflowService.setWorldWorkflow(profileId, characterId, id)
  )
  ipcMain.handle('get-chat-workflow', (_, profileId, chatId) =>
    chatService.getChatWorkflowId(profileId, chatId)
  )
  ipcMain.handle('set-chat-workflow', (_, profileId, chatId, id) =>
    chatService.setChatWorkflowId(profileId, chatId, id)
  )
  ipcMain.handle('resolve-workflow-id', (_, profileId, chatId) =>
    workflowService.resolveWorkflowId(profileId, chatId)
  )
  ipcMain.handle('import-workflow-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'RPT Workflow', extensions: ['rptflow', 'json'] }]
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return workflowService.importWorkflowFromFile(profileId, result.filePaths[0])
    }
    return null
  })
  ipcMain.handle('export-workflow-dialog', async (event, profileId, id, name) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${name || id}.rptflow`,
      filters: [{ name: 'RPT Workflow', extensions: ['rptflow'] }]
    })
    if (result.canceled || !result.filePath) return false
    return workflowService.exportWorkflowToFile(profileId, id, result.filePath)
  })
}
