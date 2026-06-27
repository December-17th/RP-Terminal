import { IpcMain } from 'electron'
import * as svc from '../services/worldAssetService'
import { ASSET_SCHEME } from '../services/worldAssetProtocol'
import { AssetCategory, AssetType } from '../../shared/worldAssets/types'

/** rptasset://<profileId>/<lorebookId>/<category>/<encoded file> */
export function assetUrlFor(
  profileId: string,
  lorebookId: string,
  category: string,
  file: string
): string {
  return `${ASSET_SCHEME}://${profileId}/${lorebookId}/${category}/${encodeURIComponent(file)}`
}

export const registerWorldAssetIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    'asset-coverage',
    (_e, profileId: string, lorebookIds: string[], category: AssetCategory, roster: string[]) =>
      svc.listCoverage(profileId, lorebookIds, category, roster)
  )
  ipcMain.handle(
    'asset-url',
    (
      _e,
      profileId: string,
      lorebookIds: string[],
      category: AssetCategory,
      name: string,
      type: AssetType,
      mood?: string
    ) => {
      const hit = svc.resolveAssetFile(profileId, lorebookIds, category, name, type, mood)
      if (!hit) return null
      const file = hit.absPath.split(/[\\/]/).pop() as string
      return assetUrlFor(profileId, hit.lorebookId, category, file)
    }
  )
  ipcMain.handle('asset-refresh', (_e, profileId: string, lorebookIds: string[]) => {
    for (const id of lorebookIds) svc.getIndex(profileId, id, { refresh: true })
  })
  ipcMain.handle(
    'asset-open-folder',
    (_e, profileId: string, lorebookId: string, category: AssetCategory) =>
      svc.openAssetsFolder(profileId, lorebookId, category)
  )
}
