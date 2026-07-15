import { IpcMain } from 'electron'
import { registerProfileIpc } from './profileIpc'
import { registerCharacterIpc } from './characterIpc'
import { registerChatIpc } from './chatIpc'
import { registerPresetIpc } from './presetIpc'
import { registerLorebookIpc } from './lorebookIpc'
import { registerRegexIpc } from './regexIpc'
import { registerScriptIpc } from './scriptIpc'
import { registerPluginIpc } from './pluginIpc'
import { registerLogIpc } from './logIpc'
import { registerWcvIpc } from './wcvIpc'
import { registerWorldAssetIpc } from './worldAssetIpc'
import { registerStorageIpc } from './storageIpc'
import { registerCombatIpc } from './combatIpc'
import { registerChatCardVarsIpc } from './chatCardVarsIpc'
import { registerDuelPreviewIpc } from './duelPreviewIpc'
import { registerDuelIpc } from './duelIpc'
import { registerWorkflowIpc } from './workflowIpc'
import { registerTableMemoryIpc } from './tableMemoryIpc'
import { registerAgentPackIpc } from './agentPackIpc'
import { registerNotesMemoryIpc } from './notesMemoryIpc'
import { registerSaveTransferIpc } from './saveTransferIpc'

/** Register every IPC handler, grouped by domain. Called once after app-ready. */
export const registerIpc = (ipcMain: IpcMain): void => {
  registerProfileIpc(ipcMain)
  registerCharacterIpc(ipcMain)
  registerChatIpc(ipcMain)
  registerPresetIpc(ipcMain)
  registerLorebookIpc(ipcMain)
  registerRegexIpc(ipcMain)
  registerScriptIpc(ipcMain)
  registerPluginIpc(ipcMain)
  registerLogIpc(ipcMain)
  registerWcvIpc(ipcMain)
  registerWorldAssetIpc(ipcMain)
  registerStorageIpc(ipcMain)
  registerCombatIpc(ipcMain)
  registerChatCardVarsIpc()
  registerDuelPreviewIpc()
  registerDuelIpc(ipcMain)
  registerWorkflowIpc(ipcMain)
  registerTableMemoryIpc(ipcMain)
  registerAgentPackIpc(ipcMain)
  registerNotesMemoryIpc(ipcMain)
  registerSaveTransferIpc(ipcMain)
}
