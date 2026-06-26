import { BrowserWindow } from 'electron'

/**
 * Tell open renderers that a chat's stored memories changed, so the Memory view (and any other
 * subscriber) can refresh live — e.g. after the background writer appends a new batch. Broadcast
 * to all windows (the logService pattern); the renderer filters by chatId.
 */
export const notifyMemoryChanged = (chatId: string): void => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('memory-changed', { chatId })
}
