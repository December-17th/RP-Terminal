import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as presetService from '../services/presetService'
import * as presetTrustService from '../services/presetTrustService'
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
  // High-trust opt-in (ADR 0017 / issue 19): unlock a preset's remote-code scripts to RUN — but only in
  // the isolated WCV realm. Returns the count installed (on) / removed (off).
  ipcMain.handle('preset-is-high-trust', (_, profileId, presetId) =>
    presetTrustService.isPresetHighTrust(profileId, presetId)
  )
  ipcMain.handle('preset-set-high-trust', (_, profileId, presetId, on) =>
    presetTrustService.setPresetHighTrust(profileId, presetId, on === true)
  )
  // Capability inventory of a stored preset (from its lossless envelope) — the Preset Manager reads
  // `remoteCodeScripts` to decide whether to surface the high-trust opt-in. null for a pre-envelope import.
  ipcMain.handle('get-preset-inventory', (_, profileId, presetId) =>
    presetService.getPresetInventory(profileId, presetId)
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
