import { safeStorage } from 'electron'
import { getDb } from './db'
import { Settings, ApiPreset } from '../types/models'

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
    max_context_tokens: 32000
  },
  ui: {
    theme: 'dark',
    font_size: 16,
    sidebar_collapsed: false,
    history_strip_visible: true,
    show_fps: false
  }
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
  const ui = { ...d.ui, ...(stored.ui || {}) }

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
        model: api.model
      }
    ]
    active_api_preset_id = id
  }
  if (!api_presets.some((p) => p.id === active_api_preset_id)) {
    active_api_preset_id = api_presets[0].id
  }

  return { api, api_presets, active_api_preset_id, persona, generation, ui }
}

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

export const saveSettings = (profileId: string, settings: Settings): void => {
  const toStore = mapApiKeys(settings, encryptSecret)
  getDb()
    .prepare(
      `INSERT INTO settings (profile_id, data) VALUES (?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data`
    )
    .run(profileId, JSON.stringify(toStore))
}
