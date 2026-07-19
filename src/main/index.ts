import { app, shell, BrowserWindow, ipcMain, protocol } from 'electron'
import { dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icons/rp-terminal-emerald.png?asset'

import * as logService from './services/logService'
import * as storageService from './services/storageService'
import { copyLegacyLocationPointerIfNeeded, readLocationPointer } from './services/locationPointer'
import * as migrationService from './services/migrationService'
import * as sessionMigrationService from './services/sessionMigrationService'
import * as templateService from './services/templateService'
import * as wcvManager from './services/wcvManager'
import * as worldAssetProtocol from './services/worldAssetProtocol'
import * as avatarProtocol from './services/avatarProtocol'
// Side-effect: wires workflowService's card-import ops into characterService's seam (breaks the
// characterService → workflowService cycle). Must load before any card import runs.
import './services/cardWorkflowBridge'
import './services/cardAgentCatalogBridge'
import { registerIpc } from './ipc'
import { setGuardMainWindow } from './ipc/ipcGuards'
import { TITLEBAR_OVERLAY_HEIGHT } from './windowChrome'
import { appExitGuard, runShutdownCleanup, setExitDialogWindow } from './appExit'
import { initializeInvocationRuntime } from './services/agentRuntime/InvocationRuntimeService'

// A packaged Windows ZIP is self-contained: RP Terminal records, Electron preferences, browser
// storage, and caches all live below rp-terminal-data beside the executable. macOS retains Electron's
// standard userData path (~/Library/Application Support/RP Terminal). Capture the old Windows AppData
// path first so v0.1.0 data and a saved custom-location pointer can be migrated without deleting their
// backups.
const legacyUserDataDir = app.getPath('userData')
const isWindowsPortable = app.isPackaged && process.platform === 'win32'
if (isWindowsPortable) {
  const executableDir = process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath('exe'))
  const portableUserDataDir = join(executableDir, storageService.DATA_DIR_NAME)
  const sessionDataDir = join(portableUserDataDir, 'chromium')
  storageService.ensureDir(portableUserDataDir)
  storageService.ensureDir(sessionDataDir)
  copyLegacyLocationPointerIfNeeded({ legacyUserDataDir, portableUserDataDir })
  app.setPath('userData', portableUserDataDir)
  app.setPath('sessionData', sessionDataDir)
}

// Card UIs (WebContentsView) are served from this scheme instead of a data: URL: a data: URL is an
// opaque origin where Chromium disables localStorage/sessionStorage/etc., so a storage-using card
// throws "Storage is disabled inside 'data:' URLs" and never renders. A standard, secure scheme gives
// the card a stable, storage-enabled origin (wcvManager serves the per-slot HTML). Must run before ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: wcvManager.CARD_SCHEME,
    // `stream: true` (mirrors ASSET_SCHEME) so served card-code file bodies stream rather than buffer (A2).
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
      stream: true
    }
  },
  {
    scheme: worldAssetProtocol.ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    // Launcher avatar thumbnails, served by character id instead of a multi-MB base64 IPC (perf P1-6).
    scheme: avatarProtocol.AVATAR_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    title: 'RP Terminal',
    icon,
    show: false,
    autoHideMenuBar: true,
    // Custom merged title bar (Windows): hide the native bar; the min/max/close render as an
    // overlay top-right and the renderer's top bar (TopNav / launcher bar) is the draggable region.
    // The overlay color is re-synced to the active theme via the 'set-titlebar-overlay' IPC.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          // Height matches the renderer top strip (.tstrip / .lc-bar) so the OS window controls sit
          // flush with it. Single-sourced here as TITLEBAR_OVERLAY_HEIGHT (src/main/windowChrome.ts),
          // paired with the renderer token --rpt-titlebar-h (src/renderer/src/theme.ts).
          titleBarOverlay: {
            color: '#1e1e1e',
            symbolColor: '#e0e0e0',
            height: TITLEBAR_OVERLAY_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Give the WebContentsView manager the window so it can overlay card-UI panels (spike).
  wcvManager.init(mainWindow)

  // Identify the app's own top frame for the destructive-IPC sender gate (card-trust-boundary
  // issue 02): gated channels run only when the caller IS this window's main frame.
  setGuardMainWindow(mainWindow)

  // Interception point #1: the close button / Windows title-bar close. Only OUTSIDE macOS, where it
  // cascades into window-all-closed -> app.quit() and really does discard the work. On macOS closing
  // the window leaves the app (and its background work) running, so prompting there would both be a
  // false alarm and change what the close button means. Milestone 4.
  setExitDialogWindow(mainWindow)
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (e) => appExitGuard.handleExitRequest(e))
  }
  mainWindow.on('closed', () => setExitDialogWindow(null))

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
  electronApp.setAppUserModelId('com.december17th.rpterminal')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Windows ZIP migration: on first run with the beside-app default, copy the previous %APPDATA%
  // data over and leave the original intact as a backup.
  if (isWindowsPortable) {
    try {
      const usingDefault = !process.env.RPT_DATA_DIR && !readLocationPointer()?.dataDir
      storageService.copyLegacyDataDirIfNeeded({
        legacyDir: join(legacyUserDataDir, 'rp-terminal-data'),
        targetDir: storageService.getAppDir(),
        usingDefault
      })
    } catch (err: any) {
      logService.log('error', 'Legacy data-dir copy failed', err?.message || String(err))
    }
  }

  // Initialize SQLite and migrate any legacy JSON data on first run.
  try {
    migrationService.migrateIfNeeded()
  } catch (err: any) {
    logService.log('error', 'Startup DB migration failed', err?.message || String(err))
  }

  // Decentralize any pre-existing chats into per-session stores (plan §B5). Runs to completion here,
  // before any chat can be opened, so services never see a half-migrated chat. Resumable + quarantining.
  try {
    sessionMigrationService.migrateSessionsIfNeeded()
  } catch (err: any) {
    logService.log(
      'error',
      'Session decentralization migration failed',
      err?.message || String(err)
    )
    app.quit()
    return
  }
  initializeInvocationRuntime()

  // Initialize the sandboxed template engine (non-blocking for the rest of startup).
  templateService.initTemplates().then(() => logService.log('info', 'Template engine ready'))

  // Register all IPC handlers, grouped by domain (see src/main/ipc/).
  registerIpc(ipcMain)
  worldAssetProtocol.registerAssetProtocol()
  avatarProtocol.registerAvatarProtocol()

  // Sync the Windows window-control overlay (custom title bar) to the active theme's colors.
  ipcMain.handle('set-titlebar-overlay', (e, overlay: { color: string; symbolColor: string }) => {
    if (process.platform !== 'win32') return
    try {
      BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay(overlay)
    } catch {
      /* overlay not configured / invalid color */
    }
  })

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

// Interception point #2: macOS Cmd-Q and the dock's Quit, plus every programmatic app.quit(). This is
// the LAST point that can still stop the exit — `will-quit` (below) cannot. Milestone 4.
app.on('before-quit', (e) => appExitGuard.handleExitRequest(e))

// Close every open per-chat session DB handle before quitting so Windows file locks don't linger and a
// clean shutdown checkpoints each WAL (plan §B4 / review C3). The body moved to appExit.ts so the
// `restart-app` path — which calls app.exit(0) and therefore never fires will-quit — can run the
// identical cleanup instead of skipping it.
app.on('will-quit', () => runShutdownCleanup())

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
