import { IpcMain } from 'electron'
import * as wcvManager from '../services/wcvManager'

/**
 * WebContentsView panel control (spike). Fire-and-forget (`on`, not `handle`): these are
 * frequent position commands with no return value — `wcv-set-bounds` fires on every resize.
 */
export const registerWcvIpc = (ipcMain: IpcMain): void => {
  ipcMain.on('wcv-ensure', (_e, id, bounds, url) => wcvManager.ensure(id, bounds, url))
  ipcMain.on('wcv-set-bounds', (_e, id, bounds) => wcvManager.setBounds(id, bounds))
  ipcMain.on('wcv-set-visible', (_e, id, visible) => wcvManager.setVisible(id, visible))
  ipcMain.on('wcv-destroy', (_e, id) => wcvManager.destroy(id))
}
