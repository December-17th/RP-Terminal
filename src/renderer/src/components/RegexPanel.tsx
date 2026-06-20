import React, { useEffect } from 'react'
import { useRegexStore } from '../stores/regexStore'

interface Props {
  profileId: string
}

export const RegexPanel: React.FC<Props> = ({ profileId }) => {
  const { scripts, loadScripts, importScripts, remove } = useRegexStore()

  useEffect(() => {
    loadScripts(profileId)
  }, [profileId])

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Regex</h3>
        <div className="panel-header-actions">
          <button onClick={() => importScripts(profileId)}>Import</button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.82em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          SillyTavern regex scripts transform the AI&apos;s output for display (e.g. the
          <em> 美化</em> beautification cards). Applied at render time — the stored history keeps
          the model&apos;s raw output.
        </div>
        {scripts.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
            No scripts. Import a SillyTavern regex JSON.
          </div>
        ) : (
          scripts.map((s) => (
            <div key={s.file} className="panel-list-row">
              <div className="panel-list-item" style={{ cursor: 'default' }}>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.scriptName}
                </div>
                <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)' }}>
                  {s.ruleCount} rule{s.ruleCount === 1 ? '' : 's'}
                </div>
              </div>
              <button
                className="btn-ghost danger row-del"
                title="Delete script"
                onClick={() => {
                  if (confirm(`Delete regex script "${s.scriptName}"?`)) remove(profileId, s.file)
                }}
              >
                🗑
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
