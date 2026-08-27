import { IpcMain } from 'electron'
import * as profileService from '../services/profileService'
import * as settingsService from '../services/settingsService'
import * as apiService from '../services/apiService'
import { log } from '../services/logService'
import { setExitDialogLocale } from '../appExit'
import { gate } from './ipcGuards'

export const registerProfileIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-profiles', () => profileService.getProfiles())
  ipcMain.handle('create-profile', (_, name) => profileService.createProfile(name))
  // Debug-only: wipe all of a profile's content (characters/chats/presets/lorebooks/regex/scripts/
  // plugin data) + reset settings, keeping the API connection config. See profileService.wipeProfile.
  // GATED: whole-profile destruction is storage-layer harm, not in-profile content.
  ipcMain.handle(
    'wipe-profile',
    gate('wipe-profile', (_, profileId) => profileService.wipeProfile(profileId))
  )
  // The renderer never sees a full api key — mask every key before it leaves main (shown in full only
  // when the user first types it; see settingsService for the retain-on-save half).
  ipcMain.handle('get-settings', (_, profileId) => {
    const settings = settingsService.getSettings(profileId)
    setExitDialogLocale(settings.ui.locale)
    return settingsService.maskedSettings(settings)
  })
  // GATED: settings carry provider keys/endpoints — a card rewriting the endpoint could exfiltrate keys.
  ipcMain.handle(
    'save-settings',
    gate('save-settings', (_, profileId, settings) => {
      settingsService.saveSettings(profileId, settings)
      setExitDialogLocale(settings.ui.locale)
    })
  )
  // Provider discovery is app-UI-only and uses one complete configuration read in main. Never combine
  // a stored secret with a renderer-selected provider or endpoint.
  ipcMain.handle(
    'list-models',
    gate('list-models', async (_, profileId) => {
      try {
        return await apiService.listModels(settingsService.getSettings(profileId).api)
      } catch (err) {
        log('error', '✗ list-models failed', err instanceof Error ? err.message : String(err))
        throw err
      }
    })
  )
}
