import path from 'path';
import { getAppDir, writeJsonSyncAtomic, readJsonSync } from './storageService';
import { Settings } from '../types/models';

export const getSettingsPath = (profileId: string) => path.join(getAppDir(), 'profiles', profileId, 'settings.json');

export const getDefaultSettings = (): Settings => ({
  api: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-3.5-turbo',
    default_params: {
      temperature: 0.9,
      max_tokens: 4000
    }
  },
  ui: {
    theme: 'dark',
    font_size: 16,
    sidebar_collapsed: false,
    history_strip_visible: true
  }
});

export const getSettings = (profileId: string): Settings => {
  const settingsPath = getSettingsPath(profileId);
  const settings = readJsonSync<Settings>(settingsPath);
  return settings || getDefaultSettings();
};

export const saveSettings = (profileId: string, settings: Settings) => {
  writeJsonSyncAtomic(getSettingsPath(profileId), settings);
};
