import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as regexService from '../services/regexService'
import { getActivePresetId } from '../services/presetService'
import { gate } from './ipcGuards'

export const registerRegexIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-render-regex', (_, profileId, ctx) =>
    // Inject the active preset id main-side so preset-scoped display rules resolve
    // without the renderer having to know about preset scope.
    regexService.getRenderRules(profileId, { ...ctx, presetId: getActivePresetId(profileId) })
  )
  // Plot-recall plot-block panel: display rules that ALSO admit placement 1 (user-input beautification),
  // which get-render-regex drops. Same preset injection as the display path.
  ipcMain.handle('get-plot-block-regex', (_, profileId, ctx) =>
    regexService.getPlotBlockRules(profileId, { ...ctx, presetId: getActivePresetId(profileId) })
  )
  // Reasoning panel: display rules for ST placement 6 (reasoning), so a card can beautify/clean the
  // <think> text (RPT strips reasoning from the prompt, so display is the only faithful application).
  ipcMain.handle('get-reasoning-regex', (_, profileId, ctx) =>
    regexService.getReasoningRules(profileId, { ...ctx, presetId: getActivePresetId(profileId) })
  )
  ipcMain.handle('list-regex', (_, profileId) => regexService.listScripts(profileId))
  // 'panel'-promoted regex UIs (with their loader URL) for the active context → selectable workspace panels.
  ipcMain.handle('list-panel-regex', (_, profileId, ctx) =>
    regexService.listPanelRegexes(profileId, { ...ctx, presetId: getActivePresetId(profileId) })
  )
  ipcMain.handle('delete-regex', (_, profileId, file) => regexService.deleteScript(profileId, file))
  ipcMain.handle('regex-set-scope', (_, profileId, file, scope, owner) =>
    regexService.setScriptScope(profileId, file, scope, owner)
  )
  ipcMain.handle('regex-set-render-mode', (_, profileId, file, renderMode) =>
    regexService.setScriptRenderMode(profileId, file, renderMode)
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
  // GATED: native file picker (import from an arbitrary host path).
  ipcMain.handle('import-regex-dialog', gate('import-regex-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'SillyTavern Regex', extensions: ['json'] }]
    })
    if (result.canceled) return null
    const names = result.filePaths
      .map((p) => regexService.importRegexFromFile(profileId, p))
      .filter(Boolean)
    return names.length
  }))
}
