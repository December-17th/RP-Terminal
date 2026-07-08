import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as svc from '../services/worldAssetService'
import { ASSET_SCHEME } from '../services/worldAssetProtocol'
import {
  ASSET_EXTS,
  ASSET_TYPES,
  AssetCategory,
  AssetType
} from '../../shared/worldAssets/types'

/** Open the OS image picker and import the pick into the PRIMARY world (`lorebookIds[0]`) under the naming
 *  convention — the shared body of `rptHost.requestAssetImport` (WA-3), reused by both the inline and WCV
 *  handlers. Validates name/type here (rejects with null + `console.warn`, never throws into the card); the
 *  service re-validates the destination inside the assets root. Returns the new `rptasset://` URL, or null on
 *  a bad arg / no world / cancel / copy failure. `win` may be null (dialog opens without a parent then). */
export async function pickAndImportAssetForCard(
  win: BrowserWindow | null,
  profileId: string,
  lorebookIds: string[],
  name: string,
  type: string,
  variant?: string
): Promise<string | null> {
  const trimmed = (name ?? '').trim()
  if (!trimmed) {
    console.warn('[world-assets] requestAssetImport: empty name — ignored')
    return null
  }
  if (!(ASSET_TYPES as readonly string[]).includes(type)) {
    console.warn(`[world-assets] requestAssetImport: unknown type "${type}" — ignored`)
    return null
  }
  const target = lorebookIds?.[0]
  if (!target) {
    console.warn('[world-assets] requestAssetImport: no world for the calling card — ignored')
    return null
  }
  const filters = [{ name: 'Images', extensions: [...ASSET_EXTS] }]
  const pick = win
    ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
    : await dialog.showOpenDialog({ properties: ['openFile'], filters })
  if (pick.canceled || !pick.filePaths[0]) return null
  return svc.importAssetForCard(
    profileId,
    target,
    pick.filePaths[0],
    trimmed,
    type as AssetType,
    variant
  )
}

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
  // ── Card-facing read/import (WA-3) ─────────────────────────────────────────────────────────────
  // Inline transport: the renderer resolves the session lorebook ids (like `asset-url`) and passes them.
  // List: enumerate one entry's variants (main applies id precedence + category inference). Import: open
  // the OS picker and copy into the primary world, returning the new rptasset:// URL. The WCV transport's
  // equivalents live in wcvIpc.ts (ctx from e.sender) and share `pickAndImportAssetForCard`.
  ipcMain.handle(
    'asset-list-for-card',
    (_e, profileId: string, lorebookIds: string[], name: string, type: AssetType) =>
      svc.assetListForWorld(profileId, lorebookIds, name, type)
  )
  ipcMain.handle(
    'asset-import-for-card',
    (
      event,
      profileId: string,
      lorebookIds: string[],
      name: string,
      type: string,
      variant?: string
    ) =>
      pickAndImportAssetForCard(
        BrowserWindow.fromWebContents(event.sender),
        profileId,
        lorebookIds,
        name,
        type,
        variant
      )
  )
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
