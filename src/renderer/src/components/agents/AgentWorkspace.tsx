// Full-window Agent Workspace popup (implementation plan Session 10) — the surface that replaces the
// workflow canvas. It is deliberately FLAT: library + form editor + plan editor + run detail. There
// is no canvas, node palette, port, edge, or arbitrary branching here, and there is no workflow
// compatibility view (design §4).
//
// Division of labour with Settings → Agents: that rail panel is the QUICK-adjustment surface (scan
// the folder, enable/disable, bind roles). This popup is the editor.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentDefinition,
  AgentRole,
  AgentRunRecord
} from '../../../../shared/agentRuntime'
import { useAgentCatalogStore } from '../../stores/agentCatalogStore'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import { AgentEditor } from './AgentEditor'
import { AgentPlanEditor } from './AgentPlanEditor'

type Tab = 'definition' | 'plan' | 'runs'

const ROLES: AgentRole[] = ['classic.narrator', 'yuzu.sceneDirector']

const blankDefinition = (name: string): AgentDefinition => ({
  format: 'rpt-agent',
  formatVersion: 1,
  name,
  prompt: [{ role: 'system', content: [{ type: 'text', text: '' }] }],
  inputSchema: { type: 'object' },
  result: { mode: 'text' },
  tools: [],
  defaults: {
    required: false,
    maxSteps: 1,
    maxRetryAttempts: 3,
    retryDelayMs: 3000,
    blocksNextTurn: false,
    toolResultMaxTokens: 10000,
    notification: 'failure'
  }
})

