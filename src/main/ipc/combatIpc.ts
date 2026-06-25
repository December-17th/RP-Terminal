import { IpcMain } from 'electron'
import * as combatService from '../services/combatService'
import * as logService from '../services/logService'

/**
 * Combat IPC (Track Combat / P4). One active encounter per chat; the renderer's
 * CombatView (P5) drives these. `profileId` is accepted for signature parity with
 * the other domains but combat is keyed by `chatId`.
 */
export const registerCombatIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('combat-start', (_, _profileId, chatId, setup) =>
    combatService.startEncounter(chatId, setup)
  )
  ipcMain.handle('combat-get', (_, _profileId, chatId) => combatService.getEncounterState(chatId))
  ipcMain.handle('combat-action', async (_, _profileId, chatId, action) => {
    try {
      return await combatService.applyPlayerAction(chatId, action)
    } catch (err: any) {
      logService.log('error', '✗ combat-action failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('combat-end-turn', (_, _profileId, chatId) => combatService.endTurn(chatId))
  ipcMain.handle('combat-enemy-turn', async (_, _profileId, chatId) => {
    try {
      return await combatService.runEnemyTurn(chatId)
    } catch (err: any) {
      logService.log('error', '✗ combat-enemy-turn failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('combat-end', (_, _profileId, chatId) => combatService.endEncounter(chatId))
  ipcMain.handle('combat-clear', (_, _profileId, chatId) => combatService.clearEncounter(chatId))
}
