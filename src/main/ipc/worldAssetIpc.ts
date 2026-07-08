import { IpcMain, BrowserWindow, dialog } from 'electron'
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
  ipcMain.handle(
    'asset-import-zip-dialog',
    async (event, profileId: string, lorebookId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const pick = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Asset Zip', extensions: ['zip'] }]
      })
      if (pick.canceled || !pick.filePaths[0]) return null
      return svc.importAssetsZip(profileId, lorebookId, pick.filePaths[0])
    }
  )
  // ── Manager surface (WA-2) ──────────────────────────────────────────────────────────────────
  ipcMain.handle('asset-list-index', (_e, profileId: string, lorebookIds: string[]) =>
    svc.getMergedIndex(profileId, lorebookIds)
  )
  ipcMain.handle(
    'asset-import-files',
    (_e, profileId: string, lorebookId: string, items: svc.ImportFileItem[]) =>
      svc.importAssetFiles(profileId, lorebookId, items)
  )
  ipcMain.handle(
    'asset-delete-file',
    (_e, profileId: string, lorebookId: string, category: AssetCategory, file: string) =>
      svc.deleteAssetFile(profileId, lorebookId, category, file)
  )
  ipcMain.handle(
    'asset-rename-variant',
    (
      _e,
      profileId: string,
      lorebookId: string,
      category: AssetCategory,
      file: string,
      newVariant: string
    ) => svc.renameAssetVariant(profileId, lorebookId, category, file, newVariant)
  )
  // Pick image files via the OS dialog → return their absolute paths (fed to asset-import-files).
  // Backs the view's 导入 button + the drawer's 替换/＋ tile actions (drag-drop is the other route).
  ipcMain.handle('asset-pick-images', async (event, multi: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const pick = await dialog.showOpenDialog(win, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (pick.canceled) return []
    return pick.filePaths
  })
  ipcMain.handle('asset-export-zip', async (event, profileId: string, lorebookId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const pick = await dialog.showSaveDialog(win, {
      defaultPath: `${lorebookId}-assets.zip`,
      filters: [{ name: 'Asset Zip', extensions: ['zip'] }]
    })
    if (pick.canceled || !pick.filePath) return null
    return svc.exportAssetsZip(profileId, lorebookId, pick.filePath)
  })
}
