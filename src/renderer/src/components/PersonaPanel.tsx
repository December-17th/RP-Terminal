import React from 'react'
import { useSettingsStore, PersonaPreset, Settings } from '../stores/settingsStore'
import { useT } from '../i18n'

/**
 * Persona tab — a library of user personas (who {{user}} is). The active persona's name
 * replaces {{user}}; its description is an optional bio injected into the prompt (IN_PROMPT)
 * and available as {{persona}}. `settings.persona` mirrors the active entry — see settingsService.
 */
export const PersonaPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { settings, updateSettings } = useSettingsStore()
  const t = useT()
  if (!settings) return null

  const personas = settings.personas
  const active = personas.find((p) => p.id === settings.active_persona_id) ?? personas[0]
  if (!active) return null

  // Project a persona into the mirror consumed by generation (parity with settingsService).
  const mirror = (p: PersonaPreset): Settings['persona'] => ({
    name: p.name,
    description: p.description,
    inject: p.inject
  })

  // Edit the active persona; also refresh the mirror so generation sees the change immediately.
  const editActive = (patch: Partial<PersonaPreset>): void => {
    const next = personas.map((p) => (p.id === active.id ? { ...p, ...patch } : p))
    const updated = { ...active, ...patch }
    updateSettings(profileId, { personas: next, persona: mirror(updated) })
  }

  const selectPersona = (id: string): void => {
    const p = personas.find((x) => x.id === id)
    if (!p) return
    updateSettings(profileId, { active_persona_id: id, persona: mirror(p) })
  }

  const newPersona = (): void => {
    const created: PersonaPreset = {
      id: crypto.randomUUID(),
      name: t('persona.newName'),
      description: '',
      inject: true
    }
    updateSettings(profileId, {
      personas: [...personas, created],
      active_persona_id: created.id,
      persona: mirror(created)
    })
  }

  const deletePersona = (): void => {
    if (personas.length <= 1) return
    const remaining = personas.filter((p) => p.id !== active.id)
    updateSettings(profileId, {
      personas: remaining,
      active_persona_id: remaining[0].id,
      persona: mirror(remaining[0])
    })
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('persona.heading')}</h3>
      </div>
      <div className="panel-body">
        <label className="field-label">{t('persona.select')}</label>
        <div className="preset-select-row">
          <select value={active.id} onChange={(e) => selectPersona(e.target.value)}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-actions">
          <button onClick={newPersona}>{t('common.new')}</button>
          <button
            className="btn-ghost danger"
            disabled={personas.length <= 1}
            title={personas.length <= 1 ? t('persona.keepOne') : t('common.delete')}
            onClick={() => {
              if (confirm(t('persona.confirmDelete', { name: active.name }))) deletePersona()
            }}
          >
            {t('common.delete')}
          </button>
        </div>

        <label className="field-label" style={{ marginTop: 16 }}>
          {t('persona.name')}
        </label>
        <input
          type="text"
          placeholder={t('persona.namePh')}
          value={active.name}
          onChange={(e) => editActive({ name: e.target.value })}
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
          value={active.description}
          onChange={(e) => editActive({ description: e.target.value })}
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
            checked={active.inject !== false}
            onChange={(e) => editActive({ inject: e.target.checked })}
          />
          {t('persona.inject')}
        </label>
      </div>
    </div>
  )
}
