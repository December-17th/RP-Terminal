import React from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useT } from '../i18n'

/**
 * Persona tab — who {{user}} is. The name replaces {{user}}; the description is an
 * optional bio injected into the prompt (and available as {{persona}}).
 */
export const PersonaPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { settings, updateSettings } = useSettingsStore()
  const t = useT()
  if (!settings) return null

  const persona = settings.persona
  const patch = (p: Partial<typeof persona>): void => {
    updateSettings(profileId, { persona: { ...settings.persona, ...p } })
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('persona.heading')}</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">{t('persona.name')}</label>
        <input
          type="text"
          placeholder={t('persona.namePh')}
          value={persona.name ?? 'User'}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          {t('persona.nameHint')}
        </div>

        <label className="field-label" style={{ marginTop: 16 }}>
          {t('persona.description')}
        </label>
        <textarea
          className="entry-content"
          placeholder={t('persona.descriptionPh')}
          value={persona.description ?? ''}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          {t('persona.descriptionHint')}
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
          {t('persona.inject')}
        </label>

        <label className="field-label" style={{ marginTop: 16 }}>
          {t('persona.depth')}
        </label>
        <input
          type="number"
          min={0}
          placeholder={t('persona.depthPh')}
          value={persona.depth ?? ''}
          onChange={(e) => patch({ depth: e.target.value === '' ? null : Number(e.target.value) })}
        />
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          {t('persona.depthHint')}
        </div>
      </div>
    </div>
  )
}
