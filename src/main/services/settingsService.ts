import { getDb } from './db'
import { Settings } from '../types/models'

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
  persona: {
    name: 'User'
  },
  generation: {
    max_context_tokens: 32000
  },
  ui: {
    theme: 'dark',
    font_size: 16,
    sidebar_collapsed: false,
    history_strip_visible: true
  }
})

export const getSettings = (profileId: string): Settings => {
  const row = getDb()
    .prepare('SELECT data FROM settings WHERE profile_id = ?')
    .get(profileId) as { data: string } | undefined
  if (!row) return getDefaultSettings()
  try {
    return { ...getDefaultSettings(), ...JSON.parse(row.data) }
  } catch {
    return getDefaultSettings()
  }
}

export const saveSettings = (profileId: string, settings: Settings): void => {
  getDb()
    .prepare(
      `INSERT INTO settings (profile_id, data) VALUES (?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data`
    )
    .run(profileId, JSON.stringify(settings))
}
