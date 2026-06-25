import React, { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { ScopeSection } from './ScopeSection'
import { ScriptManager } from './ScriptManager'
import { useScriptsStore, ScriptInfo, ArtifactScope } from '../stores/scriptsStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useToastStore } from '../stores/toastStore'
import { useT } from '../i18n'

interface Props {
  profileId: string
  activeCardId: string | null
  activeCardName: string | null
  activeChatId: string | null
  /** The active card (source for read-only card-embedded scripts shown under World). */
  card: any
}

const SCOPES: { key: ArtifactScope; titleKey: string; hintKey: string }[] = [
  { key: 'global', titleKey: 'scope.global', hintKey: 'scope.globalHint' },
  { key: 'world', titleKey: 'scope.world', hintKey: 'scope.worldHint' },
  { key: 'session', titleKey: 'scope.session', hintKey: 'scope.sessionHint' }
]

/**
 * Profile-level Scripts library, organized by scope (Global / World / Session) — the
 * scripts counterpart to the Regex panel. Each script has an enable toggle + scope
 * selector. The World group also lists the active card's embedded scripts (read-only;
 * edit them via "Card scripts"). Script code may pull remote JS with an `// @import
 * https://…` directive, resolved at load with a per-world grant.
 */
export const ScriptsPanel: React.FC<Props> = ({
  profileId,
  activeCardId,
  activeCardName,
  activeChatId,
  card
}) => {
  const { scripts, load, add, update, setScope, setDisabled, remove } = useScriptsStore()
  const [editing, setEditing] = useState<ScriptInfo | null>(null)
  const [editCard, setEditCard] = useState(false)
  const t = useT()

  // Master on/off for the active world's script runtime (the toggle relocated from the
  // right-panel runtime so the right side stays game-UI only).
  const runtimeOn = useCardScriptsStore((s) =>
    activeCardId ? (s.enabledByCard[activeCardId] ?? true) : true
  )

  useEffect(() => {
    load(profileId)
  }, [profileId])

  useEffect(() => {
    if (activeCardId) useCardScriptsStore.getState().load(profileId, activeCardId)
  }, [profileId, activeCardId])

  const cardScripts: { name: string; code: string; enabled?: boolean }[] = Array.isArray(
    card?.data?.extensions?.rp_terminal?.scripts
  )
    ? card.data.extensions.rp_terminal.scripts
    : []

  const ownerFor = (scope: ArtifactScope): string | undefined =>
    scope === 'world'
      ? (activeCardId ?? undefined)
      : scope === 'session'
        ? (activeChatId ?? undefined)
        : undefined

  const addScript = async (scope: ArtifactScope): Promise<void> => {
    const file = await add(profileId, { name: 'new-script', code: '' }, scope, ownerFor(scope))
    // Re-read so the editor opens on the freshly-created script.
    const created = useScriptsStore.getState().scripts.find((s) => s.file === file)
    if (created) setEditing(created)
  }

  // Import Tavern Helper / native script JSON files. Default to World scope (bound to the
  // active card) when one is loaded — these scripts usually belong to a specific world —
  // else Global. The user can rescope afterward.
  const importScripts = async (): Promise<void> => {
    const scope: ArtifactScope = activeCardId ? 'world' : 'global'
    const n = await useScriptsStore.getState().importFiles(profileId, scope, ownerFor(scope))
    if (n)
      useToastStore.getState().push(
        t(n === 1 ? 'scripts.importedOne' : 'scripts.importedMany', {
          count: n,
          scope: t('scope.' + scope)
        })
      )
  }

  const changeScope = (s: ScriptInfo, scope: ArtifactScope): void => {
    setScope(profileId, s.file, scope, ownerFor(scope))
  }

  const renderRow = (s: ScriptInfo): React.ReactNode => {
    const ownedElsewhere =
      (s.scope === 'world' && s.owner !== activeCardId) ||
      (s.scope === 'session' && s.owner !== activeChatId)
    return (
      <div key={s.file} className={`prompt-row ${s.disabled ? 'disabled' : ''}`}>
        <div className="prompt-row-head">
          <input
            type="checkbox"
            checked={!s.disabled}
            title={s.disabled ? t('common.disabled') : t('common.enabled')}
            onChange={() => setDisabled(profileId, s.file, !s.disabled)}
          />
          <span
            className="prompt-name"
            title={t('scripts.editScript')}
            onClick={() => setEditing(s)}
          >
            {s.name || t('scripts.untitled')}
          </span>
          {s.remoteHosts.length > 0 && (
            <span
              className="role-badge"
              title={t('scripts.loadsRemote', { hosts: s.remoteHosts.join(', ') })}
            >
              ⬇ {s.remoteHosts.length}
            </span>
          )}
          {ownedElsewhere && (
            <span className="entry-keys-preview" title={t('regex.boundElsewhere')}>
              {t('regex.otherScope', { scope: t('scope.' + s.scope) })}
            </span>
          )}
          <div className="prompt-actions">
            <select
              className="scope-select"
              value={s.scope}
              title={t('scripts.scopeShort')}
              onChange={(e) => changeScope(s, e.target.value as ArtifactScope)}
            >
              <option value="global">{t('scope.global')}</option>
              <option value="world" disabled={!activeCardId}>
                {t('scope.world')}
              </option>
              <option value="session" disabled={!activeChatId}>
                {t('scope.session')}
              </option>
            </select>
            <button className="btn-ghost" title={t('common.edit')} onClick={() => setEditing(s)}>
              ✎
            </button>
            <button
              className="btn-ghost danger"
              title={t('scripts.deleteScript')}
              onClick={() => {
                if (confirm(t('scripts.confirmDelete', { name: s.name }))) remove(profileId, s.file)
              }}
            >
              🗑
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('scripts.heading')}</h3>
        <div className="panel-header-actions">
          <button onClick={importScripts} title={t('scripts.importTitle')}>
            {t('common.import')}
          </button>
          {activeCardId && (
            <button
              className={`rpt-script-toggle ${runtimeOn ? 'on' : ''}`}
              title={runtimeOn ? t('scripts.runtimeOnTitle') : t('scripts.runtimeOffTitle')}
              onClick={() =>
                useCardScriptsStore.getState().setEnabled(profileId, activeCardId, !runtimeOn)
              }
            >
              {runtimeOn ? t('scripts.runtimeOn') : t('scripts.runtimeOff')}
            </button>
          )}
          {activeCardId && (
            <button className="btn-ghost" onClick={() => setEditCard(true)}>
              {t('scripts.cardScripts')}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.8em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          {t('scripts.help')}
        </div>

        {SCOPES.map(({ key, titleKey, hintKey }) => {
          const inScope = scripts.filter((s) => s.scope === key)
          const cardOnesHere = key === 'world' ? cardScripts : []
          return (
            <ScopeSection
              key={key}
              title={t(titleKey)}
              hint={t(hintKey)}
              count={inScope.length + cardOnesHere.length}
              defaultOpen={key !== 'session'}
              action={(() => {
                const blocked =
                  (key === 'world' && !activeCardId) || (key === 'session' && !activeChatId)
                return (
                  <button
                    className="link-btn"
                    disabled={blocked}
                    title={
                      blocked
                        ? key === 'world'
                          ? t('scripts.selectWorldFirst')
                          : t('scripts.openSessionFirst')
                        : t('scripts.addScopedScript', { scope: t(titleKey) })
                    }
                    onClick={() => addScript(key)}
                  >
                    {t('scripts.addBtn')}
                  </button>
                )
              })()}
            >
              {inScope.length === 0 && cardOnesHere.length === 0 ? (
                <div style={{ opacity: 0.55, fontStyle: 'italic', padding: '4px 2px' }}>
                  {t('scripts.noneInScope')}
                </div>
              ) : (
                <>
                  {inScope.map(renderRow)}
                  {cardOnesHere.map((cs, i) => (
                    <div
                      key={`card-${i}`}
                      className={`prompt-row ${cs.enabled === false ? 'disabled' : ''}`}
                    >
                      <div className="prompt-row-head">
                        <span className="prompt-name" style={{ opacity: 0.85 }}>
                          {cs.name || t('common.untitled')}
                        </span>
                        <span className="entry-keys-preview" title={t('scripts.embedded')}>
                          {t('scripts.onCard')}
                        </span>
                        <div className="prompt-actions">
                          <button
                            className="btn-ghost"
                            title={t('scripts.editOnCard')}
                            onClick={() => setEditCard(true)}
                          >
                            ✎
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </ScopeSection>
          )
        })}
      </div>

      {editing && (
        <ScriptEditor
          script={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await update(profileId, editing.file, patch)
            setEditing(null)
          }}
        />
      )}

      {editCard && activeCardId && (
        <Modal
          title={t('scripts.cardScriptsTitle', { name: activeCardName || '' })}
          onClose={() => setEditCard(false)}
        >
          <ScriptManager
            profileId={profileId}
            characterId={activeCardId}
            characterName={activeCardName || ''}
            card={card}
          />
        </Modal>
      )}
    </div>
  )
}

const ScriptEditor: React.FC<{
  script: ScriptInfo
  onClose: () => void
  onSave: (patch: { name: string; code: string }) => void
}> = ({ script, onClose, onSave }) => {
  const [name, setName] = useState(script.name)
  const [code, setCode] = useState(script.code)
  const t = useT()
  return (
    <Modal
      title={t('scripts.editScriptTitle', { name: script.name })}
      onClose={onClose}
      headerActions={
        <button
          className="btn-accent"
          onClick={() => onSave({ name: name.trim() || 'script', code })}
        >
          {t('common.save')}
        </button>
      }
    >
      <label className="field-label">{t('common.name')}</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('scripts.namePh')}
      />

      <label className="field-label">{t('scripts.code')}</label>
      <textarea
        className="script-code"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t('scripts.codePh')}
      />
      <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 6 }}>
        {t('scripts.codeHelp')}
      </div>
    </Modal>
  )
}
