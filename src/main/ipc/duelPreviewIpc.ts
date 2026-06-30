// src/main/ipc/duelPreviewIpc.ts
//
// Inline-transport IPC for the getDuelPreview host API. Mirrors the shape of
// worldAssetIpc (value-returning, computed in main from the calling card's context).
import { ipcMain } from 'electron'
import { computeDuelPreview } from '../services/duelPreviewService'

export function registerDuelPreviewIpc(): void {
  ipcMain.handle(
    'duel-preview',
    (_e, profileId: string, chatId: string, characterId: string) =>
      computeDuelPreview(profileId, chatId, characterId)
  )
}
