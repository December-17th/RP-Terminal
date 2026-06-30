import { IpcMain } from 'electron'
import * as duelService from '../services/duelService'
import * as logService from '../services/logService'

/** Interactive STS duel IPC. One active duel per chat; the renderer DuelView drives these.
 *  `profileId` is accepted for parity with the other domains; the duel is keyed by chatId. */
export const registerDuelIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('duel-get', (_, _profileId, chatId) => duelService.getDuel(chatId))
  // Debug: spin up a hardcoded duel (no card/AI) for in-app testing.
  ipcMain.handle('duel-start-mock', (_, _profileId, chatId) => duelService.startMockDuel(chatId))
  ipcMain.handle('duel-start', (_, profileId, chatId, characterId) =>
    duelService.startDuelFromMvu(profileId, chatId, characterId)
  )
  ipcMain.handle('duel-play', (_, _profileId, chatId, cardId, targetIds) => {
    try {
      return duelService.playDuelCard(chatId, String(cardId), (targetIds as string[]) ?? [])
    } catch (err: any) {
      logService.log('error', '✗ duel-play failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('duel-end-turn', (_, _profileId, chatId) => duelService.endDuelTurn(chatId))
  ipcMain.handle('duel-end', (_, _profileId, chatId) => duelService.endDuel(chatId))
}
