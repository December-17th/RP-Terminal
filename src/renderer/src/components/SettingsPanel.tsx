import React, { useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useSettingsStore } from '../stores/settingsStore'
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
          </>
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
