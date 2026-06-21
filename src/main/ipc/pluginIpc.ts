import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as pluginService from '../services/pluginService'
import * as scriptApiService from '../services/scriptApiService'
import * as pluginHostService from '../services/pluginHostService'
import * as pluginStorageService from '../services/pluginStorageService'
import * as pluginNetService from '../services/pluginNetService'
import * as logService from '../services/logService'

export const registerPluginIpc = (ipcMain: IpcMain): void => {
  // Card-script runtime (P1) — permission-checked engine bridge for sandboxed scripts.
  ipcMain.handle('plugin-vars', (_, profileId, chatId, action) =>
    pluginService.pluginVars(profileId, chatId, action)
  )
  ipcMain.handle('plugin-get-vars', (_, profileId, chatId) =>
    pluginService.getVars(profileId, chatId)
  )
  ipcMain.handle('plugin-get-messages', (_, profileId, chatId) =>
    pluginService.getMessages(profileId, chatId)
  )
  // TH-2 message write API (gated behind chat:write in the renderer dispatcher).
  ipcMain.handle('plugin-set-message', (_, profileId, chatId, floorIndex, patch) =>
    pluginService.setMessage(profileId, chatId, floorIndex, patch)
  )
  ipcMain.handle('plugin-delete-messages', (_, profileId, chatId, fromIndex) =>
    pluginService.deleteMessages(profileId, chatId, fromIndex)
  )
  ipcMain.handle('plugin-create-message', (_, profileId, chatId, msg) =>
    pluginService.createMessage(profileId, chatId, msg)
  )

  // TH-3 read/CRUD API (card · worldbook · preset · regex). Permission-gated in the
  // renderer dispatcher; these are pure data access.
  ipcMain.handle('script-card-data', (_, profileId, chatId, cardId) =>
    scriptApiService.getCharData(profileId, chatId, cardId)
  )
  ipcMain.handle('script-card-avatar', (_, profileId, chatId, cardId) =>
    scriptApiService.getCharAvatarPath(profileId, chatId, cardId)
  )
  ipcMain.handle('script-worldbook-list', (_, profileId) =>
    scriptApiService.listWorldbooks(profileId)
  )
  ipcMain.handle('script-worldbook-get', (_, profileId, chatId, id, cardId) =>
    scriptApiService.getWorldbook(profileId, chatId, id, cardId)
  )
  ipcMain.handle('script-worldbook-set', (_, profileId, chatId, id, entries, cardId) =>
    scriptApiService.setWorldbookEntries(profileId, chatId, id, entries, cardId)
  )
  ipcMain.handle('script-preset-get', (_, profileId) => scriptApiService.getPresetInfo(profileId))
  ipcMain.handle('script-preset-list', (_, profileId) => scriptApiService.listPresetNames(profileId))
  ipcMain.handle('script-regex-format', (_, profileId, ctx, text, macroCtx) =>
    scriptApiService.formatWithRegex(profileId, ctx, text, macroCtx)
  )
  ipcMain.handle('script-regex-list', (_, profileId, ctx) =>
    scriptApiService.listRegexes(profileId, ctx)
  )
  ipcMain.handle('plugin-get-grants', (_, profileId, cardId) =>
    pluginService.getGrants(profileId, cardId)
  )
  ipcMain.handle('plugin-set-grants', (_, profileId, cardId, patch) =>
    pluginService.setGrants(profileId, cardId, patch)
  )
  // Surface a card script's rpt.log(...) output in the in-app Logs panel.
  ipcMain.handle('plugin-log', (_, label, message) =>
    logService.log('info', `⚙ script · ${label}`, message)
  )

  // Plugin host/loader (P2) — standalone installable plugins.
  ipcMain.handle('plugins-list', (_, profileId) => pluginHostService.listPlugins(profileId))
  ipcMain.handle('plugins-install-dialog', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Select a plugin folder (containing manifest.json)',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return pluginHostService.installFromFolder(result.filePaths[0])
  })
  ipcMain.handle('plugins-install-zip-dialog', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Select a plugin .zip',
      properties: ['openFile'],
      filters: [{ name: 'Plugin package', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return pluginHostService.installFromZip(result.filePaths[0])
  })
  ipcMain.handle('plugins-uninstall', (_, profileId, id) =>
    pluginHostService.uninstall(profileId, id)
  )
  ipcMain.handle('plugins-set-enabled', (_, profileId, id, enabled, grants) =>
    pluginHostService.setEnabled(profileId, id, enabled, grants)
  )
  ipcMain.handle('plugins-set-grants', (_, profileId, id, grants) =>
    pluginHostService.setGrants(profileId, id, grants)
  )
  ipcMain.handle('plugins-scaffold-example', () => pluginHostService.scaffoldExample())
  // Plugin-scoped persistent storage (P5). `owner` is host-supplied, not from the iframe.
  ipcMain.handle('plugin-storage', (_, profileId, owner, action) =>
    pluginStorageService.storageOp(profileId, owner, action)
  )
  // Opt-in host-mediated fetch (P5). pluginId is host-supplied; allow-list re-read from disk.
  ipcMain.handle('plugin-net-fetch', (_, pluginId, url, opts) =>
    pluginNetService.netFetch(pluginId, url, opts)
  )
}
