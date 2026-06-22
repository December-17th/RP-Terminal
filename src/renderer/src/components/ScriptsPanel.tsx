import React, { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { ScopeSection } from './ScopeSection'
import { ScriptManager } from './ScriptManager'
import { useScriptsStore, ScriptInfo, ArtifactScope } from '../stores/scriptsStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useToastStore } from '../stores/toastStore'

interface Props {
  profileId: string
  activeCardId: string | null
  activeCardName: string | null
  activeChatId: string | null
  /** The active card (source for read-only card-embedded scripts shown under World). */
  card: any
}

const SCOPES: { key: ArtifactScope; title: string; hint: string }[] = [
  { key: 'global', title: 'Global', hint: 'every session' },
  { key: 'world', title: 'World', hint: 'this card' },
  { key: 'session', title: 'Session', hint: 'this chat' }
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
    if (n) useToastStore.getState().push(`Imported ${n} script${n === 1 ? '' : 's'} (${scope})`)
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
            title={s.disabled ? 'Disabled' : 'Enabled'}
            onChange={() => setDisabled(profileId, s.file, !s.disabled)}
          />
          <span className="prompt-name" title="Edit script" onClick={() => setEditing(s)}>
            {s.name || 'Untitled script'}
          </span>
          {s.remoteHosts.length > 0 && (
            <span
              className="role-badge"
              title={`Loads remote code from ${s.remoteHosts.join(', ')}`}
            >
              ⬇ {s.remoteHosts.length}
            </span>
          )}
          {ownedElsewhere && (
            <span className="entry-keys-preview" title="Bound to a different world/session">
              other {s.scope}
            </span>
          )}
          <div className="prompt-actions">
            <select
              className="scope-select"
              value={s.scope}
              title="Scope"
              onChange={(e) => changeScope(s, e.target.value as ArtifactScope)}
            >
              <option value="global">Global</option>
              <option value="world" disabled={!activeCardId}>
                World
              </option>
              <option value="session" disabled={!activeChatId}>
                Session
              </option>
            </select>
            <button className="btn-ghost" title="Edit" onClick={() => setEditing(s)}>
              ✎
            </button>
            <button
              className="btn-ghost danger"
              title="Delete script"
              onClick={() => {
                if (confirm(`Delete script "${s.name}"?`)) remove(profileId, s.file)
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
        <h3>Scripts</h3>
        <div className="panel-header-actions">
          <button onClick={importScripts} title="Import script JSON files (Tavern Helper format)">
            Import
          </button>
          {activeCardId && (
            <button
              className={`rpt-script-toggle ${runtimeOn ? 'on' : ''}`}
              title={
                runtimeOn
                  ? 'Script runtime running for this world — click to disable'
                  : 'Script runtime disabled for this world — click to enable'
              }
              onClick={() =>
                useCardScriptsStore.getState().setEnabled(profileId, activeCardId, !runtimeOn)
              }
            >
              {runtimeOn ? 'Runtime On' : 'Runtime Off'}
            </button>
          )}
          {activeCardId && (
            <button className="btn-ghost" onClick={() => setEditCard(true)}>
              Card scripts
            </button>
          )}
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.8em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          Sandboxed JavaScript that runs in the right-panel <b>⚙ Card Scripts</b> while a session is
          open (vars/chat/generate/ui via the <code>rpt</code> API). Scope a script to <b>Global</b>
          , <b>World</b> (this card) or <b>Session</b> (this chat). Pull a remote library by adding{' '}
          <code>{'// @import https://…'}</code> at the top — fetched once with your permission.
        </div>

        {SCOPES.map(({ key, title, hint }) => {
          const inScope = scripts.filter((s) => s.scope === key)
          const cardOnesHere = key === 'world' ? cardScripts : []
          return (
            <ScopeSection
              key={key}
              title={title}
              hint={hint}
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
                          ? 'Select a world first'
                          : 'Open a session first'
                        : `Add a ${title.toLowerCase()} script`
                    }
                    onClick={() => addScript(key)}
                  >
                    + add
                  </button>
                )
              })()}
            >
              {inScope.length === 0 && cardOnesHere.length === 0 ? (
                <div style={{ opacity: 0.55, fontStyle: 'italic', padding: '4px 2px' }}>
                  No {title.toLowerCase()} scripts yet.
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
                          {cs.name || 'Untitled'}
                        </span>
                        <span
                          className="entry-keys-preview"
                          title="Embedded in the card; edit via “Card scripts”"
                        >
                          on card
                        </span>
                        <div className="prompt-actions">
                          <button
                            className="btn-ghost"
                            title="Edit on card"
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
        <Modal title={`Card Scripts — ${activeCardName || ''}`} onClose={() => setEditCard(false)}>
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
  return (
    <Modal
      title={`Edit Script — ${script.name}`}
      onClose={onClose}
      headerActions={
        <button
          className="btn-accent"
          onClick={() => onSave({ name: name.trim() || 'script', code })}
        >
          Save
        </button>
      }
    >
      <label className="field-label">Name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. stats-panel"
      />

      <label className="field-label">Code (JavaScript)</label>
      <textarea
        className="script-code"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={
          '// @import https://cdn.jsdelivr.net/…/bundle.js\nrpt.on("ready", () => { … })'
        }
      />
      <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 6 }}>
        Add <code>{'// @import https://…'}</code> (or <code>import &quot;https://…&quot;</code>) on
        its own line to load a remote JS library. Remote code is fetched in the main process
        (cached) only after you allow it for this world.
      </div>
    </Modal>
  )
}
