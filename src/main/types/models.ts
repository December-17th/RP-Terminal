export interface Profile {
  id: string
  name: string
  avatar_path?: string
  password_hash?: string
  created_at: string
  last_active: string
}

/** A saved, named API connection. The active one is mirrored into `Settings.api`. */
export interface ApiPreset {
  id: string
  name: string
  provider: string
  endpoint: string
  api_key: string
  model: string
}

export interface Settings {
  // The live/active connection used by generation. Mirrors the selected api_preset.
  api: {
    provider: string
    endpoint: string
    api_key: string
    model: string
  }
  // Saved connection presets the user can switch between.
  api_presets: ApiPreset[]
  active_api_preset_id: string
  persona: {
    name: string
    /** Free-text bio for {{user}}, injected into the prompt when `inject` is on. */
    description: string
    /** Whether to inject the persona description into the prompt. */
    inject: boolean
    /** Injection depth (messages from the bottom); null = at the top, before history. */
    depth: number | null
  }
  generation: {
    /** Max estimated input tokens for the assembled prompt; oldest history is trimmed to fit. */
    max_context_tokens: number
  }
  lorebook: {
    /** How many recent turns (floors) to scan for keyword matches. */
    scan_depth: number
    /** Max recursive match passes fed by matched entries' content (0 = off). */
    max_recursion: number
  }
  ui: {
    theme: string
    font_size: number
    sidebar_collapsed: boolean
    history_strip_visible: boolean
    show_fps: boolean
  }
}
