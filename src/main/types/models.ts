export interface Profile {
  id: string
  name: string
  avatar_path?: string
  password_hash?: string
  created_at: string
  last_active: string
}

export interface Settings {
  api: {
    provider: string
    endpoint: string
    api_key: string
    model: string
    default_params: Record<string, any>
  }
  persona: {
    name: string
  }
  generation: {
    /** Max estimated input tokens for the assembled prompt; oldest history is trimmed to fit. */
    max_context_tokens: number
  }
  ui: {
    theme: string
    font_size: number
    sidebar_collapsed: boolean
    history_strip_visible: boolean
    show_fps: boolean
  }
}
