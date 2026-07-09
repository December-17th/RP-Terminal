import { app, shell, BrowserWindow, ipcMain, protocol, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import * as logService from './services/logService'
import * as storageService from './services/storageService'
import { readLocationPointer } from './services/locationPointer'
import * as migrationService from './services/migrationService'
import * as templateService from './services/templateService'
import * as wcvManager from './services/wcvManager'
import * as worldAssetProtocol from './services/worldAssetProtocol'
import { registerIpc } from './ipc'
import { TITLEBAR_OVERLAY_HEIGHT } from './windowChrome'

// Card UIs (WebContentsView) are served from this scheme instead of a data: URL: a data: URL is an
// opaque origin where Chromium disables localStorage/sessionStorage/etc., so a storage-using card
// throws "Storage is disabled inside 'data:' URLs" and never renders. A standard, secure scheme gives
// the card a stable, storage-enabled origin (wcvManager serves the per-slot HTML). Must run before ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: wcvManager.CARD_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true }
  },
  {
    scheme: worldAssetProtocol.ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
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
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Give the WebContentsView manager the window so it can overlay card-UI panels (spike).
  wcvManager.init(mainWindow)

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

  // Relocation: on first run with the default location, copy existing %APPDATA% data over (kept as backup).
  try {
    const usingDefault = !process.env.RPT_DATA_DIR && !readLocationPointer()?.dataDir
    storageService.copyLegacyDataDirIfNeeded({
      legacyDir: join(app.getPath('userData'), 'rp-terminal-data'),
      targetDir: storageService.getAppDir(),
      usingDefault
    })
  } catch (err: any) {
    logService.log('error', 'Legacy data-dir copy failed', err?.message || String(err))
  }

  // Initialize SQLite and migrate any legacy JSON data on first run.
  try {
    migrationService.migrateIfNeeded()
  } catch (err: any) {
    logService.log('error', 'Startup DB migration failed', err?.message || String(err))
  }

  // Initialize the sandboxed template engine (non-blocking for the rest of startup).
  templateService.initTemplates().then(() => logService.log('info', 'Template engine ready'))

  // Register all IPC handlers, grouped by domain (see src/main/ipc/).
  registerIpc(ipcMain)
  worldAssetProtocol.registerAssetProtocol()

  // Sync the Windows window-control overlay (custom title bar) to the active theme's colors.
  ipcMain.handle('set-titlebar-overlay', (e, overlay: { color: string; symbolColor: string }) => {
    if (process.platform !== 'win32') return
    try {
      BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay(overlay)
    } catch {
      /* overlay not configured / invalid color */
    }
  })

  // Mirror the app's light/dark mode to Electron's nativeTheme so every embedded card WebContentsView
  // reports the matching `prefers-color-scheme` (dark + OLED → 'dark', light → 'light'), and push the
  // mode to the card panels (they stamp `data-rpt-mode` + fire `rpt:colorscheme`). Called by the
  // renderer's applyTheme(). RPT's own UI is CSS-variable-driven, so nativeTheme doesn't restyle it.
  ipcMain.handle('set-color-scheme', (_e, mode: 'light' | 'dark') => {
    const m: 'light' | 'dark' = mode === 'light' ? 'light' : 'dark'
    nativeTheme.themeSource = m
    wcvManager.pushColorScheme(m)
    return m
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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
