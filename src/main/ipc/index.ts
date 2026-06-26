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
import { registerCombatIpc } from './combatIpc'
import { registerMemoryIpc } from './memoryIpc'

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
  registerCombatIpc(ipcMain)
  registerMemoryIpc(ipcMain)
}
