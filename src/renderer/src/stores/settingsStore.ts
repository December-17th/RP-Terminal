import { create } from 'zustand'
import type { ModeLayouts } from '../../../shared/workspaceLayout'

export interface ApiPreset {
  id: string
  name: string
  provider: string
  endpoint: string
  api_key: string
  model: string
  /** Requests-per-minute ceiling; 0/unset = unlimited. Shared per endpoint (mirrors main). */
  rpm_limit?: number
}

/** One memory collection (mirrors main `MemoryCollection`). Core ships only `events`. */
export interface MemoryCollection {
  id: string
  shape: 'stream' | 'entity'
  enabled: boolean
  entityKey?: string
  write: {
    trigger: 'checkpoint' | 'every_turn' | 'on_change'
    prompt: string
    maxItemsPerCheckpoint?: number
  }
  retrieval: {
    mode: 'always' | 'keyword' | 'vector' | 'hybrid' | 'llm'
    count: number
    tokenBudget: number
  }
  inject: { label: string }
}

export interface Settings {
  api: {
    provider: string
    endpoint: string
    api_key: string
    model: string
    rpm_limit?: number
  }
  api_presets: ApiPreset[]
  active_api_preset_id: string
  persona: {
    name: string
    description: string
    inject: boolean
    depth: number | null
  }
  generation: {
    max_context_tokens: number
    merge_consecutive_roles?: boolean
    system_as_user?: boolean
  }
  lorebook: {
    scan_depth: number
    max_recursion: number
  }
  templates: {
    enabled: boolean
    render: {
      enabled: boolean
      live: boolean
      rate_tokens: number
      final_pass: boolean
    }
  }
  cards?: {
    renderMode: 'inline' | 'isolated'
    sizing: 'fit' | 'fill'
  }
  /** Prompt-cache optimization dial (mirrors main `Settings['cache']`). STASHED — greyed out, pinned to
   *  `baseline` (no optimization, not even provider caching). See docs/prompt-cache-optimization-design.md. */
  cache: {
    mode: 'baseline' | 'provider' | 'frozen'
    level: number
    l1_mode: 'partition' | 'diff'
    ttl: '5m' | '1h'
    prewarm: boolean
    breakpoint_optimizer: boolean
  }
  /** Long-term memory engine (mirrors main `Settings['memory']`). Disabled by default. */
  memory: {
    enabled: boolean
    collections: MemoryCollection[]
    max_tokens: number
    keep_recent: number
    checkpoint_turns: number
    checkpoint_tokens: number
    utility_api_preset_id: string
    embedding_api_preset_id: string
  }
  agent: {
    mode: 'off' | 'manual' | 'agentic'
  }
  /** Combat (Track Combat): how the AI's end-of-combat narration lands in the chat, and an
   *  optional author/user prompt that steers it. A card's `combat` bundle can override both. */
  combat?: {
    narrationMode?: 'append' | 'floor'
    narrationPrompt?: string
    improvisePrompt?: string
  }
  ui: {
    theme: string
    locale: string
    font_size: number
    sidebar_collapsed: boolean
    history_strip_visible: boolean
    show_fps: boolean
    usage_meter: {
      enabled: boolean
      x: number | null
      y: number | null
      collapsed: boolean
      fields: string[]
    }
    usage_view: {
      columns: string[]
      charts: string[]
    }
  }
  workspace?: { layouts: ModeLayouts }
  pricing?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
}

interface SettingsState {
  settings: Settings | null
  loadSettings: (profileId: string) => Promise<void>
  updateSettings: (profileId: string, newSettings: Partial<Settings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loadSettings: async (profileId: string) => {
    const settings = await window.api.getSettings(profileId)
    set({ settings })
  },
  updateSettings: async (profileId: string, newSettings: Partial<Settings>) => {
    const current = get().settings
    if (!current) return
    const merged = { ...current, ...newSettings }
    // Update state synchronously (optimistic) BEFORE the async persist. Controlled inputs read
    // their `value` from this state; if it only updated after the IPC round-trip, the input would
    // lag a tick behind each keystroke. That lag desyncs IME composition (e.g. Chinese pinyin),
    // making the input concatenate every intermediate composition string into gibberish.
    set({ settings: merged })
    await window.api.saveSettings(profileId, merged)
  }
}))
