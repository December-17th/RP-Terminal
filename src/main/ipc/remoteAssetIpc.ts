import type { IpcMain } from 'electron'
import { listRemoteAssets, resolveRemoteAssetUrl } from '../services/remoteAssetService'
import { REMOTE_ASSET_KINDS, type RemoteAssetKind } from '../../shared/worldAssets/remote'

/** Renderer input is untrusted: an unrecognised kind degrades to the pre-M2 default rather than
 *  reaching the resolver, which would treat it as an unknown bag. */
const asKind = (value: unknown): RemoteAssetKind =>
  REMOTE_ASSET_KINDS.includes(value as RemoteAssetKind) ? (value as RemoteAssetKind) : 'character'

export const registerRemoteAssetIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('remote-asset-list', (_event, profileId: string, chatId: string) =>
    listRemoteAssets(String(profileId ?? ''), String(chatId ?? ''))
  )
  ipcMain.handle(
    'remote-asset-url',
    (_event, profileId: string, chatId: string, name: string, kind?: unknown) =>
      resolveRemoteAssetUrl(
        String(profileId ?? ''),
        String(chatId ?? ''),
        String(name ?? ''),
        asKind(kind)
      )
  )
}
