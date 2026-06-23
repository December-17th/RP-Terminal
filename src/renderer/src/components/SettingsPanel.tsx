import React, { useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useSettingsStore, Settings } from '../stores/settingsStore'
import { PluginsPanel } from './PluginsPanel'

/**
 * Settings tab — profile switching/creation, UI preferences, and plugin management
 * (collapsed by default). API keys live in the API tab; persona has its own tab.
 */
export const SettingsPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { profiles, activeProfile, setActiveProfile, createProfile } = useProfileStore()
  const { settings, updateSettings } = useSettingsStore()
  const [newName, setNewName] = useState('')

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
        <h3>Settings</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">Profile</label>
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
            placeholder="New profile name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createIfNamed()}
          />
          <button onClick={createIfNamed}>+ Create</button>
        </div>
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          Switching profiles swaps characters, sessions, presets and settings.
        </div>

        {settings && (
          <>
            <label className="field-label" style={{ marginTop: 20 }}>
              Chat Font Size (px)
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
              Agent Mode
            </label>
            <select
              value={settings.agent?.mode ?? 'off'}
              onChange={(e) =>
                updateSettings(profileId, {
                  agent: { ...settings.agent, mode: e.target.value as Settings['agent']['mode'] }
                })
              }
              style={{ width: '100%' }}
            >
              <option value="off">Off (Classic)</option>
              <option value="manual">Manual</option>
              <option value="agentic">Agentic</option>
            </select>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              <b>Off</b>: classic — dynamic lore every turn, no scene modes. <b>Manual</b>: enables
              the Explore/Dialogue/Combat switcher with per-mode tuning + caching. <b>Agentic</b>:
              same, with automatic mode routing (auto-routing coming soon).
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
              Show FPS counter (bottom-right)
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
              Show token / cache meter (floating overlay)
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
              ST-Prompt-Template engine ({'<% %>'} templates in cards/presets/lorebook)
            </label>
            <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
              When off, EJS template tags are stripped instead of evaluated ({'{{macros}}'} still
              work).
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
                  Render-time eval (apply templates to AI output on display)
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
                      Live during streaming (rate-limited)
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
                      Final pass when streaming completes
                    </label>
                    <label className="field-label" style={{ marginTop: 10 }}>
                      Live eval cadence (≈ tokens)
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
                      During streaming, re-run the engine roughly every this many tokens (not per
                      token).
                    </div>
                  </>
                )}
              </div>
            )}

            <label className="field-label" style={{ marginTop: 18 }}>
              Lorebook Scan Depth (turns)
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
              How many recent turns are scanned for lorebook keywords.
            </div>

            <label className="field-label" style={{ marginTop: 14 }}>
              Lorebook Recursion Steps
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
              Matched entries&apos; content can trigger more entries, up to this many passes (0 =
              off).
            </div>
          </>
        )}

        {settings && (
          <details className="settings-section" style={{ marginTop: 20 }}>
            <summary>Token pricing ($ / 1M tokens)</summary>
            <div className="settings-section-body">
              <div
                style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 6 }}
              >
                Optional. Empty ⇒ the meter shows tokens only. Keyed by exact model id.
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
                    title="Remove"
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
                + Add row for "{settings.api?.model || 'current model'}"
              </button>
            </div>
          </details>
        )}

        <details className="settings-section" style={{ marginTop: 20 }}>
          <summary>Plugins</summary>
          <div className="settings-section-body">
            <PluginsPanel profileId={profileId} />
          </div>
        </details>
      </div>
    </div>
  )
}
