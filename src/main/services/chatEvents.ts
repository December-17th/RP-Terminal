import { BrowserWindow } from 'electron'

/**
 * Tell open renderers a chat's FSM mode changed MAIN-SIDE (e.g. a workflow tool node started
 * combat/duel), so the workspace switches layouts without a user click. Renderer-initiated
 * changes go through the same service and re-receive their own value — harmless. Broadcast to
 * all windows (the logService pattern); the renderer filters by chatId.
 */
export const notifyChatModeChanged = (chatId: string, mode: string): void => {
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send('chat-mode-changed', { chatId, mode })
}
