import React, { useEffect, useState } from 'react'
import { useCharacterStore } from '../stores/characterStore'

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
}

const readScripts = (card: any): Draft[] => {
  const arr = card?.data?.extensions?.rp_terminal?.scripts
  return Array.isArray(arr)
    ? arr.map((s: any) => ({ name: s?.name || '', code: s?.code || '' }))
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
      code: s.code
    }))
    await useCharacterStore.getState().saveCard(profileId, characterId, next)
    setDirty(false)
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 title={`Scripts — ${characterName}`}>Scripts · {characterName}</h3>
        <div className="panel-header-actions">
          {dirty && <span style={{ fontSize: '0.8em', opacity: 0.7 }}>unsaved</span>}
          <button onClick={addScript}>+ Script</button>
          <button className="btn-accent" disabled={!dirty} onClick={save}>
            Save
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          Sandboxed JavaScript that runs with this card. It renders into the right-panel{' '}
          <b>⚙ Card Scripts</b> while a session is open and uses the <code>rpt</code> API (vars,
          chat, generate, ui). No network access. See <code>docs/plugin-api.md</code>.
        </div>

        {drafts.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
            No scripts yet. Click “+ Script” to add one.
          </div>
        ) : (
          drafts.map((s, i) => (
            <div key={i} className="entry-card">
              <div className="entry-head">
                <div
                  className="entry-head-main"
                  onClick={() => setExpanded((cur) => (cur === i ? null : i))}
                >
                  <span className="entry-title">{s.name || 'Untitled script'}</span>
                  <span className="entry-keys-preview">
                    {s.code.trim() ? `${s.code.trim().length} chars` : 'empty'}
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
                  title="Delete script"
                >
                  🗑
                </button>
              </div>

              {expanded === i && (
                <div className="entry-body">
                  <label className="field-label">Name</label>
                  <input
                    value={s.name}
                    onChange={(e) => updateScript(i, { name: e.target.value })}
                    placeholder="e.g. stats-panel"
                  />

                  <label className="field-label">Code (JavaScript)</label>
                  <textarea
                    className="script-code"
                    spellCheck={false}
                    value={s.code}
                    onChange={(e) => updateScript(i, { code: e.target.value })}
                    placeholder="// rpt.on('ready', () => { ... })"
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
