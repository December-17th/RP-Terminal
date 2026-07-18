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
  // Sync active-preset VIEW (name/parameters/prompts/prompts_unused/extensions) — the envelope-backed
  // Host preset view. The inline cardBridge host reads this synchronously at getPreset() time so it
  // returns the SAME prompts_unused/extensions as the WCV transport: both bottom out in
  // getActivePresetView (transport parity, CLAUDE.md). Mirrors the WCV `preset` sync channel (wcvIpc).
  ipcMain.on('get-active-preset-view-sync', (e, profileId) => {
    e.returnValue = presetService.getActivePresetView(String(profileId))
  })
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
  // GATED (self-escalation): unlocking a preset's remote-code scripts actually RUNS them, so a card
  // iframe / WCV reaching window.api must not grant itself trust — only the app's own top frame (the
  // PresetManager high-trust opt-in UI, in the trusted main renderer) may. Mirrors plugin-set-grants.
  ipcMain.handle(
    'preset-set-high-trust',
    gate('preset-set-high-trust', (_, profileId, presetId, on) =>
      presetTrustService.setPresetHighTrust(profileId, presetId, on === true)
    )
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
