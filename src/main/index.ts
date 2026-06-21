import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import * as profileService from './services/profileService'
import * as settingsService from './services/settingsService'
import * as characterService from './services/characterService'
import * as chatService from './services/chatService'
import * as floorService from './services/floorService'
import * as presetService from './services/presetService'
import * as lorebookService from './services/lorebookService'
import * as generationService from './services/generationService'
import * as logService from './services/logService'
import * as migrationService from './services/migrationService'
import * as regexService from './services/regexService'
import * as scriptService from './services/scriptService'
import * as templateService from './services/templateService'
import * as pluginService from './services/pluginService'
import * as pluginHostService from './services/pluginHostService'
import * as pluginStorageService from './services/pluginStorageService'
import * as pluginNetService from './services/pluginNetService'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  // Surface renderer crashes in the main log (cheap, and these are rare/important).
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logService.log('error', '[renderer gone]', JSON.stringify(details))
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize SQLite and migrate any legacy JSON data on first run.
  try {
    migrationService.migrateIfNeeded()
  } catch (err: any) {
    logService.log('error', 'Startup DB migration failed', err?.message || String(err))
  }

  // Initialize the sandboxed template engine (non-blocking for the rest of startup).
  templateService.initTemplates().then(() => logService.log('info', 'Template engine ready'))

  // Register IPC Handlers
  ipcMain.handle('get-profiles', () => profileService.getProfiles())
  ipcMain.handle('create-profile', (_, name) => profileService.createProfile(name))
  ipcMain.handle('get-settings', (_, profileId) => settingsService.getSettings(profileId))
  ipcMain.handle('save-settings', (_, profileId, settings) =>
    settingsService.saveSettings(profileId, settings)
  )
  ipcMain.handle('get-characters', (_, profileId) => characterService.getCharacters(profileId))
  ipcMain.handle('save-character', (_, profileId, charId, card) =>
    characterService.saveCharacter(profileId, charId, card)
  )

  ipcMain.handle('import-character-dialog', async (event, profileId) => {
    const { dialog } = require('electron')
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'World Cards', extensions: ['png', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]

    // One-click install: if the card bundles artifacts (regex/scripts/UI), show a
    // transparent confirm listing exactly what installs before committing anything.
    const summary = characterService.inspectCardFile(filePath)
    if (summary && characterService.hasBundle(summary)) {
      const items = [
        summary.loreEntries && `${summary.loreEntries} lore entries`,
        summary.lorebooks && `${summary.lorebooks} extra lorebooks`,
        summary.regexScripts && `${summary.regexScripts} regex scripts`,
        summary.presets && `${summary.presets} presets`,
        summary.scripts && `${summary.scripts} card scripts`,
        summary.uiWidgets && `${summary.uiWidgets} UI widgets`,
        summary.pluginsSkipped && `${summary.pluginsSkipped} plugins (skipped — not yet supported)`
      ].filter(Boolean)
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Import "${summary.name}"`,
        detail:
          (summary.isWorldCard ? 'This World Card bundles:\n' : 'This card bundles:\n') +
          items.map((i) => `  • ${i}`).join('\n')
      })
      if (response !== 0) return null
    }
    return characterService.importCharacterFromFile(profileId, filePath)
  })

  ipcMain.handle('export-character-dialog', async (event, profileId, characterId) => {
    const exported = characterService.exportWorldCard(profileId, characterId)
    if (!exported) return null
    const { dialog } = require('electron')
    const safeName = exported.name.replace(/[^a-z0-9_-]+/gi, '_') || 'world-card'
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'World Card', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    require('fs').writeFileSync(result.filePath, JSON.stringify(exported.json, null, 2), 'utf-8')
    return exported.name
  })

  ipcMain.handle('get-chats', (_, profileId) => chatService.getChats(profileId))
  ipcMain.handle('create-chat', (_, profileId, charId) => chatService.createChat(profileId, charId))
  ipcMain.handle('get-floors', (_, profileId, chatId) => {
    const chat = chatService.getChat(profileId, chatId)
    return chat ? floorService.getAllFloors(profileId, chatId, chat.floor_count) : []
  })
  ipcMain.handle('generate', async (event, profileId, chatId, userAction) => {
    try {
      return await generationService.generate(profileId, chatId, userAction, (delta) =>
        event.sender.send('generation-delta', { chatId, delta })
      )
    } catch (err: any) {
      logService.log('error', '✗ generate failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('regenerate', async (event, profileId, chatId) => {
    try {
      return await generationService.regenerate(profileId, chatId, (delta) =>
        event.sender.send('generation-delta', { chatId, delta })
      )
    } catch (err: any) {
      logService.log('error', '✗ regenerate failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('abort-generation', (_, chatId) => generationService.abortGeneration(chatId))

  // Logs
  ipcMain.handle('get-logs', () => logService.getLogs())
  ipcMain.handle('clear-logs', () => logService.clearLogs())

  // Regex (display beautification scripts)
  ipcMain.handle('get-render-regex', (_, profileId, ctx) =>
    regexService.getRenderRules(profileId, ctx)
  )
  ipcMain.handle('list-regex', (_, profileId) => regexService.listScripts(profileId))
  ipcMain.handle('delete-regex', (_, profileId, file) => regexService.deleteScript(profileId, file))
  ipcMain.handle('regex-set-scope', (_, profileId, file, scope, owner) =>
    regexService.setScriptScope(profileId, file, scope, owner)
  )
  ipcMain.handle('regex-set-disabled', (_, profileId, file, disabled) =>
    regexService.setScriptDisabled(profileId, file, disabled)
  )

  // Scripts (profile-level library; scope global/world/session + per-script toggle)
  ipcMain.handle('list-scripts', (_, profileId) => scriptService.listScripts(profileId))
  ipcMain.handle('get-script', (_, profileId, file) => scriptService.getScript(profileId, file))
  ipcMain.handle('save-script', (_, profileId, script, scope, owner) =>
    scriptService.saveScript(profileId, script, scope, owner)
  )
  ipcMain.handle('update-script', (_, profileId, file, patch) =>
    scriptService.updateScript(profileId, file, patch)
  )
  ipcMain.handle('script-set-scope', (_, profileId, file, scope, owner) =>
    scriptService.setScriptScope(profileId, file, scope, owner)
  )
  ipcMain.handle('script-set-disabled', (_, profileId, file, disabled) =>
    scriptService.setScriptDisabled(profileId, file, disabled)
  )
  ipcMain.handle('delete-script', (_, profileId, file) =>
    scriptService.deleteScript(profileId, file)
  )
  ipcMain.handle('import-script-dialog', async (event, profileId, scope, owner) => {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Tavern Helper / RPT Scripts', extensions: ['json'] }]
    })
    if (result.canceled) return 0
    let count = 0
    for (const fp of result.filePaths) {
      count += scriptService.importScriptsFromFile(profileId, fp, scope || 'global', owner)
    }
    return count
  })
  // The merged runtime script set for a chat: card-embedded (World) + active-scope store
  // scripts (raw — remote `import`s load natively in the sandbox under the remoteScripts
  // grant, 1B). Also reports the remote hosts those scripts import from (grant + CSP).
  ipcMain.handle('get-runtime-scripts', (_, profileId, cardId, chatId) => {
    const card = cardId ? characterService.getCharacter(profileId, cardId) : null
    const cardScripts = ((card?.data.extensions?.rp_terminal as any)?.scripts || [])
      .filter((s: any) => s && s.enabled !== false)
      .map((s: any) => ({ name: s.name || 'script', code: s.code || '' }))
    const scripts = [...cardScripts, ...scriptService.getActiveScripts(profileId, { cardId, chatId })]
    return { scripts, remoteHosts: scriptService.runtimeImportHosts(scripts) }
  })
  ipcMain.handle('regex-script-rules', (_, profileId, file) =>
    regexService.getScriptRules(profileId, file)
  )
  ipcMain.handle('regex-update-rule', (_, profileId, file, index, patch) =>
    regexService.updateRule(profileId, file, index, patch)
  )
  ipcMain.handle('import-regex-dialog', async (event, profileId) => {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'SillyTavern Regex', extensions: ['json'] }]
    })
    if (result.canceled) return null
    const names = result.filePaths
      .map((p) => regexService.importRegexFromFile(profileId, p))
      .filter(Boolean)
    return names.length
  })
  ipcMain.handle('delete-chat', (_, profileId, chatId) => chatService.deleteChat(profileId, chatId))
  ipcMain.handle('edit-floor', (_, profileId, chatId, floorIndex, userContent, responseContent) =>
    chatService.editFloorContent(profileId, chatId, floorIndex, userContent, responseContent)
  )
  ipcMain.handle('delete-character', (_, profileId, charId) =>
    characterService.deleteCharacter(profileId, charId)
  )

  // Presets (file-based, multiple per profile)
  ipcMain.handle('list-presets', (_, profileId) => presetService.listPresets(profileId))
  ipcMain.handle('get-active-preset-id', (_, profileId) =>
    presetService.getActivePresetId(profileId)
  )
  ipcMain.handle('get-active-preset', (_, profileId) => presetService.getActivePreset(profileId))
  ipcMain.handle('get-preset', (_, profileId, presetId) =>
    presetService.getPresetById(profileId, presetId)
  )
  ipcMain.handle('set-active-preset', (_, profileId, presetId) =>
    presetService.setActivePreset(profileId, presetId)
  )
  ipcMain.handle('create-preset', (_, profileId, name) =>
    presetService.createEmptyPreset(profileId, name)
  )
  ipcMain.handle('save-preset', (_, profileId, presetId, preset) =>
    presetService.savePreset(profileId, presetId, preset)
  )
  ipcMain.handle('delete-preset', (_, profileId, presetId) =>
    presetService.deletePreset(profileId, presetId)
  )
  ipcMain.handle('import-preset-dialog', async (event, profileId) => {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'SillyTavern Preset', extensions: ['json'] }]
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return presetService.importPresetFromFile(profileId, result.filePaths[0])
    }
    return null
  })

  // Lorebook library (file-based, id-keyed; a character's own lorebook has id == characterId)
  ipcMain.handle('list-lorebooks', (_, profileId) => lorebookService.listLorebooks(profileId))
  ipcMain.handle('get-lorebook', (_, profileId, id) =>
    lorebookService.getLorebookById(profileId, id)
  )
  ipcMain.handle('save-lorebook', (_, profileId, id, lorebook) => {
    const result = lorebookService.saveLorebookById(profileId, id, lorebook)
    // A book changed — drop the per-session L2 cache so edits show up next turn.
    chatService.clearWorldInfoCacheForProfile(profileId)
    return result
  })
  ipcMain.handle('create-lorebook', (_, profileId, name) =>
    lorebookService.createLorebook(profileId, name)
  )
  ipcMain.handle('delete-lorebook', (_, profileId, id) => {
    lorebookService.deleteLorebookById(profileId, id)
    // Drop the deleted book from any session that still references it.
    chatService.removeLorebookIdFromChats(profileId, id)
  })
  ipcMain.handle('import-lorebook-dialog', async (event, profileId) => {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'Lorebook / World Info', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return lorebookService.importLorebookFromFile(profileId, result.filePaths[0])
  })
  ipcMain.handle('export-lorebook-dialog', async (event, profileId, id, name) => {
    const { dialog } = require('electron')
    const safeName = String(name || 'lorebook').replace(/[^\w.-]+/g, '_')
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'Lorebook', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    return lorebookService.exportLorebookToFile(profileId, id, result.filePath)
  })
  // Per-session active lorebook selection
  ipcMain.handle('get-chat-lorebooks', (_, profileId, chatId) =>
    chatService.getChatLorebookIds(profileId, chatId)
  )
  ipcMain.handle('set-chat-lorebooks', (_, profileId, chatId, ids) =>
    chatService.setChatLorebookIds(profileId, chatId, ids)
  )
  // Per-session FSM mode (Phase H)
  ipcMain.handle('get-chat-mode', (_, profileId, chatId) =>
    chatService.getChatMode(profileId, chatId)
  )
  ipcMain.handle('set-chat-mode', (_, profileId, chatId, mode) =>
    chatService.setChatMode(profileId, chatId, mode)
  )

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
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Select a plugin folder (containing manifest.json)',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return pluginHostService.installFromFolder(result.filePaths[0])
  })
  ipcMain.handle('plugins-install-zip-dialog', async (event) => {
    const { dialog } = require('electron')
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

  createWindow()
  logService.log('info', 'RP Terminal started')

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
