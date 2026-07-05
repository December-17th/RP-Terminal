import { safeStorage } from 'electron'
import { getDb } from './db'
import { Settings, ApiPreset, ModeConfig, AgentMode } from '../types/models'

// API keys are encrypted at rest via the OS keyring (Electron safeStorage). A
// stored value is prefixed so encrypted keys are distinguishable from legacy
// plaintext, which is migrated transparently: read as-is, re-encrypted on the
// next save. If the keyring is unavailable, keys fall back to plaintext.
const ENC_PREFIX = 'enc:v1:'

export const encryptSecret = (plain: string): string => {
  if (!plain || plain.startsWith(ENC_PREFIX)) return plain
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    // keyring unavailable — fall through to storing plaintext
  }
  return plain
}

export const decryptSecret = (stored: string): string => {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored || ''
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    // Can't decrypt (moved machines / different OS user) — drop the stale key.
    return ''
  }
}

/** Apply a transform to every api_key field (the live api block + every preset). */
const mapApiKeys = (s: Settings, fn: (k: string) => string): Settings => ({
  ...s,
  api: { ...s.api, api_key: fn(s.api.api_key) },
  api_presets: s.api_presets.map((p) => ({ ...p, api_key: fn(p.api_key) }))
})

// API keys are only ever shown to the UI in FULL when first entered; afterward the renderer receives a
// MASKED value (≥ 2/3 hidden) and the real key stays encrypted in main. A save that sends a masked/empty
// value back means "unchanged" → the stored key is retained. So the full key never round-trips the UI.
const MASK_CHAR = '•'
export const isMaskedKey = (k: string): boolean => !!k && k.includes(MASK_CHAR)

/** Mask a plaintext key for display: at most ~1/3 visible (first/last few chars), the rest hidden.
 *  Guarantees ≥ 2/3 masked; the middle is a fixed run so the key's length isn't revealed either. */
export const maskSecret = (plain: string): string => {
  const k = plain || ''
  if (!k) return ''
  const visible = Math.min(8, Math.floor(k.length / 3))
  if (visible < 2) return MASK_CHAR.repeat(8)
  const front = Math.ceil(visible / 2)
  const back = visible - front
  return k.slice(0, front) + MASK_CHAR.repeat(8) + (back ? k.slice(k.length - back) : '')
}

/** A copy of settings with every api key masked (for sending to the renderer). */
export const maskedSettings = (s: Settings): Settings => mapApiKeys(s, maskSecret)

export const getDefaultSettings = (): Settings => ({
  api: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-3.5-turbo'
  },
  api_presets: [],
  active_api_preset_id: '',
  persona: {
    name: 'User',
    description: '',
    inject: true,
    depth: null
  },
  generation: {
    max_context_tokens: 200000,
    merge_consecutive_roles: true,
    system_as_user: false
  },
  lorebook: {
    scan_depth: 3,
    max_recursion: 0
  },
  // SQL-table memory (manual-pass issue 04): the frequency a template table with updateFrequency -1
  // ("use global") maintains at. Mirrors the 数据库-plugin global default.
  tables: { default_update_frequency: 3 },
  templates: {
    enabled: true,
    render: {
      enabled: true,
      live: true,
      rate_tokens: 500,
      final_pass: true
    }
  },
  cards: {
    renderMode: 'inline',
    sizing: 'fit'
  },
  // FSM modes (Phase H). Explore = wide retrieval + descriptive; Dialogue = tighter;
  // Combat = terse (mechanics are resolved by the engine, not narrated numbers).
  modes: {
    explore: { max_output_tokens: 1200, scan_depth: 4, addendum: '' },
    dialogue: { max_output_tokens: 700, scan_depth: 3, addendum: '' },
    combat: {
      max_output_tokens: 450,
      scan_depth: 2,
      addendum:
        'Combat mode: keep narration terse and reactive. Do not invent dice rolls or numeric outcomes — mechanics are resolved by the system.'
    }
  },
  // Classic by default: ST-style dynamic lore, no FSM. Manual/agentic are opt-in.
  agent: {
    mode: 'off'
  },
  // Combat: end-of-combat narration always lands as a new floor; a card or the user can supply a
  // steering prompt.
  combat: {
    narrationPrompt: '',
    improvisePrompt: ''
  },
  ui: {
    theme: 'dark',
    locale: 'en',
    font_size: 16,
    sidebar_collapsed: false,
    history_strip_visible: true,
    show_fps: false,
    usage_meter: {
      enabled: false,
      x: null,
      y: null,
      collapsed: false,
      fields: ['proxyPct', 'cacheHitPct', 'promptTokens', 'avgCacheHitPct']
    },
    usage_view: {
      columns: [
        'promptTokens',
        'proxyPct',
        'cacheHitPct',
        'cacheRead',
        'cacheWrite',
        'outputTokens'
      ],
      charts: ['cachePct']
    }
  },
  // Panel-workspace layouts are seeded by the renderer (it owns the view ids); main
  // just persists whatever the renderer saved. Empty here = "use built-in defaults".
  workspace: { layouts: {} },
  cache: {
    // Default + pinned to `baseline` (no optimization, not even provider caching) — the cache system is
    // stashed (selector greyed out). See docs/prompt-cache-optimization-design.md.
    mode: 'baseline',
    level: 0,
    l1_mode: 'partition',
    ttl: '5m',
    prewarm: false,
    breakpoint_optimizer: false
  },
  pricing: {}
})

