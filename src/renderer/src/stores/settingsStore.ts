import { create } from 'zustand';

export interface Settings {
  api: {
    provider: string;
    endpoint: string;
    api_key: string;
    model: string;
    default_params: Record<string, any>;
  };
  persona: {
    name: string;
  };
  ui: {
    theme: string;
    font_size: number;
    sidebar_collapsed: boolean;
    history_strip_visible: boolean;
  };
}

interface SettingsState {
  settings: Settings | null;
  loadSettings: (profileId: string) => Promise<void>;
  updateSettings: (profileId: string, newSettings: Partial<Settings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loadSettings: async (profileId: string) => {
    const settings = await window.api.getSettings(profileId);
    set({ settings });
  },
  updateSettings: async (profileId: string, newSettings: Partial<Settings>) => {
    const current = get().settings;
    if (!current) return;
    const merged = { ...current, ...newSettings };
    await window.api.saveSettings(profileId, merged);
    set({ settings: merged });
  }
}));
