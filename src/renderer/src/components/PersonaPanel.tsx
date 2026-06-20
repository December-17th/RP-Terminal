import React from 'react'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * Persona tab — who {{user}} is. The name replaces {{user}}; the description is an
 * optional bio injected into the prompt (and available as {{persona}}).
 */
export const PersonaPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { settings, updateSettings } = useSettingsStore()
  if (!settings) return null

  const persona = settings.persona
  const patch = (p: Partial<typeof persona>): void => {
    updateSettings(profileId, { persona: { ...settings.persona, ...p } })
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Persona</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">Name</label>
        <input
          type="text"
          placeholder="User"
          value={persona.name ?? 'User'}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          Replaces {'{{user}}'} in prompts, cards and lorebooks.
        </div>

        <label className="field-label" style={{ marginTop: 16 }}>
          Description / Bio
        </label>
        <textarea
          className="entry-content"
          placeholder="Who you are in this story — appearance, background, personality. Supports {{char}} / {{user}}."
          value={persona.description ?? ''}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          Injected into the prompt so the model knows who you are. Also available as{' '}
          {'{{persona}}'} in authored content.
        </div>

        <label
          className="entry-toggles"
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}
        >
          <input
            type="checkbox"
            checked={persona.inject !== false}
            onChange={(e) => patch({ inject: e.target.checked })}
          />
          Inject description into the prompt
        </label>

        <label className="field-label" style={{ marginTop: 16 }}>
          Injection Depth
        </label>
        <input
          type="number"
          min={0}
          placeholder="top"
          value={persona.depth ?? ''}
          onChange={(e) => patch({ depth: e.target.value === '' ? null : Number(e.target.value) })}
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          Messages up from the bottom of the chat. Blank = at the top, before the conversation.
        </div>
      </div>
    </div>
  )
}