/**
 * Merge stored settings over the defaults (per-section, so adding a new nested
 * field doesn't wipe a section), and ensure at least one API preset exists —
 * seeding one from the live `api` block so pre-presets profiles migrate cleanly.
 */
export const normalize = (stored: Partial<Settings>): Settings => {
  const d = getDefaultSettings()
  const api = { ...d.api, ...(stored.api || {}) }
  const persona = { ...d.persona, ...(stored.persona || {}) }
  const generation = { ...d.generation, ...(stored.generation || {}) }
  const lorebook = { ...d.lorebook, ...(stored.lorebook || {}) }
  const tables = { ...d.tables, ...(stored.tables || {}) }
  const storedTemplates = (stored.templates || {}) as Partial<Settings['templates']>
  const templates = {
    ...d.templates,
    ...storedTemplates,
    // Merge render separately so adding a render field never wipes the sub-object.
    render: { ...d.templates.render, ...(storedTemplates.render || {}) }
  }
  const storedUi = (stored.ui || {}) as Partial<Settings['ui']>
  const ui = {
    ...d.ui,
    ...storedUi,
    usage_meter: { ...d.ui.usage_meter, ...(storedUi.usage_meter || {}) },
    usage_view: { ...d.ui.usage_view, ...(storedUi.usage_view || {}) }
  }
  // Preserve the renderer's saved per-mode layouts verbatim (normalize otherwise drops
  // unknown keys, since it returns an explicit allowlist of fields below).
  const workspace = { layouts: stored.workspace?.layouts || {} }
  // Cache: merge stored over defaults, then coerce an unknown/missing `mode` to the stashed default
  // `baseline`, and keep `level` consistent with `mode` (frozen → 1, else 0) so the dormant Frozen-Core
  // internals can't be left half-on. (The selector is greyed out, so `mode` only changes via stored data.)
  const cache = { ...d.cache, ...(stored.cache || {}) }
  if (cache.mode !== 'provider' && cache.mode !== 'frozen') cache.mode = 'baseline'
  cache.level = cache.mode === 'frozen' ? cache.level || 1 : 0
  const cards = { ...d.cards, ...(stored.cards || {}) }
  const combat = { ...d.combat, ...(stored.combat || {}) }
  const pricing = { ...d.pricing, ...(stored.pricing || {}) }

  // Agent mode: accept the three-way enum; migrate the legacy boolean `enabled` toggle
  // (true → manual), else default off.
  const storedAgent = (stored.agent || {}) as { mode?: string; enabled?: boolean }
  const validAgentModes: AgentMode[] = ['off', 'manual', 'agentic']
  const agentMode: AgentMode = validAgentModes.includes(storedAgent.mode as AgentMode)
    ? (storedAgent.mode as AgentMode)
    : storedAgent.enabled === true
      ? 'manual'
      : 'off'
  const agent = { mode: agentMode }

  // Merge each known mode over its default so adding a tuning field never wipes a mode.
  const storedModes = (stored.modes || {}) as Record<string, Partial<ModeConfig>>
  const modes: Record<string, ModeConfig> = {}
  for (const key of Object.keys(d.modes)) {
    modes[key] = { ...d.modes[key], ...(storedModes[key] || {}) }
  }

  let api_presets: ApiPreset[] = Array.isArray(stored.api_presets) ? stored.api_presets : []
  let active_api_preset_id = stored.active_api_preset_id || ''

  if (api_presets.length === 0) {
    // Deterministic id so repeated reads before the first save stay stable.
    const id = 'default'
    api_presets = [
      {
        id,
        name: 'Default',
        provider: api.provider,
        endpoint: api.endpoint,
        api_key: api.api_key,
        model: api.model,
        rpm_limit: api.rpm_limit,
        max_concurrent: api.max_concurrent
      }
    ]
    active_api_preset_id = id
  }
  if (!api_presets.some((p) => p.id === active_api_preset_id)) {
    active_api_preset_id = api_presets[0].id
  }

  return {
    api,
    api_presets,
    active_api_preset_id,
    persona,
    generation,
    lorebook,
    tables,
    templates,
    modes,
    agent,
    ui,
    workspace,
    cache,
    cards,
    combat,
    pricing
  }
}