export function AgentWorkspace({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.agentWorkspaceOpen)
  const close = useUiStore((s) => s.closeAgentWorkspace)
  const deepLinkId = useUiStore((s) => s.agentWorkspaceAgentId)
  const chatId = useChatStore((s) => s.activeChatId)
  const t = useT()

  const agents = useAgentCatalogStore((s) => s.agents)
  const bindings = useAgentCatalogStore((s) => s.bindings)
  const definitions = useAgentCatalogStore((s) => s.definitions)
  const storeError = useAgentCatalogStore((s) => s.error)
  const load = useAgentCatalogStore((s) => s.load)
  const loadDefinition = useAgentCatalogStore((s) => s.loadDefinition)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('definition')
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [runInput, setRunInput] = useState('{}')
  const [runs, setRuns] = useState<AgentRunRecord[]>([])
  const [runDetail, setRunDetail] = useState<AgentRunRecord | null>(null)

  useWcvSuppression(open)

  useEffect(() => {
    if (open) void load(profileId)
  }, [open, profileId, load])

  useEffect(() => {
    if (open && deepLinkId) setSelectedId(deepLinkId)
  }, [open, deepLinkId])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId]
  )

  useEffect(() => {
    if (selected) void loadDefinition(profileId, selected.id)
  }, [selected, profileId, loadDefinition])

  const refreshRuns = useCallback(async (): Promise<void> => {
    if (!chatId) return setRuns([])
    try {
      setRuns(await window.api.listAgentRuns(profileId, chatId))
    } catch {
      setRuns([])
    }
  }, [profileId, chatId])

  useEffect(() => {
    if (open && tab === 'runs') void refreshRuns()
  }, [open, tab, refreshRuns])

  if (!open) return null

  const definition = selected ? definitions[selected.id] : undefined

  const act = async (action: () => Promise<string | null>, success: string): Promise<void> => {
    setSaving(true)
    setNotice(null)
    const error = await action()
    setSaving(false)
    setNotice(error ?? success)
  }

  const runNow = async (): Promise<void> => {
    if (!selected || !chatId) return
    let input: unknown = {}
    try {
      input = JSON.parse(runInput || '{}')
    } catch {
      setNotice(t('agents.editor.invalidJson'))
      return
    }
    setSaving(true)
    setNotice(null)
    const result = await window.api.runAgentManually(profileId, chatId, selected.name, input)
    setSaving(false)
    setNotice(
      result.ok
        ? t('agents.run.started', { status: result.status, id: result.invocationId })
        : result.error
    )
    await refreshRuns()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="rpt-popup-modal rpt-popup-modal-agents"
        role="dialog"
        aria-modal="true"
        aria-label={t('agents.workspace.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rpt-popup-modal-head">
          <strong>{t('agents.workspace.title')}</strong>
          <button className="btn-ghost" title={`${t('common.close')} (Esc)`} onClick={close}>
            ✕
          </button>
        </div>

        <div className="rpt-popup-modal-body agent-workspace">
          <aside className="agent-workspace__library">
            <div className="agent-workspace__library-head">
              <span>{t('agents.installed', { count: agents.length })}</span>
              <button
                type="button"
                onClick={() => {
                  setCreating(true)
                  setSelectedId(null)
                  setTab('definition')
                }}
              >
                {t('agents.workspace.new')}
              </button>
            </div>
            <ul>
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={`agent-workspace__item ${
                      agent.id === selectedId ? 'agent-workspace__item--active' : ''
                    }`}
                    onClick={() => {
                      setCreating(false)
                      setSelectedId(agent.id)
                      setNotice(null)
                    }}
                  >
                    <span className="agent-workspace__item-name">{agent.name}</span>
                    <span className="agent-workspace__item-meta">
                      {t(`agents.source.${agent.sourceKind}`)}
                      {agent.customized ? ` · ${t('agents.customized')}` : ''}
                      {agent.upgradeAvailable ? ` · ${t('agents.upgradeAvailable')}` : ''}
                      {agent.enabled ? '' : ` · ${t('agents.workspace.disabled')}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="agent-workspace__detail">
            {notice ? (
              <p className="agent-workspace__notice" role="status">
                {notice}
              </p>
            ) : null}
            {storeError && !notice ? (
              <p className="agents-panel__error" role="alert">
                {storeError}
              </p>
            ) : null}

            {creating ? (
              <AgentEditor
                definition={blankDefinition(t('agents.workspace.newName'))}
                readOnly={false}
                saving={saving}
                serverError={null}
                onCancel={() => setCreating(false)}
                onSave={(next) =>
                  void act(async () => {
                    const error = await useAgentCatalogStore
                      .getState()
                      .createAgent(profileId, next)
                    if (!error) setCreating(false)
                    return error
                  }, t('agents.workspace.created'))
                }
              />
            ) : !selected ? (
              <p className="agents-panel__empty">{t('agents.workspace.selectPrompt')}</p>
            ) : (
              <>
                <header className="agent-workspace__header">
                  <div>
                    <h3>{selected.name}</h3>
                    <p className="agent-workspace__source">
                      {t('agents.sourceKey', { key: selected.sourceKey })} · v
                      {selected.sourceVersion}
                    </p>
                  </div>
                  <div className="agent-workspace__header-actions">
                    {selected.customized ? (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() =>
                          void act(
                            () => useAgentCatalogStore.getState().restore(profileId, selected.id),
                            t('agents.workspace.restored')
                          )
                        }
                      >
                        {t('agents.workspace.restore')}
                      </button>
                    ) : null}
                    {selected.upgradeAvailable ? (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            void act(
                              () =>
                                useAgentCatalogStore
                                  .getState()
                                  .upgrade(profileId, selected.id, 'keep-customization'),
                              t('agents.workspace.upgraded')
                            )
                          }
                        >
                          {t('agents.workspace.upgradeKeep')}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            void act(
                              () =>
                                useAgentCatalogStore
                                  .getState()
                                  .upgrade(profileId, selected.id, 'use-source'),
                              t('agents.workspace.upgraded')
                            )
                          }
                        >
                          {t('agents.workspace.upgradeSource')}
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        void (async () => {
                          const text = await window.api.exportAgent(profileId, selected.id)
                          if (text) {
                            await navigator.clipboard.writeText(text)
                            setNotice(t('agents.workspace.exported'))
                          }
                        })()
                      }}
                    >
                      {t('agents.workspace.export')}
                    </button>
                  </div>
                </header>

                <nav className="agent-workspace__tabs">
                  {(['definition', 'plan', 'runs'] as Tab[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={tab === key ? 'active' : ''}
                      onClick={() => setTab(key)}
                    >
                      {t(`agents.workspace.tab.${key}`)}
                    </button>
                  ))}
                </nav>

                {tab === 'definition' ? (
                  definition ? (
                    <AgentEditor
                      definition={definition}
                      readOnly={false}
                      saving={saving}
                      serverError={null}
                      onCancel={() => setSelectedId(selectedId)}
                      onSave={(next) =>
                        void act(
                          () => useAgentCatalogStore.getState().save(profileId, selected.id, next),
                          t('agents.workspace.saved')
                        )
                      }
                    />
                  ) : (
                    <p className="agents-panel__empty">{t('agents.workspace.loadingDefinition')}</p>
                  )
                ) : null}

                {tab === 'plan' ? <AgentPlanEditor agents={agents} /> : null}

                {tab === 'runs' ? (
                  <div className="agent-runs">
                    <div className="agent-runs__manual">
                      <h4>{t('agents.run.manual')}</h4>
                      <p className="agents-panel__hint">{t('agents.run.manualHint')}</p>
                      <label className="agent-field">
                        <span>{t('agents.run.input')}</span>
                        <textarea
                          rows={4}
                          spellCheck={false}
                          value={runInput}
                          onChange={(event) => setRunInput(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={saving || !chatId}
                        title={chatId ? undefined : t('agents.run.needsChat')}
                        onClick={() => void runNow()}
                      >
                        {saving ? t('agents.run.running') : t('agents.run.runNow')}
                      </button>
                      {chatId ? null : (
                        <p className="agents-panel__hint">{t('agents.run.needsChat')}</p>
                      )}
                    </div>

                    <h4>{t('agents.run.history', { count: runs.length })}</h4>
                    {runs.length === 0 ? (
                      <p className="agents-panel__empty">{t('agents.run.noRuns')}</p>
                    ) : (
                      <ul className="agent-runs__list">
                        {runs.map((record) => (
                          <li key={record.invocationId}>
                            <button type="button" onClick={() => setRunDetail(record)}>
                              <strong>{record.agentName}</strong>
                              <span>{t(`agentRuns.status.${record.status}`)}</span>
                              {/* A run can succeed on a prompt that silently lost its card / persona /
                                  world info (ADR 0021 fail-open). The status alone cannot show that. */}
                              {record.warnings?.length ? (
                                <span
                                  className="agent-runs__degraded"
                                  title={t('agents.run.degradedLabel')}
                                >
                                  {t('agents.run.degraded')}
                                </span>
                              ) : null}
                              <span>{t('agents.run.floor', { floor: record.floor })}</span>
                              <span>{record.startedAt}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {runDetail ? (
                      <div className="agent-runs__detail">
                        <div className="agent-runs__detail-head">
                          <strong>{t('agents.run.detail')}</strong>
                          <button type="button" onClick={() => setRunDetail(null)}>
                            {t('common.close')}
                          </button>
                        </div>
                        {runDetail.warnings?.length ? (
                          <p className="agent-runs__degraded-detail" role="alert">
                            <strong>{t('agents.run.degradedTitle')}</strong>
                            {runDetail.warnings.join(' · ')}
                          </p>
                        ) : null}
                        {/* Full Run Record evidence, minus raw reasoning (Session 10). */}
                        <pre>
                          {JSON.stringify(
                            { ...runDetail, attempts: runDetail.attempts?.length ?? 0 },
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <footer className="agent-workspace__footer">
                  <label className="agent-field agent-field--inline">
                    <span>{t('agents.roles')}</span>
                    <select
                      value={
                        ROLES.find(
                          (role) =>
                            bindings[role] === selected.id || bindings[role] === selected.name
                        ) ?? ''
                      }
                      onChange={(event) => {
                        const role = event.target.value as AgentRole
                        if (role) {
                          void act(
                            () =>
                              useAgentCatalogStore.getState().bindRole(profileId, role, selected.id),
                            t('agents.workspace.bound')
                          )
                        }
                      }}
                    >
                      <option value="">{t('agents.workspace.noRole')}</option>
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(`agents.role.${role}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={saving || selected.roles.length > 0}
                    title={selected.roles.length > 0 ? t('agents.roleBoundLocked') : undefined}
                    onClick={() =>
                      void act(
                        () =>
                          useAgentCatalogStore
                            .getState()
                            .setEnabled(profileId, selected.id, !selected.enabled),
                        t('agents.workspace.saved')
                      )
                    }
                  >
                    {selected.enabled ? t('agents.disable') : t('agents.enable')}
                  </button>
                  <button
                    type="button"
                    className="agents-row__delete"
                    disabled={saving || selected.roles.length > 0}
                    title={selected.roles.length > 0 ? t('agents.roleBoundLocked') : undefined}
                    onClick={() =>
                      void act(async () => {
                        const error = await useAgentCatalogStore
                          .getState()
                          .remove(profileId, selected.id)
                        if (!error) setSelectedId(null)
                        return error
                      }, t('agents.workspace.deleted'))
                    }
                  >
                    {t('agents.delete')}
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
