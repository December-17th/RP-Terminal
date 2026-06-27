import { IpcMain } from 'electron'
import * as profileService from '../services/profileService'
import * as settingsService from '../services/settingsService'
import * as apiService from '../services/apiService'
import { log } from '../services/logService'

export const registerProfileIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-profiles', () => profileService.getProfiles())
  ipcMain.handle('create-profile', (_, name) => profileService.createProfile(name))
  // Debug-only: wipe all of a profile's content (characters/chats/presets/lorebooks/regex/scripts/
  // plugin data) + reset settings, keeping the API connection config. See profileService.wipeProfile.
  ipcMain.handle('wipe-profile', (_, profileId) => profileService.wipeProfile(profileId))
  // The renderer never sees a full api key — mask every key before it leaves main (shown in full only
  // when the user first types it; see settingsService for the retain-on-save half).
  ipcMain.handle('get-settings', (_, profileId) =>
    settingsService.maskedSettings(settingsService.getSettings(profileId))
  )
  ipcMain.handle('save-settings', (_, profileId, settings) =>
    settingsService.saveSettings(profileId, settings)
  )
  // Fetch the provider's available models for the API settings tab's model dropdown. The renderer's key
  // is masked after first entry, so resolve the real (stored) key here when it isn't a freshly-typed one.
  ipcMain.handle('list-models', async (_, api, profileId) => {
    try {
      let key = api?.api_key
      if (!key || settingsService.isMaskedKey(String(key))) {
        key = settingsService.getSettings(profileId).api.api_key
      }
      return await apiService.listModels({ ...api, api_key: key })
    } catch (err) {
      log('error', '✗ list-models failed', err instanceof Error ? err.message : String(err))
      throw err
    }
  })
}
