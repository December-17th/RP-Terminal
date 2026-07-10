import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as workflowService from '../services/workflowService'
import * as chatService from '../services/chatService'
import { listNodeTypes } from '../services/nodes/catalog'
import {
  getModuleTemplate,
  listModuleTemplates,
  saveModuleToLibrary
} from '../services/moduleTemplates'
import { getLorePicks, setLorePicks, type LorePick } from '../services/workflowLorePicksStore'
import type { ModulePayload } from '../../shared/workflow/moduleEnvelope'
import { gate } from './ipcGuards'

export const registerWorkflowIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('list-node-types', () => listNodeTypes())
  // Agent & memory UX WP-H (spec §7): per-world lorebook picks for agent.llm's custom lore mode.
  // Keyed (worldId = chat.character_id, docId, nodeId); the store sanitizes what it reads/writes.
  ipcMain.handle(
    'get-lore-picks',
    (_, profileId: string, worldId: string, docId: string, nodeId: string) =>
      getLorePicks(profileId, worldId, docId, nodeId)
  )
  ipcMain.handle(
    'set-lore-picks',
    (_, profileId: string, worldId: string, docId: string, nodeId: string, picks: LorePick[]) =>
      setLorePicks(profileId, worldId, docId, nodeId, picks)
  )
  // Agent library (agent-memory-ux WP-G; spec §2): the palette's Agent-library section. Templates are
  // ModulePayloads — the renderer inserts them through the SAME insertModule path a `.rptmodule`
  // import uses. save-module-to-library re-validates main-side (never trusts the renderer payload).
  ipcMain.handle('list-module-templates', (_, profileId: string) => listModuleTemplates(profileId))
  ipcMain.handle('get-module-template', (_, profileId: string, id: string) =>
    getModuleTemplate(profileId, id)
  )
  ipcMain.handle('save-module-to-library', (_, profileId: string, module: ModulePayload) =>
    saveModuleToLibrary(profileId, module)
  )
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
  ipcMain.handle('create-workflow', (_, profileId, kind) =>
    workflowService.createWorkflow(profileId, kind)
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
  // GATED: native file picker (import from an arbitrary host path).
  ipcMain.handle('import-workflow-dialog', gate('import-workflow-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'RPT Workflow', extensions: ['rptflow', 'json'] }]
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return workflowService.importWorkflowFromFile(profileId, result.filePaths[0])
    }
    return null
  }))
  // GATED: native save dialog writing to an arbitrary host path.
  ipcMain.handle('export-workflow-dialog', gate('export-workflow-dialog', async (event, profileId, id, name) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${name || id}.rptflow`,
      filters: [{ name: 'RPT Workflow', extensions: ['rptflow'] }]
    })
    if (result.canceled || !result.filePath) return false
    return workflowService.exportWorkflowToFile(profileId, id, result.filePath)
  }))
}
