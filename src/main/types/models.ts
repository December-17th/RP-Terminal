import type { ModeLayouts } from '../../shared/workspaceLayout'
import type { ModelRates } from '../../shared/usageTypes'
import type { CardRenderMode, CardSizing } from '../../shared/cardRenderMode'

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
  /** Requests-per-minute ceiling for this connection; 0/unset = unlimited. Enforced per
   *  ENDPOINT (presets sharing an endpoint share one budget) by delaying, never dropping. */
  rpm_limit?: number
  /** Max simultaneous in-flight requests for this connection; 0/unset = unlimited. Same
   *  per-endpoint keying as rpm_limit — RPM bounds send rate, this bounds parallelism. */
  max_concurrent?: number
}

/** A saved, named user persona. The active one is mirrored into `Settings.persona`. */
export interface PersonaPreset {
  id: string
  /** Display name — expands `{{user}}`. */
  name: string
  /** Free-text bio — expands `{{persona}}`, injected (IN_PROMPT) when `inject` is on. */
  description: string
  /** Whether to inject the description into the prompt (false = ST's "None" position). */
  inject: boolean
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
    /** Mirrors the active preset's rpm_limit (0/unset = unlimited). */
    rpm_limit?: number
    /** Mirrors the active preset's max_concurrent (0/unset = unlimited). */
    max_concurrent?: number
  }
  // Saved connection presets the user can switch between.
  api_presets: ApiPreset[]
  active_api_preset_id: string
  // Saved user personas the user can switch between.
  personas: PersonaPreset[]
  active_persona_id: string
  // The live/active persona used by generation. Mirrors the selected persona preset.
  persona: {
    name: string
    /** Free-text bio for {{user}}, injected into the prompt when `inject` is on. */
    description: string
    /** Whether to inject the persona description into the prompt. */
    inject: boolean
    /** @deprecated Legacy @depth injection; only IN_PROMPT is supported now. Kept for back-compat reads. */
    depth?: number | null
  }
  generation: {
    /** Max estimated input tokens for the assembled prompt; oldest history is trimmed to fit. */
    max_context_tokens: number
    /**
     * Merge consecutive messages of the SAME role into one before sending (default true) — matches
     * SillyTavern's prompt assembly. A preset that splits a block across adjacent same-role entries
     * (e.g. `<{{user}}_setting>` / body / `</{{user}}_setting>`) then arrives as one coherent message
     * instead of N fragments. Off = send each preset block as its own message (raw).
     */
    merge_consecutive_roles?: boolean
    /**
     * Send `system` messages as `user` (default false). Only takes effect on the OpenAI-compatible path
     * (openai/openrouter/custom) — Gemini behind an OpenAI-compat layer handles a `system` role poorly, so
     * this matches SillyTavern's demotion. No-op for native Anthropic/Gemini connections (they shape system
     * via their own params). Applied before the role-merge.
     */
    system_as_user?: boolean
  }
  lorebook: {
    /** How many recent turns (floors) to scan for keyword matches. */
    scan_depth: number
    /** Max recursive match passes fed by matched entries' content (0 = off). */
    max_recursion: number
  }
  /** SQL-table memory (manual-pass issue 04): the global default maintenance cadence a template table
   *  with `updateFrequency === -1` ("use global") runs at. Mirrors the 数据库-plugin global default. */
  tables: {
    default_update_frequency: number
    /** WS4: global default row cap for the per-table memory block injected into the MAIN narrative
     *  prompt (the 'recent' policy). A per-table `injectionPolicy.rows` overrides it. Default 20. */
    injection_max_rows: number
    /** When true (default), a new session with no memory-table template assigned pops a one-time
     *  reminder to set one. Disabled globally from Settings (or the popup's "don't remind me"). */
    remind_set_template?: boolean
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
  /** Card rendering: the global default mode + sizing for scripted beautification cards. */
  cards: {
    renderMode: CardRenderMode
    sizing: CardSizing
  }
  /** Per-mode generation tuning for the manual FSM (Explore/Dialogue/Combat). */
  modes: Record<string, ModeConfig>
  /** How the agentic FSM operates: off (classic) / manual / agentic (see AgentMode). */
  agent: {
    mode: AgentMode
  }
  /** Project Yuzu (ADR 0008 §7): VN play-mode tuning. In VN mode the output ceiling is this value,
   *  VERBATIM — it REPLACES the preset's max_tokens (a classic-chat concern). Absent/invalid ⇒ 30000
   *  (see settingsService.resolveYuzuMaxTokens). Classic mode never reads this. */
  yuzu?: {
    max_tokens?: number
  }
  /** Combat (Track Combat): an optional steering prompt for end-of-combat narration (which always
   *  lands as a new floor). A card's `combat` bundle (`narration_prompt`) overrides these. */
  combat?: {
    narrationPrompt?: string
    /** Steers the freeform-action / mid-fight-exit adjudication; card overrides it. */
    improvisePrompt?: string
  }
  ui: {
    theme: string
    /** App-UI language (the i18n locale id, e.g. 'en' / 'zh'). Card content is separate. */
    locale: string
    font_size: number
    sidebar_collapsed: boolean
    history_strip_visible: boolean
    show_fps: boolean
    /** Floating token/cache meter overlay. */
    usage_meter: {
      enabled: boolean
      /** Persisted drag position (px from top-left); null = default bottom-left. */
      x: number | null
      y: number | null
      collapsed: boolean
      /** Which metric rows the overlay shows (keys from the meter field catalog). */
      fields: string[]
    }
    /** History/diagnostics 'usage' workspace view config. */
    usage_view: {
      columns: string[]
      charts: string[]
    }
  }
  /** Reconfigurable panel workspace: a saved split-tree layout per FSM mode (renderer-only). */
  workspace: {
    layouts: ModeLayouts
  }
  /** Prompt-cache optimization dial (see docs/prompt-cache-optimization-design.md).
   *  The whole system is STASHED (low prio, 2026-06-26) — the selector is greyed out and pinned to
   *  `baseline`. `mode` is the user-facing setting; `level`/`l1_mode` are the (dormant) Frozen-Core internals. */
  cache: {
    /**
     * Optimization mode (selector greyed out; default + pinned to `baseline`):
     *  - `baseline`  — NO optimization at all, NOT even provider-side prompt caching (we omit Anthropic
     *                  cache_control). A clean reference control for measuring everything else against.
     *  - `provider`  — provider prefix caching as-is (Anthropic cache_control on); no app-side frozen core.
     *  - `frozen`    — L1 "Frozen Core" app-side layering (experimental/dormant — stashed).
     */
    mode: 'baseline' | 'provider' | 'frozen'
    /** 0 = baseline, 1 = Frozen Core (2/3 reserved for later phases). Derived from `mode` (frozen → 1). */
    level: number
    /** L1 sub-mode: 'partition' (placeholder state in the frontier) | 'diff' (floor-0 state). */
    l1_mode: 'partition' | 'diff'
    /** Reserved for provider realization (Anthropic cache_control TTL). */
    ttl: '5m' | '1h'
    /** Reserved: pre-warm the cache at chat open. */
    prewarm: boolean
    /** Reserved: place Anthropic breakpoints at the true stable boundary. */
    breakpoint_optimizer: boolean
  }
  /** Optional per-model token prices ($ / 1M tokens). Empty ⇒ tokens-only (no cost shown). */
  pricing: Record<string, ModelRates>
  /** Diagnostics logging. */
  logs?: {
    /** Capture FULL, untruncated log detail (request prompts / AI responses). Default false —
     *  detail is otherwise bounded per-entry and by a ring byte-budget to keep memory in check. */
    full_trace?: boolean
  }
  /** Forensic execution records (st-preset-compat issue 09): one per generation, kept for a rolling
   *  window. See settingsService.resolveExecutionRecordRetention. */
  records?: {
    /** How many recent generations to keep the execution record for, PER chat (older are pruned).
     *  Default 50; 0 disables (keeps none); absent/invalid ⇒ the default. */
    retention?: number
  }
}
