import { IpcMain } from 'electron'
import * as wcvManager from '../services/wcvManager'
import * as floorService from '../services/floorService'
import * as generationService from '../services/generationService'

/**
 * WebContentsView card-UI panel IPC (spike). Position commands are fire-and-forget (`on`);
 * the host-bridge reads/writes are request/response (`handle`). The bridge resolves the
 * calling panel's session from its webContents id (set when the view was created), so a card
 * page can only touch its own session's message variables.
 */
export const registerWcvIpc = (ipcMain: IpcMain): void => {
  ipcMain.on('wcv-ensure', (_e, id, bounds, url, ctx) => wcvManager.ensure(id, bounds, url, ctx))
  ipcMain.on('wcv-set-bounds', (_e, id, bounds) => wcvManager.setBounds(id, bounds))
  ipcMain.on('wcv-set-visible', (_e, id, visible) => wcvManager.setVisible(id, visible))
  ipcMain.on('wcv-destroy', (_e, id) => wcvManager.destroy(id))
  // Host → card panels: the latest stat_data changed (model turn / edit) — refresh their mirrors.
  ipcMain.on('wcv-broadcast-vars', (_e, chatId, statData) =>
    wcvManager.notifyVarsChanged(chatId, statData)
  )

  // Read the latest floor's message variables (stat_data) for the calling panel's session.
  ipcMain.handle('wcv-host-get-vars', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return {}
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    return floors[floors.length - 1]?.variables?.stat_data ?? {}
  })

  // Synchronous variant: the shim hydrates its mirror with this at preload load, so stat_data is
  // present BEFORE the card's React app first renders (an async read would land after default render).
  ipcMain.on('wcv-host-get-vars-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) {
      e.returnValue = {}
      return
    }
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    e.returnValue = floors[floors.length - 1]?.variables?.stat_data ?? {}
  })

  // Write JSONPatch ops to the latest floor's stat_data via the same bridge the model uses,
  // then push the result to the host renderer (native panels) and any sibling WCVs.
  ipcMain.handle('wcv-host-apply-vars', (e, ops) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return null
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const latest = floors[floors.length - 1]
    if (!latest) return null
    const floor = generationService.applyVariableOps(ctx.profileId, ctx.chatId, latest.floor, ops)
    const statData = floor?.variables?.stat_data ?? {}
    wcvManager.pushHostVars(ctx.chatId, floor?.variables)
    wcvManager.notifyVarsChanged(ctx.chatId, statData)
    return statData
  })
}
