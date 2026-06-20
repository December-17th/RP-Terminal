import React from 'react'
import { useSettingsStore, ApiPreset, Settings } from '../stores/settingsStore'

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'custom', label: 'Custom (OpenAI Compatible)' }
]

const CONNECTION_KEYS = ['provider', 'endpoint', 'api_key', 'model'] as const

/**
 * API tab — a library of saved connection presets. The selected preset is the live
 * connection used by generation (mirrored into settings.api). Edits autosave to the
 * active preset; switch presets to swap providers/keys/models in one click.
 */
export const ApiSettingsPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { settings, updateSettings } = useSettingsStore()
  if (!settings) return null

  const presets = settings.api_presets
  const active = presets.find((p) => p.id === settings.active_api_preset_id) ?? presets[0]
  if (!active) return null

  // Edit the active preset; connection fields also mirror into settings.api (used by generation).
  const editActive = (patch: Partial<ApiPreset>): void => {
    const nextPresets = presets.map((p) => (p.id === active.id ? { ...p, ...patch } : p))
    const apiPatch: Record<string, any> = {}
    for (const k of CONNECTION_KEYS) if (k in patch) apiPatch[k] = (patch as any)[k]
    updateSettings(profileId, {
      api_presets: nextPresets,
      ...(Object.keys(apiPatch).length ? { api: { ...settings.api, ...apiPatch } } : {})
    })
  }

  const mirror = (p: ApiPreset): Settings['api'] => ({
    ...settings.api,
    provider: p.provider,
    endpoint: p.endpoint,
    api_key: p.api_key,
    model: p.model
  })

  const selectPreset = (id: string): void => {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    updateSettings(profileId, { active_api_preset_id: id, api: mirror(p) })
  }

  const newPreset = (): void => {
    const id = crypto.randomUUID()
    const created: ApiPreset = {
      id,
      name: 'New API Preset',
      provider: settings.api.provider,
      endpoint: settings.api.endpoint,
      api_key: settings.api.api_key,
      model: settings.api.model
    }
    updateSettings(profileId, {
      api_presets: [...presets, created],
      active_api_preset_id: id,
      api: mirror(created)
    })
  }

  const deletePreset = (): void => {
    if (presets.length <= 1) return
    const remaining = presets.filter((p) => p.id !== active.id)
    updateSettings(profileId, {
      api_presets: remaining,
      active_api_preset_id: remaining[0].id,
      api: mirror(remaining[0])
    })
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>API</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">API Preset</label>
        <div className="preset-select-row">
          <select value={active.id} onChange={(e) => selectPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-actions">
          <button onClick={newPreset}>+ New</button>
          <button
            className="btn-ghost danger"
            disabled={presets.length <= 1}
            title={presets.length <= 1 ? 'Keep at least one preset' : 'Delete this preset'}
            onClick={() => {
              if (confirm(`Delete API preset "${active.name}"?`)) deletePreset()
            }}
          >
            Delete
          </button>
        </div>

        <label className="field-label" style={{ marginTop: 14 }}>
          Preset Name
        </label>
        <input value={active.name} onChange={(e) => editActive({ name: e.target.value })} />

        <label className="field-label" style={{ marginTop: 14 }}>
          Provider
        </label>
        <select
          value={active.provider}
          onChange={(e) => editActive({ provider: e.target.value })}
          style={{ width: '100%', marginBottom: 10 }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        <label className="field-label">Endpoint URL</label>
        <input
          type="text"
          placeholder="https://api.openai.com/v1"
          value={active.endpoint}
          onChange={(e) => editActive({ endpoint: e.target.value })}
          style={{ marginBottom: 10 }}
        />

        <label className="field-label">API Key</label>
        <input
          type="password"
          placeholder="sk-..."
          value={active.api_key}
          onChange={(e) => editActive({ api_key: e.target.value })}
          style={{ marginBottom: 10 }}
        />

        <label className="field-label">Model</label>
        <input
          type="text"
          placeholder="e.g. gpt-4o"
          value={active.model}
          onChange={(e) => editActive({ model: e.target.value })}
        />

        <label className="field-label" style={{ marginTop: 16 }}>
          Max Context (tokens)
        </label>
        <input
          type="number"
          min={1000}
          step={1000}
          placeholder="32000"
          value={settings.generation?.max_context_tokens ?? 32000}
          onChange={(e) =>
            updateSettings(profileId, {
              generation: {
                ...settings.generation,
                max_context_tokens: Number(e.target.value) || 32000
              }
            })
          }
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          Oldest turns are trimmed to keep the prompt under this estimate. Raise it for
          large-context models.
        </div>
      </div>
    </div>
  )
}