/** The tuning config for a mode, falling back to Explore (then defaults) for unknown modes. */
export const resolveModeConfig = (settings: Settings, mode: string): ModeConfig =>
  settings.modes?.[mode] || settings.modes?.explore || getDefaultSettings().modes.explore

export const getSettings = (profileId: string): Settings => {
  const row = getDb().prepare('SELECT data FROM settings WHERE profile_id = ?').get(profileId) as
    | { data: string }
    | undefined
  let stored: Partial<Settings> = {}
  if (row) {
    try {
      stored = JSON.parse(row.data)
    } catch {
      stored = {}
    }
  }
  // Decrypt api keys so the renderer always works with plaintext.
  return mapApiKeys(normalize(stored), decryptSecret)
}

/** Read the stored settings WITHOUT decrypting — to retain still-encrypted keys on save. */
const readStoredEncrypted = (profileId: string): Settings => {
  const row = getDb().prepare('SELECT data FROM settings WHERE profile_id = ?').get(profileId) as
    | { data: string }
    | undefined
  let stored: Partial<Settings> = {}
  if (row) {
    try {
      stored = JSON.parse(row.data)
    } catch {
      stored = {}
    }
  }
  return normalize(stored)
}

export const saveSettings = (profileId: string, settings: Settings): void => {
  // The renderer only holds MASKED keys (or a freshly-typed real one). A masked/empty incoming value
  // means "unchanged" → keep the stored encrypted key (the api mirror tracks the active preset's key);
  // a real value gets encrypted. The full key therefore never has to round-trip through the renderer.
  const prev = readStoredEncrypted(profileId)
  const prevById = new Map(prev.api_presets.map((p) => [p.id, p.api_key]))
  const resolve = (incoming: string, stored: string | undefined): string =>
    !incoming || isMaskedKey(incoming) ? stored || '' : encryptSecret(incoming)
  const toStore: Settings = {
    ...settings,
    api: {
      ...settings.api,
      api_key: resolve(settings.api.api_key, prevById.get(settings.active_api_preset_id))
    },
    api_presets: settings.api_presets.map((p) => ({
      ...p,
      api_key: resolve(p.api_key, prevById.get(p.id))
    }))
  }
  getDb()
    .prepare(
      `INSERT INTO settings (profile_id, data) VALUES (?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data`
    )
    .run(profileId, JSON.stringify(toStore))
}
