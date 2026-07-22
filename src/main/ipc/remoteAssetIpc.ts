import type { IpcMain } from 'electron'
import { listRemoteAssets, resolveRemoteAssetUrl } from '../services/remoteAssetService'

export const registerRemoteAssetIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('remote-asset-list', (_event, profileId: string, chatId: string) =>
    listRemoteAssets(String(profileId ?? ''), String(chatId ?? ''))
  )
  ipcMain.handle(
    'remote-asset-url',
    (_event, profileId: string, chatId: string, name: string) =>
      resolveRemoteAssetUrl(
        String(profileId ?? ''),
        String(chatId ?? ''),
        String(name ?? '')
      )
  )
}
