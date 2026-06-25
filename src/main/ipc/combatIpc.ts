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
  ipcMain.handle('combat-start-from-card', (_, profileId, chatId, cue) => {
    try {
      return combatService.startFromCard(profileId, chatId, cue)
    } catch (err: any) {
      logService.log('error', '✗ combat-start-from-card failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('combat-get', (_, _profileId, chatId) => combatService.getEncounter(chatId))
  // Debug: spin up a hardcoded encounter (no card/AI needed) for in-app testing.
  ipcMain.handle('combat-start-mock', (_, _profileId, chatId) =>
    combatService.startMockEncounter(chatId)
  )
  ipcMain.handle('combat-action', async (_, _profileId, chatId, action) => {
    try {
      return await combatService.applyPlayerAction(chatId, action)
    } catch (err: any) {
      logService.log('error', '✗ combat-action failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('combat-end-turn', (_, _profileId, chatId) => combatService.endTurn(chatId))
  ipcMain.handle('combat-enemy-turn', async (_, profileId, chatId) => {
    try {
      return await combatService.runEnemyTurn(profileId, chatId)
    } catch (err: any) {
      logService.log('error', '✗ combat-enemy-turn failed', err?.message || String(err))
      throw err
    }
  })
  // AI touchpoints (P6): adjudicate a freeform action; narrate the resolved fight.
  ipcMain.handle('combat-adjudicate', async (_, profileId, chatId, prose) => {
    try {
      return await combatService.adjudicate(profileId, chatId, String(prose ?? ''))
    } catch (err: any) {
      logService.log('error', '✗ combat-adjudicate failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('combat-narrate', async (_, profileId, chatId) => {
    try {
      return await combatService.narrate(profileId, chatId)
    } catch (err: any) {
      logService.log('error', '✗ combat-narrate failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('combat-narration-prompt', (_, _profileId, chatId) =>
    combatService.narrationPrompt(chatId)
  )
  ipcMain.handle('combat-end', (_, _profileId, chatId) => combatService.endEncounter(chatId))
  ipcMain.handle('combat-clear', (_, _profileId, chatId) => combatService.clearEncounter(chatId))
}
