import type { ModeLayouts } from '../../shared/workspaceLayout'

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

/** How the agentic FSM operates:
 *  - 'off'     — classic: no FSM, ST-style dynamic lore re-matched every turn.
 *  - 'manual'  — FSM on; the user switches Explore/Dialogue/Combat by hand.
 *  - 'agentic' — FSM on + automatic mode routing (auto-router TBD; behaves like
 *    'manual' until that lands). */
export type AgentMode = 'off' | 'manual' | 'agentic'

/** Per-mode generation tuning for the manual FSM (Phase H). Keyed by ChatMode. */
export interface ModeConfig {
  /** Output-token ceiling for this mode (caps the active preset's max_tokens). */
  max_output_tokens: number
  /** How many recent turns to scan for lorebook keywords while in this mode. */
  scan_depth: number
  /** Optional system instruction injected while the session is in this mode. */
  addendum: string
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
  /** ST-Prompt-Template EJS engine (`<% %>` template processing) on/off. */
  templates: {
    enabled: boolean
    /** Render-time eval (Phase C): apply the engine to AI output as it displays. */
    render: {
      enabled: boolean
      /** Re-eval live during streaming (rate-limited), not just on complete. */
      live: boolean
      /** Live-eval cadence: re-eval after roughly this many new tokens (not per token). */
      rate_tokens: number
      /** Run one eval pass when streaming completes. */
      final_pass: boolean
    }
  }
  /** Per-mode generation tuning for the manual FSM (Explore/Dialogue/Combat). */
  modes: Record<string, ModeConfig>
  /** How the agentic FSM operates: off (classic) / manual / agentic (see AgentMode). */
  agent: {
    mode: AgentMode
  }
  ui: {
    theme: string
    font_size: number
    sidebar_collapsed: boolean
    history_strip_visible: boolean
    show_fps: boolean
  }
  /** Reconfigurable panel workspace: a saved split-tree layout per FSM mode (renderer-only). */
  workspace: {
    layouts: ModeLayouts
  }
}
