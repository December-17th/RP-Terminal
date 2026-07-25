import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * The separate "Debug" window (WP-D1). A card's custom UI can cover the main window's whole
 * workspace, so the native Logs panel becomes unreachable while a card is on screen. This second
 * BrowserWindow hosts that panel (and, later, a Retrieval tab — WP-D2) independently, so debugging
 * stays available regardless of what the card is rendering.
 *
 * It loads the SAME renderer bundle with a `#debug` hash; renderer/main.tsx branches on that hash to
 * mount the standalone DebugApp instead of the full app. No new fan-out plumbing is needed: logService
 * already `webContents.send('log-event', …)` to BrowserWindow.getAllWindows(), so every open window —
 * this one included — receives live log entries automatically.
 */

let debugWindow: BrowserWindow | null = null

/** Open the Debug window, or focus/restore it if it is already open (singleton). */
export function openDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    if (debugWindow.isMinimized()) debugWindow.restore()
    debugWindow.focus()
    return
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'RP Terminal — Debug',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  debugWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (debugWindow === win) debugWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#debug`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'debug' })
  }
}
