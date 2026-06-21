import { IpcMain } from 'electron'
import * as profileService from '../services/profileService'
import * as settingsService from '../services/settingsService'

export const registerProfileIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-profiles', () => profileService.getProfiles())
  ipcMain.handle('create-profile', (_, name) => profileService.createProfile(name))
  ipcMain.handle('get-settings', (_, profileId) => settingsService.getSettings(profileId))
  ipcMain.handle('save-settings', (_, profileId, settings) =>
    settingsService.saveSettings(profileId, settings)
  )
}
