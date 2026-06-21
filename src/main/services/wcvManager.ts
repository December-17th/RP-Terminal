import { WebContentsView, BrowserWindow } from 'electron'
import { log } from './logService'

/**
 * SPIKE — out-of-process card-UI panels via `WebContentsView`.
 *
 * Each panel slot gets one WebContentsView added to the main window's contentView, so it runs
 * in its own process (hang/crash-isolated) and paints OVER the React UI at the pixel bounds the
 * renderer reports for that slot. Proves the embedding mechanism (create / position / load /
 * destroy) ahead of the static card-UI workspace + the ST/MVU runtime shim. Bounds are
 * window-content-relative (same origin as the renderer's getBoundingClientRect).
 */

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

let mainWindow: BrowserWindow | null = null
const views = new Map<string, WebContentsView>()

export const init = (win: BrowserWindow): void => {
  mainWindow = win
  // Tear every guest view down with the window so we don't leak guest processes.
  win.on('closed', () => destroyAll())
}

const round = (b: Bounds): Bounds => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})

/** Create the view for `id` (once) loading `url`, then position it at `bounds`. */
export const ensure = (id: string, bounds: Bounds, url: string): void => {
  if (!mainWindow) return
  let view = views.get(id)
  if (!view) {
    // Locked down: no node, isolated, sandboxed. (A shim preload is added in a later step.)
    view = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    views.set(id, view)
    mainWindow.contentView.addChildView(view)
    view.webContents.loadURL(url)
    log('info', `wcv: created '${id}'`)
  }
  view.setBounds(round(bounds))
}

export const setBounds = (id: string, bounds: Bounds): void => {
  views.get(id)?.setBounds(round(bounds))
}

/** Hide without destroying (e.g. while a modal is open over it, or its tab is hidden). */
export const setVisible = (id: string, visible: boolean): void => {
  views.get(id)?.setVisible(visible)
}

export const destroy = (id: string): void => {
  const view = views.get(id)
  if (!view) return
  views.delete(id)
  try {
    mainWindow?.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  } catch (err) {
    log('error', `wcv: destroy '${id}' failed`, String(err))
  }
  log('info', `wcv: destroyed '${id}'`)
}

export const destroyAll = (): void => {
  for (const id of [...views.keys()]) destroy(id)
}
