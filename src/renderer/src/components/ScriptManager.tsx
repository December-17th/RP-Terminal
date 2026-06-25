import React, { useEffect, useState } from 'react'
import { useCharacterStore } from '../stores/characterStore'
import { useT } from '../i18n'

interface Props {
  profileId: string
  characterId: string
  characterName: string
  /** The active character's full card (read source for the scripts list). */
  card: any
}

interface Draft {
  name: string
  code: string
  enabled?: boolean
}

const readScripts = (card: any): Draft[] => {
  const arr = card?.data?.extensions?.rp_terminal?.scripts
  return Array.isArray(arr)
    ? arr.map((s: any) => ({ name: s?.name || '', code: s?.code || '', enabled: s?.enabled }))
    : []
}

/**
 * Edit the card scripts that power the P1 runtime (right-panel ⚙ Card Scripts).
 * Scripts live inside the card (`data.extensions.rp_terminal.scripts`), so saving
 * writes the whole card back via the character store. See docs/plugin-api.md for
 * the `rpt.v1` API available to a script.
 */
export const ScriptManager: React.FC<Props> = ({ profileId, characterId, characterName, card }) => {
  const [drafts, setDrafts] = useState<Draft[]>(() => readScripts(card))
  const [dirty, setDirty] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(0)
  const t = useT()

  // Re-seed when switching characters (or when the card changes underneath us).
  useEffect(() => {
    setDrafts(readScripts(card))
    setDirty(false)
    setExpanded(0)
  }, [characterId])

  const mutate = (next: Draft[]): void => {
    setDrafts(next)
    setDirty(true)
  }

  const addScript = (): void => {
    mutate([...drafts, { name: `script-${drafts.length + 1}`, code: '' }])
    setExpanded(drafts.length)
  }

  const updateScript = (i: number, patch: Partial<Draft>): void =>
    mutate(drafts.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  const deleteScript = (i: number): void => {
    mutate(drafts.filter((_, idx) => idx !== i))
    setExpanded(null)
  }

  const save = async (): Promise<void> => {
    const next = JSON.parse(JSON.stringify(card))
    next.data = next.data || {}
    next.data.extensions = next.data.extensions || {}
    next.data.extensions.rp_terminal = next.data.extensions.rp_terminal || {}
    next.data.extensions.rp_terminal.scripts = drafts.map((s) => ({
      name: s.name.trim() || 'script',
      code: s.code,
      ...(s.enabled === false ? { enabled: false } : {})
    }))
    await useCharacterStore.getState().saveCard(profileId, characterId, next)
    setDirty(false)
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 title={t('sm.headingTitle', { name: characterName })}>
          {t('sm.heading', { name: characterName })}
        </h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{t('common.unsaved')}</span>}
          <button onClick={addScript}>{t('sm.addScript')}</button>
          <button className="btn-accent" disabled={!dirty} onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          {t('sm.help')}
        </div>

        {drafts.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
            {t('sm.empty')}
          </div>
        ) : (
          drafts.map((s, i) => (
            <div key={i} className={`entry-card ${s.enabled === false ? 'disabled' : ''}`}>
              <div className="entry-head">
                <input
                  type="checkbox"
                  checked={s.enabled !== false}
                  title={s.enabled === false ? t('regex.scriptDisabled') : t('regex.scriptEnabled')}
                  onChange={() => updateScript(i, { enabled: s.enabled === false })}
                />
                <div
                  className="entry-head-main"
                  onClick={() => setExpanded((cur) => (cur === i ? null : i))}
                >
                  <span className="entry-title">{s.name || t('scripts.untitled')}</span>
                  <span className="entry-keys-preview">
                    {s.code.trim() ? t('sm.chars', { n: s.code.trim().length }) : t('sm.codeEmpty')}
                  </span>
                </div>
                <button
                  className="btn-ghost"
                  onClick={() => setExpanded((cur) => (cur === i ? null : i))}
                >
                  {expanded === i ? '▾' : '▸'}
                </button>
                <button
                  className="btn-ghost danger"
                  onClick={() => deleteScript(i)}
                  title={t('scripts.deleteScript')}
                >
                  🗑
                </button>
              </div>

              {expanded === i && (
                <div className="entry-body">
                  <label className="field-label">{t('common.name')}</label>
                  <input
                    value={s.name}
                    onChange={(e) => updateScript(i, { name: e.target.value })}
                    placeholder={t('scripts.namePh')}
                  />

                  <label className="field-label">{t('scripts.code')}</label>
                  <textarea
                    className="script-code"
                    spellCheck={false}
                    value={s.code}
                    onChange={(e) => updateScript(i, { code: e.target.value })}
                    placeholder={t('sm.codePh')}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
