import React, { useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useSettingsStore, Settings } from '../stores/settingsStore'
import { PluginsPanel } from './PluginsPanel'
import { THEME_LIST } from '../theme'
import { LOCALE_LIST, useT } from '../i18n'

/**
 * Settings tab — profile switching/creation, UI preferences, and plugin management
 * (collapsed by default). API keys live in the API tab; persona has its own tab.
 */
export const SettingsPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { profiles, activeProfile, setActiveProfile, createProfile } = useProfileStore()
  const { settings, updateSettings } = useSettingsStore()
  const [newName, setNewName] = useState('')
  const t = useT()

  const createIfNamed = (): void => {
    const name = newName.trim()
    if (!name) return
    createProfile(name)
    setNewName('')
  }

  // Patch a field of the nested templates.render block (render-time eval settings).
  const updateRender = (patch: Partial<Settings['templates']['render']>): void => {
    if (!settings) return
    updateSettings(profileId, {
      templates: { ...settings.templates, render: { ...settings.templates.render, ...patch } }
    })
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('settings.preferences')}</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">{t('prefs.profile')}</label>
        <div className="preset-select-row">
          <select
            value={activeProfile?.id ?? ''}
            onChange={(e) => {
              const p = profiles.find((x) => x.id === e.target.value)
              if (p) setActiveProfile(p)
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-actions">
          <input
            value={newName}
            placeholder={t('prefs.newProfileName')}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createIfNamed()}
          />
          <button onClick={createIfNamed}>{t('prefs.create')}</button>
        </div>
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          {t('prefs.profileHint')}
        </div>

        {settings && (
          <>
            <label className="field-label" style={{ marginTop: 20 }}>
              {t('prefs.theme')}
            </label>
            <select
              value={settings.ui?.theme ?? 'dark'}
              onChange={(e) =>
                updateSettings(profileId, { ui: { ...settings.ui, theme: e.target.value } })
              }
              style={{ width: '100%' }}
            >
              {THEME_LIST.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.language')}
            </label>
            <select
              value={settings.ui?.locale ?? 'en'}
              onChange={(e) =>
                updateSettings(profileId, { ui: { ...settings.ui, locale: e.target.value } })
              }
              style={{ width: '100%' }}
            >
              {LOCALE_LIST.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.fontSize')}
            </label>
            <input
              type="number"
              min={10}
              max={28}
              value={settings.ui?.font_size ?? 16}
              onChange={(e) =>
                updateSettings(profileId, {
                  ui: { ...settings.ui, font_size: Number(e.target.value) || 16 }
                })
              }
            />

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.agentMode')}{' '}
              <span style={{ opacity: 0.5, fontWeight: 'normal' }}>
                ({t('prefs.agentComingSoon')})
              </span>
            </label>
            {/* Disabled until Gameplay Mode (FSM scene routing) is implemented. */}
            <select
              value={settings.agent?.mode ?? 'off'}
              disabled
              title={t('prefs.agentDisabledTitle')}
              onChange={(e) =>
                updateSettings(profileId, {
                  agent: { ...settings.agent, mode: e.target.value as Settings['agent']['mode'] }
                })
              }
              style={{ width: '100%' }}
            >
              <option value="off">{t('prefs.agentOff')}</option>
              <option value="manual">{t('prefs.agentManual')}</option>
              <option value="agentic">{t('prefs.agentAgentic')}</option>
            </select>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.agentHint')}
            </div>

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.cardRendering')}
            </label>
            <select
              value={settings.cards?.renderMode ?? 'inline'}
              onChange={(e) =>
                updateSettings(profileId, {
                  cards: {
                    renderMode: e.target.value as 'inline' | 'isolated',
                    sizing: settings.cards?.sizing ?? 'fit'
                  }
                })
              }
              style={{ width: '100%' }}
            >
              <option value="inline">{t('prefs.cardInline')}</option>
              <option value="isolated">{t('prefs.cardIsolated')}</option>
            </select>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.cardRenderingHint')}
            </div>

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.cardSizing')}
            </label>
            <select
              value={settings.cards?.sizing ?? 'fit'}
              onChange={(e) =>
                updateSettings(profileId, {
                  cards: {
                    renderMode: settings.cards?.renderMode ?? 'inline',
                    sizing: e.target.value as 'fit' | 'fill'
                  }
                })
              }
              style={{ width: '100%' }}
            >
              <option value="fit">{t('prefs.sizeFit')}</option>
              <option value="fill">{t('prefs.sizeFill')}</option>
            </select>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.cardSizingHint')}
            </div>

            <label
              className="entry-toggles"
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 }}
            >
              <input
                type="checkbox"
                checked={settings.ui?.show_fps ?? false}
                onChange={(e) =>
                  updateSettings(profileId, {
                    ui: { ...settings.ui, show_fps: e.target.checked }
                  })
                }
              />
              {t('prefs.showFps')}
            </label>

            <label
              className="entry-toggles"
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}
            >
              <input
                type="checkbox"
                checked={settings.ui?.usage_meter?.enabled ?? false}
                onChange={(e) =>
                  updateSettings(profileId, {
                    ui: {
                      ...settings.ui,
                      usage_meter: { ...settings.ui.usage_meter, enabled: e.target.checked }
                    }
                  })
                }
              />
              {t('prefs.showUsageMeter')}
            </label>

            <label
              className="entry-toggles"
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}
            >
              <input
                type="checkbox"
                checked={settings.templates?.enabled ?? true}
                onChange={(e) =>
                  updateSettings(profileId, {
                    templates: { ...settings.templates, enabled: e.target.checked }
                  })
                }
              />
              {t('prefs.templateEngine')}
            </label>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.templateEngineHint')}
            </div>

            {settings.templates?.enabled !== false && (
              <div style={{ marginLeft: 22, marginTop: 8 }}>
                <label
                  className="entry-toggles"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <input
                    type="checkbox"
                    checked={settings.templates?.render?.enabled ?? true}
                    onChange={(e) => updateRender({ enabled: e.target.checked })}
                  />
                  {t('prefs.renderEval')}
                </label>
                {settings.templates?.render?.enabled !== false && (
                  <>
                    <label
                      className="entry-toggles"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.templates?.render?.live ?? true}
                        onChange={(e) => updateRender({ live: e.target.checked })}
                      />
                      {t('prefs.renderLive')}
                    </label>
                    <label
                      className="entry-toggles"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.templates?.render?.final_pass ?? true}
                        onChange={(e) => updateRender({ final_pass: e.target.checked })}
                      />
                      {t('prefs.renderFinal')}
                    </label>
                    <label className="field-label" style={{ marginTop: 10 }}>
                      {t('prefs.renderCadence')}
                    </label>
                    <input
                      type="number"
                      min={50}
                      value={settings.templates?.render?.rate_tokens ?? 500}
                      onChange={(e) => updateRender({ rate_tokens: Number(e.target.value) || 500 })}
                    />
                    <div
                      style={{
                        fontSize: '0.78em',
                        color: 'var(--rpt-text-secondary)',
                        marginTop: 4
                      }}
                    >
                      {t('prefs.renderCadenceHint')}
                    </div>
                  </>
                )}
              </div>
            )}

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.scanDepth')}
            </label>
            <input
              type="number"
              min={1}
              value={settings.lorebook?.scan_depth ?? 3}
              onChange={(e) =>
                updateSettings(profileId, {
                  lorebook: { ...settings.lorebook, scan_depth: Number(e.target.value) || 1 }
                })
              }
            />
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.scanDepthHint')}
            </div>

            <label className="field-label" style={{ marginTop: 14 }}>
              {t('prefs.recursion')}
            </label>
            <input
              type="number"
              min={0}
              value={settings.lorebook?.max_recursion ?? 0}
              onChange={(e) =>
                updateSettings(profileId, {
                  lorebook: { ...settings.lorebook, max_recursion: Number(e.target.value) || 0 }
                })
              }
            />
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.recursionHint')}
            </div>

            <label className="field-label" style={{ marginTop: 18 }}>
              {t('prefs.cacheOpt')}{' '}
              <span style={{ opacity: 0.5, fontWeight: 'normal' }}>
                ({t('prefs.agentComingSoon')})
              </span>
            </label>
            {/* Disabled until the cache-optimization dial is exposed; pinned to baseline (level 0). */}
            <select
              value={String(settings.cache?.level ?? 0)}
              disabled
              title={t('prefs.cacheDisabledTitle')}
              onChange={(e) =>
                updateSettings(profileId, {
                  cache: { ...settings.cache, level: Number(e.target.value) }
                })
              }
              style={{ width: '100%' }}
            >
              <option value="0">{t('prefs.cacheBaseline')}</option>
              <option value="1">{t('prefs.cacheFrozenCore')}</option>
            </select>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              {t('prefs.cacheHint')}
            </div>
          </>
        )}

        {settings && (
          <details className="settings-section" style={{ marginTop: 20 }}>
            <summary>{t('prefs.pricing')}</summary>
            <div className="settings-section-body">
              <div
                style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 6 }}
              >
                {t('prefs.pricingHint')}
              </div>
              {Object.entries(settings.pricing ?? {}).map(([model, rates]) => (
                <div
                  key={model}
                  style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}
                >
                  <span style={{ flex: 1, fontSize: 12 }}>{model}</span>
                  {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((k) => (
                    <input
                      key={k}
                      type="number"
                      title={k}
                      style={{ width: 64 }}
                      value={rates[k]}
                      onChange={(e) =>
                        updateSettings(profileId, {
                          pricing: {
                            ...settings.pricing,
                            [model]: { ...rates, [k]: Number(e.target.value) || 0 }
                          }
                        })
                      }
                    />
                  ))}
                  <button
                    title={t('prefs.remove')}
                    onClick={() => {
                      const next = { ...(settings.pricing ?? {}) }
                      delete next[model]
                      updateSettings(profileId, { pricing: next })
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                style={{ marginTop: 6 }}
                onClick={() => {
                  const model = settings.api?.model || 'model-id'
                  if (settings.pricing?.[model]) return
                  updateSettings(profileId, {
                    pricing: {
                      ...settings.pricing,
                      [model]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
                    }
                  })
                }}
              >
                +{' '}
                {t('prefs.addPriceRow', { model: settings.api?.model || t('prefs.currentModel') })}
              </button>
            </div>
          </details>
        )}

        <details className="settings-section" style={{ marginTop: 20 }}>
          <summary>{t('prefs.plugins')}</summary>
          <div className="settings-section-body">
            <PluginsPanel profileId={profileId} />
          </div>
        </details>
      </div>
    </div>
  )
}
