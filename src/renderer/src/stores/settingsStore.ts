import { create } from 'zustand';

export interface ApiPreset {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  api_key: string;
  model: string;
}

export interface Settings {
  api: {
    provider: string;
    endpoint: string;
    api_key: string;
    model: string;
  };
  api_presets: ApiPreset[];
  active_api_preset_id: string;
  persona: {
    name: string;
    description: string;
    inject: boolean;
    depth: number | null;
  };
  generation: {
    max_context_tokens: number;
  };
  lorebook: {
    scan_depth: number;
    max_recursion: number;
  };
  agent: {
    mode: 'off' | 'manual' | 'agentic';
  };
  ui: {
    theme: string;
    font_size: number;
    sidebar_collapsed: boolean;
    history_strip_visible: boolean;
    show_fps: boolean;
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
