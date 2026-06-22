import { IpcMain } from 'electron'
import * as profileService from '../services/profileService'
import * as settingsService from '../services/settingsService'
import * as apiService from '../services/apiService'
import { log } from '../services/logService'

export const registerProfileIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-profiles', () => profileService.getProfiles())
  ipcMain.handle('create-profile', (_, name) => profileService.createProfile(name))
  ipcMain.handle('get-settings', (_, profileId) => settingsService.getSettings(profileId))
  ipcMain.handle('save-settings', (_, profileId, settings) =>
    settingsService.saveSettings(profileId, settings)
  )
  // Fetch the provider's available models for the API settings tab's model dropdown.
  ipcMain.handle('list-models', async (_, api) => {
    try {
      return await apiService.listModels(api)
    } catch (err) {
      log('error', '✗ list-models failed', err instanceof Error ? err.message : String(err))
      throw err
    }
  })
}
