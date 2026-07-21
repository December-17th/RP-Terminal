import { useCallback, useEffect, useState } from 'react'
import type {
  AgentCatalogSummary,
  AgentFolderSync,
  AgentRole,
  AgentUpgradeResolution
} from '../../../shared/agentRuntime'
import { useT } from '../i18n'
import { agentErrorMessage, agentImportErrorMessage } from '../i18n/errorMessages'

const ROLES: AgentRole[] = ['classic.narrator', 'yuzu.sceneDirector']

const number = (value: number): string => new Intl.NumberFormat().format(value)

/** Card- and file-sourced Agents are "imported": owner policy gives them no API preset on install. */
const isImported = (agent: AgentCatalogSummary): boolean =>
  agent.sourceKind === 'card' || agent.sourceKind === 'user-imported'

/**
 * The Agent Workspace (design §4): a FLAT library view — no canvas, node palette, ports, or edges.
 * It lists what the profile has installed, where each Agent came from, and the two role bindings.
 *
 * Editing an Agent's definition is deliberately not offered here: definitions are authored as
 * `.rptagent` files and imported, so the file stays the source of truth and re-importing shows an
 * upgrade rather than a silent overwrite.
 */
export function AgentsPanel({ profileId }: { profileId: string }): React.ReactElement {
  const t = useT()
  const [agents, setAgents] = useState<AgentCatalogSummary[]>([])
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [sync, setSync] = useState<AgentFolderSync | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [list, roles] = await Promise.all([
      window.api.listAgentCatalog(profileId),
      window.api.getAgentRoleBindings(profileId)
    ])
    setAgents(list)
    setBindings(roles ?? {})
  }, [profileId])

  useEffect(() => {
    void refresh().catch(() => setError(t('agents.loadFailed')))
  }, [refresh, t])

  const run = async (
    action: () => Promise<{ ok: boolean; error?: string; code?: string }>
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) setError(agentErrorMessage(t, result.code))
      await refresh()
    } catch {
      setError(agentErrorMessage(t))
    } finally {
      setBusy(false)
    }
  }

  const doSync = async (conflicts?: AgentUpgradeResolution): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSync(await window.api.syncAgentFolder(profileId, conflicts))
      await refresh()
    } catch {
      setError(agentErrorMessage(t))
    } finally {
      setBusy(false)
    }
  }

  const hasConflicts = sync?.items.some((item) => item.status === 'conflict') ?? false

  return (
    <div className="agents-panel">
      <div className="agents-panel__header">
        <div>
          <h3>{t('agents.title')}</h3>
          <p className="agents-panel__hint">{t('agents.folderHint')}</p>
        </div>
        <button type="button" onClick={() => void doSync()} disabled={busy}>
          {busy ? t('agents.scanning') : t('agents.scanFolder')}
        </button>
      </div>

      {error ? (
        <p className="agents-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      {sync ? (
        <div className="agents-sync">
          <div className="agents-sync__dir" title={sync.dir}>
            {sync.dir}
          </div>
          {sync.items.length === 0 ? (
            <p className="agents-sync__empty">{t('agents.noFiles')}</p>
          ) : (
            <ul>
              {sync.items.map((item) => (
                <li key={item.file} className={`agents-sync__item agents-sync__item--${item.status}`}>
                  <code>{item.file}</code>
                  <span>{t(`agents.status.${item.status}`)}</span>
                  {item.conflicts?.length ? (
                    <span className="agents-sync__detail">
                      {t('agents.conflictPaths', { paths: item.conflicts.join(', ') })}
                    </span>
                  ) : null}
                  {item.errorCode ? (
                    <span className="agents-sync__detail">
                      {agentImportErrorMessage(t, item.errorCode)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {sync.items.some((item) => item.status === 'installed' || item.status === 'upgraded') ? (
            <p className="agents-panel__hint">{t('agents.importedNeedPreset')}</p>
          ) : null}
          {hasConflicts ? (
            <div className="agents-sync__resolve">
              <span>{t('agents.conflictPrompt')}</span>
              <button type="button" onClick={() => void doSync('keep-customization')} disabled={busy}>
                {t('agents.keepCustomization')}
              </button>
              <button type="button" onClick={() => void doSync('use-source')} disabled={busy}>
                {t('agents.useSource')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="agents-roles">
        <h4>{t('agents.roles')}</h4>
        {ROLES.map((role) => (
          <label key={role} className="agents-roles__row">
            <span>{t(`agents.role.${role}`)}</span>
            <select
              value={
                agents.find((agent) => agent.id === bindings[role] || agent.name === bindings[role])
                  ?.id ?? ''
              }
              disabled={busy}
              onChange={(event) =>
                void run(() => window.api.bindAgentRole(profileId, role, event.target.value))
              }
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <h4>{t('agents.installed', { count: agents.length })}</h4>
      {agents.length === 0 ? (
        <p className="agents-panel__empty">{t('agents.empty')}</p>
      ) : (
        <ul className="agents-list">
          {agents.map((agent) => (
            <li key={agent.id} className={`agents-row ${agent.enabled ? '' : 'agents-row--off'}`}>
              <div className="agents-row__identity">
                <strong>{agent.name}</strong>
                <span className={`agents-badge agents-badge--${agent.sourceKind}`}>
                  {t(`agents.source.${agent.sourceKind}`)}
                </span>
                {agent.roles.map((role) => (
                  <span key={role} className="agents-badge agents-badge--role">
                    {t(`agents.role.${role}`)}
                  </span>
                ))}
                {agent.customized ? (
                  <span className="agents-badge">{t('agents.customized')}</span>
                ) : null}
                {agent.upgradeAvailable ? (
                  <span className="agents-badge agents-badge--upgrade">
                    {t('agents.upgradeAvailable')}
                  </span>
                ) : null}
                {agent.sourcePresent ? null : (
                  <span className="agents-badge agents-badge--missing">
                    {t('agents.sourceMissing')}
                  </span>
                )}
                {agent.recommendedModel ? (
                  <span className="agents-badge">
                    {t('agents.recommendedModel', { model: agent.recommendedModel })}
                  </span>
                ) : null}
                {isImported(agent) && !agent.hasApiPreset ? (
                  <span className="agents-badge agents-badge--missing">
                    {t('agents.needsApiPreset')}
                  </span>
                ) : null}
              </div>

              {agent.description ? <p className="agents-row__desc">{agent.description}</p> : null}

              <div className="agents-row__meta">
                <span>{t('agents.sourceKey', { key: agent.sourceKey })}</span>
                <span>
                  {t('agents.promptSize', {
                    messages: agent.promptMessages,
                    chars: number(agent.promptChars)
                  })}
                </span>
                <span>{t('agents.resultMode', { mode: agent.resultMode })}</span>
                {agent.saveAs ? <span>{t('agents.saveAs', { path: agent.saveAs })}</span> : null}
                {agent.blocksNextTurn ? (
                  <span className="agents-row__gate">{t('agents.blocksNextTurn')}</span>
                ) : null}
              </div>

              <div className="agents-row__actions">
                <button
                  type="button"
                  disabled={busy || agent.roles.length > 0}
                  title={agent.roles.length > 0 ? t('agents.roleBoundLocked') : undefined}
                  onClick={() =>
                    void run(() =>
                      window.api.setAgentEnabled(profileId, agent.id, !agent.enabled)
                    )
                  }
                >
                  {agent.enabled ? t('agents.disable') : t('agents.enable')}
                </button>
                <button
                  type="button"
                  className="agents-row__delete"
                  disabled={busy || agent.roles.length > 0}
                  title={agent.roles.length > 0 ? t('agents.roleBoundLocked') : undefined}
                  onClick={() => void run(() => window.api.deleteAgent(profileId, agent.id))}
                >
                  {t('agents.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
