import React from 'react'
import { useSettingsStore, ApiPreset, Settings } from '../stores/settingsStore'
import { useToastStore } from '../stores/toastStore'
import { useT } from '../i18n'

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
  const { settings, updateSettings, loadSettings } = useSettingsStore()
  const [models, setModels] = React.useState<string[]>([])
  const [fetching, setFetching] = React.useState(false)
  const [replacingKey, setReplacingKey] = React.useState(false)
  const t = useT()
  if (!settings) return null

  const presets = settings.api_presets
  const active = presets.find((p) => p.id === settings.active_api_preset_id) ?? presets[0]
  if (!active) return null

  // Ask the provider for its available models (GET /models, provider-aware) to fill the dropdown.
  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    try {
      const list: string[] = await window.api.listModels(
        { provider: active.provider, endpoint: active.endpoint, api_key: active.api_key },
        profileId
      )
      setModels(list)
      if (!list.length) useToastStore.getState().push(t('api.noModels'))
    } catch (e) {
      useToastStore
        .getState()
        .push(t('api.fetchFailed') + (e instanceof Error ? e.message : String(e)))
    } finally {
      setFetching(false)
    }
  }

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
    setReplacingKey(false)
    updateSettings(profileId, { active_api_preset_id: id, api: mirror(p) })
  }

  const newPreset = (): void => {
    setReplacingKey(false)
    const id = crypto.randomUUID()
    const created: ApiPreset = {
      id,
      name: 'New API Preset',
      provider: settings.api.provider,
      endpoint: settings.api.endpoint,
      api_key: '', // a new preset gets its own key (the active one is masked, not a real value)
      model: settings.api.model
    }
    updateSettings(profileId, {
      api_presets: [...presets, created],
      active_api_preset_id: id,
      api: mirror(created)
    })
  }

  const deletePreset = (): void => {
    setReplacingKey(false)
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
        <h3>{t('api.heading')}</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">{t('api.preset')}</label>
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
          <button onClick={newPreset}>{t('common.new')}</button>
          <button
            className="btn-ghost danger"
            disabled={presets.length <= 1}
            title={presets.length <= 1 ? t('api.keepOne') : t('api.deletePreset')}
            onClick={() => {
              if (confirm(t('api.confirmDelete', { name: active.name }))) deletePreset()
            }}
          >
            {t('common.delete')}
          </button>
        </div>

        <label className="field-label" style={{ marginTop: 14 }}>
          {t('api.presetName')}
        </label>
        <input value={active.name} onChange={(e) => editActive({ name: e.target.value })} />

        <label className="field-label" style={{ marginTop: 14 }}>
          {t('api.provider')}
        </label>
        <select
          value={active.provider}
          onChange={(e) => {
            editActive({ provider: e.target.value })
            setModels([]) // a fetched list is provider-specific
          }}
          style={{ width: '100%', marginBottom: 10 }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        <label className="field-label">{t('api.endpoint')}</label>
        <input
          type="text"
          placeholder="https://api.openai.com/v1"
          value={active.endpoint}
          onChange={(e) => editActive({ endpoint: e.target.value })}
          style={{ marginBottom: 10 }}
        />

        <label className="field-label">{t('api.apiKey')}</label>
        {active.api_key.includes('•') && !replacingKey ? (
          // A stored key is shown masked (≥2/3 hidden); the real key lives encrypted in main. "Replace"
          // swaps in an editable field for a new key — which is the only time the key is shown in full.
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              type="text"
              readOnly
              value={active.api_key}
              title={t('api.keyStored')}
              style={{ flex: 1, fontFamily: 'monospace', opacity: 0.8 }}
            />
            <button onClick={() => setReplacingKey(true)}>{t('api.replace')}</button>
          </div>
        ) : (
          <input
            type="text"
            placeholder="sk-..."
            autoFocus={replacingKey}
            value={active.api_key.includes('•') ? '' : active.api_key}
            onChange={(e) => editActive({ api_key: e.target.value })}
            // On leaving the field, re-fetch the masked view (the value already autosaved) so the key
            // doesn't stay visible after entry.
            onBlur={() => {
              setReplacingKey(false)
              loadSettings(profileId)
            }}
            style={{ marginBottom: 10 }}
          />
        )}

        <label className="field-label">{t('api.model')}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            placeholder={t('api.modelPh')}
            value={active.model}
            onChange={(e) => editActive({ model: e.target.value })}
            style={{ flex: 1 }}
          />
          <button
            onClick={fetchModels}
            disabled={fetching || !active.api_key}
            title={active.api_key ? t('api.fetchTitle') : t('api.fetchNeedKey')}
          >
            {fetching ? t('api.fetching') : t('api.fetchModels')}
          </button>
        </div>
        {models.length > 0 && (
          <select
            value={models.includes(active.model) ? active.model : ''}
            onChange={(e) => e.target.value && editActive({ model: e.target.value })}
            style={{ width: '100%', marginTop: 6 }}
          >
            <option value="">{t('api.pickModel', { count: models.length })}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}

        <label className="field-label" style={{ marginTop: 16 }}>
          {t('api.maxContext')}
        </label>
        <input
          type="number"
          min={1000}
          step={1000}
          placeholder="200000"
          value={settings.generation?.max_context_tokens ?? 200000}
          onChange={(e) =>
            updateSettings(profileId, {
              generation: {
                ...settings.generation,
                max_context_tokens: Number(e.target.value) || 200000
              }
            })
          }
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          {t('api.maxContextHint')}
        </div>
      </div>
    </div>
  )
}
