import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as scriptService from '../services/scriptService'
import * as characterService from '../services/characterService'
import { getActivePresetId } from '../services/presetService'

export const registerScriptIpc = (ipcMain: IpcMain): void => {
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
    const cardScripts = (card?.data.extensions?.rp_terminal?.scripts || [])
      .filter((s) => s && s.enabled !== false)
      .map((s) => ({ name: s.name || 'script', code: s.code || '' }))
    const scripts = [
      ...cardScripts,
      ...scriptService.getActiveScripts(profileId, {
        cardId,
        chatId,
        presetId: getActivePresetId(profileId)
      })
    ]
    return { scripts, remoteHosts: scriptService.runtimeImportHosts(scripts) }
  })
}
