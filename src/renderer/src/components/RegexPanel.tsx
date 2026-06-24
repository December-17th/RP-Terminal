import React, { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { ScopeSection } from './ScopeSection'
import {
  useRegexStore,
  RegexRuleDetail,
  RegexRulePatch,
  RegexScriptInfo,
  ArtifactScope
} from '../stores/regexStore'
import type { CardRenderMode } from '../../../shared/cardRenderMode'

interface Props {
  profileId: string
  /** Active world (card) + chat — the owners a script binds to for world/session scope. */
  activeCardId: string | null
  activeChatId: string | null
}

const SCOPES: { key: ArtifactScope; title: string; hint: string }[] = [
  { key: 'global', title: 'Global', hint: 'every session' },
  { key: 'world', title: 'World', hint: 'this card' },
  { key: 'session', title: 'Session', hint: 'this chat' }
]

export const RegexPanel: React.FC<Props> = ({ profileId, activeCardId, activeChatId }) => {
  const { scripts, loadScripts, importScripts, remove, updateRule, setScope, setDisabled, setRenderMode } =
    useRegexStore()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rules, setRules] = useState<Record<string, RegexRuleDetail[]>>({})
  const [editing, setEditing] = useState<RegexRuleDetail | null>(null)

  useEffect(() => {
    loadScripts(profileId)
  }, [profileId])

  const fetchRules = async (file: string): Promise<void> => {
    const r = await window.api.getRegexRules(profileId, file)
    setRules((cur) => ({ ...cur, [file]: r || [] }))
  }

  const toggleExpand = async (file: string): Promise<void> => {
    if (expanded === file) {
      setExpanded(null)
      return
    }
    setExpanded(file)
    if (!rules[file]) await fetchRules(file)
  }

  const patchRule = async (rule: RegexRuleDetail, patch: RegexRulePatch): Promise<void> => {
    await updateRule(profileId, rule.file, rule.index, patch)
    await fetchRules(rule.file)
  }

  // world binds the script to the active card; session to the active chat; global to none.
  const changeScope = (file: string, scope: ArtifactScope): void => {
    const owner = scope === 'world' ? activeCardId : scope === 'session' ? activeChatId : undefined
    setScope(profileId, file, scope, owner ?? undefined)
  }

  const changeRenderMode = (file: string, v: string): void => {
    setRenderMode(profileId, file, v === '' ? null : (v as CardRenderMode))
  }

  const renderScript = (s: RegexScriptInfo): React.ReactNode => {
    const ownedElsewhere =
      (s.scope === 'world' || s.scope === 'session') &&
      s.owner !== (s.scope === 'world' ? activeCardId : activeChatId)
    return (
      <div key={s.file} className={`entry-card ${s.disabled ? 'disabled' : ''}`}>
        <div className="entry-head">
          <input
            type="checkbox"
            checked={!s.disabled}
            title={s.disabled ? 'Script disabled' : 'Script enabled'}
            onChange={() => setDisabled(profileId, s.file, !s.disabled)}
          />
          <div className="entry-head-main" onClick={() => toggleExpand(s.file)}>
            <span className="entry-title">{s.scriptName}</span>
            <span className="entry-keys-preview">
              {s.ruleCount} rule{s.ruleCount === 1 ? '' : 's'}
            </span>
          </div>
          <select
            className="scope-select"
            value={s.scope}
            title="Scope — World binds to the active card; Session to the active chat."
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => changeScope(s.file, e.target.value as ArtifactScope)}
          >
            <option value="global">Global</option>
            <option value="world" disabled={!activeCardId}>
              World
            </option>
            <option value="session" disabled={!activeChatId}>
              Session
            </option>
          </select>
          <select
            className="scope-select"
            value={s.renderMode ?? ''}
            title="Render mode — how this card's UI is displayed (Default follows Settings)."
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => changeRenderMode(s.file, e.target.value)}
          >
            <option value="">Default</option>
            <option value="inline">Inline</option>
            <option value="isolated">Isolated</option>
          </select>
          {ownedElsewhere && (
            <span className="entry-keys-preview" title="Bound to a different world/session">
              other {s.scope}
            </span>
          )}
          <button className="btn-ghost" onClick={() => toggleExpand(s.file)}>
            {expanded === s.file ? '▾' : '▸'}
          </button>
          <button
            className="btn-ghost danger"
            title="Delete script"
            onClick={() => {
              if (confirm(`Delete regex script "${s.scriptName}"?`)) remove(profileId, s.file)
            }}
          >
            🗑
          </button>
        </div>
        {expanded === s.file && (
          <div className="entry-body" style={{ display: 'block' }}>
            {(rules[s.file] || []).length === 0 ? (
              <div style={{ opacity: 0.6, fontStyle: 'italic' }}>No rules in this script.</div>
            ) : (
              (rules[s.file] || []).map((r) => (
                <div key={r.index} className={`prompt-row ${r.disabled ? 'disabled' : ''}`}>
                  <div className="prompt-row-head">
                    <input
                      type="checkbox"
                      checked={!r.disabled}
                      title={r.disabled ? 'Disabled' : 'Enabled'}
                      onChange={() => patchRule(r, { disabled: !r.disabled })}
                    />
                    <span
                      className="prompt-name"
                      title="Edit rule"
                      onClick={() => setEditing(r)}
                      style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                    >
                      /{r.source || '(empty)'}/{r.flags}
                    </span>
                    {r.promptOnly && <span className="role-badge">prompt</span>}
                    <div className="prompt-actions">
                      <button className="btn-ghost" title="Edit" onClick={() => setEditing(r)}>
                        ✎
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

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
          the model&apos;s raw output. Toggle a whole script on/off, set its scope, or expand to
          edit individual rules.
        </div>
        {scripts.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
            No scripts. Import a SillyTavern regex JSON.
          </div>
        ) : (
          SCOPES.map(({ key, title, hint }) => {
            const inScope = scripts.filter((s) => s.scope === key)
            return (
              <ScopeSection
                key={key}
                title={title}
                hint={hint}
                count={inScope.length}
                defaultOpen={key !== 'session'}
              >
                {inScope.length === 0 ? (
                  <div style={{ opacity: 0.55, fontStyle: 'italic', padding: '4px 2px' }}>
                    No {title.toLowerCase()} regex.
                  </div>
                ) : (
                  inScope.map(renderScript)
                )}
              </ScopeSection>
            )
          })
        )}
      </div>

      {editing && (
        <RuleEditor
          rule={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await patchRule(editing, patch)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

const RuleEditor: React.FC<{
  rule: RegexRuleDetail
  onClose: () => void
  onSave: (patch: RegexRulePatch) => void
}> = ({ rule, onClose, onSave }) => {
  const [source, setSource] = useState(rule.source)
  const [flags, setFlags] = useState(rule.flags)
  const [replace, setReplace] = useState(rule.replace)
  const [trim, setTrim] = useState(rule.trimStrings.join(', '))
  const [markdownOnly, setMarkdownOnly] = useState(rule.markdownOnly)
  const [promptOnly, setPromptOnly] = useState(rule.promptOnly)

  return (
    <Modal
      title={`Edit Rule — ${rule.scriptName}`}
      onClose={onClose}
      headerActions={
        <button
          className="btn-accent"
          onClick={() =>
            onSave({
              source,
              flags,
              replace,
              markdownOnly,
              promptOnly,
              trimStrings: trim
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            })
          }
        >
          Save
        </button>
      }
    >
      <label className="field-label">Find (regex)</label>
      <input value={source} onChange={(e) => setSource(e.target.value)} />

      <label className="field-label">Flags</label>
      <input value={flags} onChange={(e) => setFlags(e.target.value)} placeholder="g" />

      <label className="field-label">Replace</label>
      <textarea
        className="modal-textarea"
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        placeholder="$1 = capture group · {{match}} = matched text · {{user}}/{{char}} · \n = newline"
      />

      <label className="field-label">
        Trim strings (comma-separated; removed from {'{{match}}'})
      </label>
      <input value={trim} onChange={(e) => setTrim(e.target.value)} placeholder="e.g. *, _" />

      <div className="entry-toggles">
        <label>
          <input
            type="checkbox"
            checked={markdownOnly}
            onChange={(e) => setMarkdownOnly(e.target.checked)}
          />
          Markdown only (display)
        </label>
        <label>
          <input
            type="checkbox"
            checked={promptOnly}
            onChange={(e) => setPromptOnly(e.target.checked)}
          />
          Prompt only (not applied to display)
        </label>
      </div>
    </Modal>
  )
}
