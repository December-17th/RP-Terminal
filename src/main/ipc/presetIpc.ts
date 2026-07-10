import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as presetService from '../services/presetService'
import { gate } from './ipcGuards'

export const registerPresetIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('list-presets', (_, profileId) => presetService.listPresets(profileId))
  ipcMain.handle('get-active-preset-id', (_, profileId) =>
    presetService.getActivePresetId(profileId)
  )
  ipcMain.handle('get-active-preset', (_, profileId) => presetService.getActivePreset(profileId))
  ipcMain.handle('get-preset', (_, profileId, presetId) =>
    presetService.getPresetById(profileId, presetId)
  )
  ipcMain.handle('set-active-preset', (_, profileId, presetId) =>
    presetService.setActivePreset(profileId, presetId)
  )
  ipcMain.handle('create-preset', (_, profileId, name) =>
    presetService.createEmptyPreset(profileId, name)
  )
  ipcMain.handle('save-preset', (_, profileId, presetId, preset) =>
    presetService.savePreset(profileId, presetId, preset)
  )
  ipcMain.handle('delete-preset', (_, profileId, presetId) =>
    presetService.deletePreset(profileId, presetId)
  )
  // GATED: native file picker (import from an arbitrary host path).
  ipcMain.handle('import-preset-dialog', gate('import-preset-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'SillyTavern Preset', extensions: ['json'] }]
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return presetService.importPresetFromFile(profileId, result.filePaths[0])
    }
    return null
  }))
}
