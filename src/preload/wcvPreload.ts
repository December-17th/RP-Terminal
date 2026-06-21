import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload for an out-of-process WebContentsView card-UI panel (spike). Exposes a MINIMAL,
 * locked-down host bridge — read the message variables (latest floor's stat_data) and write
 * them back through the variable bridge — NOT the full `window.api`. The clean-room
 * ST/TavernHelper/Mvu shim will build on top of this. The slot context (profile/chat) is
 * resolved in main from the calling view's webContents id, so the page can't address another
 * session. Context-isolated + sandboxed: the card page can only reach `window.rptHost`.
 */
const rptHost = {
  getVariables: (): Promise<unknown> => ipcRenderer.invoke('wcv-host-get-vars'),
  applyVariableOps: (ops: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('wcv-host-apply-vars', ops),
  onVarsChanged: (cb: (statData: unknown) => void): (() => void) => {
    const listener = (_e: unknown, statData: unknown): void => cb(statData)
    ipcRenderer.on('wcv-vars-changed', listener)
    return () => ipcRenderer.removeListener('wcv-vars-changed', listener)
  }
}

contextBridge.exposeInMainWorld('rptHost', rptHost)
