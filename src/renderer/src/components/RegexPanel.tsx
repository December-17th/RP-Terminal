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
import { useT } from '../i18n'

interface Props {
  profileId: string
  /** Active world (card) + chat — the owners a script binds to for world/session scope. */
  activeCardId: string | null
  activeChatId: string | null
}

const SCOPES: { key: ArtifactScope; titleKey: string; hintKey: string }[] = [
  { key: 'global', titleKey: 'scope.global', hintKey: 'scope.globalHint' },
  { key: 'world', titleKey: 'scope.world', hintKey: 'scope.worldHint' },
  { key: 'session', titleKey: 'scope.session', hintKey: 'scope.sessionHint' }
]

export const RegexPanel: React.FC<Props> = ({ profileId, activeCardId, activeChatId }) => {
  const {
    scripts,
    loadScripts,
    importScripts,
    remove,
    updateRule,
    setScope,
    setDisabled,
    setRenderMode
  } = useRegexStore()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rules, setRules] = useState<Record<string, RegexRuleDetail[]>>({})
  const [editing, setEditing] = useState<RegexRuleDetail | null>(null)
  const t = useT()

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
            title={s.disabled ? t('regex.scriptDisabled') : t('regex.scriptEnabled')}
            onChange={() => setDisabled(profileId, s.file, !s.disabled)}
          />
          <div className="entry-head-main" onClick={() => toggleExpand(s.file)}>
            <span className="entry-title">{s.scriptName}</span>
            <span className="entry-keys-preview">
              {s.ruleCount === 1
                ? t('regex.ruleOne', { count: s.ruleCount })
                : t('regex.ruleMany', { count: s.ruleCount })}
            </span>
          </div>
          <select
            className="scope-select"
            value={s.scope}
            title={t('regex.scopeTitle')}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => changeScope(s.file, e.target.value as ArtifactScope)}
          >
            <option value="global">{t('scope.global')}</option>
            <option value="world" disabled={!activeCardId}>
              {t('scope.world')}
            </option>
            <option value="session" disabled={!activeChatId}>
              {t('scope.session')}
            </option>
          </select>
          <select
            className="scope-select"
            value={s.renderMode ?? ''}
            title={t('regex.renderModeTitle')}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => changeRenderMode(s.file, e.target.value)}
          >
            <option value="">{t('regex.renderDefault')}</option>
            <option value="inline">{t('regex.renderInline')}</option>
            <option value="isolated">{t('regex.renderIsolated')}</option>
          </select>
          {ownedElsewhere && (
            <span className="entry-keys-preview" title={t('regex.boundElsewhere')}>
              {t('regex.otherScope', { scope: t('scope.' + s.scope) })}
            </span>
          )}
          <button className="btn-ghost" onClick={() => toggleExpand(s.file)}>
            {expanded === s.file ? '▾' : '▸'}
          </button>
          <button
            className="btn-ghost danger"
            title={t('regex.deleteScript')}
            onClick={() => {
              if (confirm(t('regex.confirmDelete', { name: s.scriptName })))
                remove(profileId, s.file)
            }}
          >
            🗑
          </button>
        </div>
        {expanded === s.file && (
          <div className="entry-body" style={{ display: 'block' }}>
            {(rules[s.file] || []).length === 0 ? (
              <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('regex.noRules')}</div>
            ) : (
              (rules[s.file] || []).map((r) => (
                <div key={r.index} className={`prompt-row ${r.disabled ? 'disabled' : ''}`}>
                  <div className="prompt-row-head">
                    <input
                      type="checkbox"
                      checked={!r.disabled}
                      title={r.disabled ? t('common.disabled') : t('common.enabled')}
                      onChange={() => patchRule(r, { disabled: !r.disabled })}
                    />
                    <span
                      className="prompt-name"
                      title={t('regex.editRuleHint')}
                      onClick={() => setEditing(r)}
                      style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                    >
                      /{r.source || t('regex.emptyPattern')}/{r.flags}
                    </span>
                    {r.promptOnly && <span className="role-badge">{t('regex.promptBadge')}</span>}
                    <div className="prompt-actions">
                      <button
                        className="btn-ghost"
                        title={t('common.edit')}
                        onClick={() => setEditing(r)}
                      >
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
        <h3>{t('regex.heading')}</h3>
        <div className="panel-header-actions">
          <button onClick={() => importScripts(profileId)}>{t('common.import')}</button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.82em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          {t('regex.help')}
        </div>
        {scripts.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{t('regex.noScripts')}</div>
        ) : (
          SCOPES.map(({ key, titleKey, hintKey }) => {
            const inScope = scripts.filter((s) => s.scope === key)
            return (
              <ScopeSection
                key={key}
                title={t(titleKey)}
                hint={t(hintKey)}
                count={inScope.length}
                defaultOpen={key !== 'session'}
              >
                {inScope.length === 0 ? (
                  <div style={{ opacity: 0.55, fontStyle: 'italic', padding: '4px 2px' }}>
                    {t('regex.noneInScope')}
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
  const t = useT()

  return (
    <Modal
      title={t('regex.editRuleTitle', { name: rule.scriptName })}
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
          {t('common.save')}
        </button>
      }
    >
      <label className="field-label">{t('regex.find')}</label>
      <input value={source} onChange={(e) => setSource(e.target.value)} />

      <label className="field-label">{t('regex.flags')}</label>
      <input value={flags} onChange={(e) => setFlags(e.target.value)} placeholder="g" />

      <label className="field-label">{t('regex.replace')}</label>
      <textarea
        className="modal-textarea"
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        placeholder={t('regex.replacePh')}
      />

      <label className="field-label">{t('regex.trim')}</label>
      <input
        value={trim}
        onChange={(e) => setTrim(e.target.value)}
        placeholder={t('regex.trimPh')}
      />

      <div className="entry-toggles">
        <label>
          <input
            type="checkbox"
            checked={markdownOnly}
            onChange={(e) => setMarkdownOnly(e.target.checked)}
          />
          {t('regex.markdownOnly')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={promptOnly}
            onChange={(e) => setPromptOnly(e.target.checked)}
          />
          {t('regex.promptOnly')}
        </label>
      </div>
    </Modal>
  )
}
