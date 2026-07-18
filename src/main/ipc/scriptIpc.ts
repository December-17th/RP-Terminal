import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as scriptService from '../services/scriptService'
import * as characterService from '../services/characterService'
import { getActivePresetId } from '../services/presetService'
import { resolveRuntimeScriptAuthorization, type RuntimeScript } from '../../shared/scriptTypes'
import { gate } from './ipcGuards'

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
  // GATED: native file picker (import from an arbitrary host path).
  ipcMain.handle(
    'import-script-dialog',
    gate('import-script-dialog', async (event, profileId, scope, owner) => {
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
  )

  // Every runtime entry carries its source authorization so the renderer never guesses trust from
  // array positions or lengths.
  ipcMain.handle('get-runtime-scripts', (_, profileId, cardId, chatId, isolatedRealm) => {
    const presetId = getActivePresetId(profileId)
    const card = cardId ? characterService.getCharacter(profileId, cardId) : null
    const cardScripts: RuntimeScript[] = (card?.data.extensions?.rp_terminal?.scripts || [])
      .filter((s) => s && s.enabled !== false)
      .map((s) => ({
        name: s.name || 'script',
        code: s.code || '',
        authorization: 'card-trust'
      }))
    const scopedScripts: RuntimeScript[] = scriptService
      .getActiveScriptInfos(profileId, {
        cardId,
        chatId,
        presetId,
        isolatedRealm: isolatedRealm === true
      })
      .map((s) => ({
        name: s.name,
        code: s.code,
        ...(s.id ? { id: s.id } : {}),
        // World-scoped entries belong to the active card. Other installed code was authorized by
        // install/import, except remote preset code's separate high-trust grant.
        authorization: resolveRuntimeScriptAuthorization(s.scope, s.highTrust)
      }))
    const scripts = [...cardScripts, ...scopedScripts]
    return { scripts, remoteHosts: scriptService.runtimeImportHosts(scripts) }
  })
}
