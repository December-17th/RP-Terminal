import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as regexService from '../services/regexService'

export const registerRegexIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-render-regex', (_, profileId, ctx) =>
    regexService.getRenderRules(profileId, ctx)
  )
  ipcMain.handle('list-regex', (_, profileId) => regexService.listScripts(profileId))
  ipcMain.handle('delete-regex', (_, profileId, file) => regexService.deleteScript(profileId, file))
  ipcMain.handle('regex-set-scope', (_, profileId, file, scope, owner) =>
    regexService.setScriptScope(profileId, file, scope, owner)
  )
  ipcMain.handle('regex-set-disabled', (_, profileId, file, disabled) =>
    regexService.setScriptDisabled(profileId, file, disabled)
  )
  ipcMain.handle('regex-script-rules', (_, profileId, file) =>
    regexService.getScriptRules(profileId, file)
  )
  ipcMain.handle('regex-update-rule', (_, profileId, file, index, patch) =>
    regexService.updateRule(profileId, file, index, patch)
  )
  ipcMain.handle('import-regex-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'SillyTavern Regex', extensions: ['json'] }]
    })
    if (result.canceled) return null
    const names = result.filePaths
      .map((p) => regexService.importRegexFromFile(profileId, p))
      .filter(Boolean)
    return names.length
  })
}
