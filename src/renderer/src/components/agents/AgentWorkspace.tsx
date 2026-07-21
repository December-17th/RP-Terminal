// Full-window Agent Workspace popup (implementation plan Session 10) — the surface that replaces the
// workflow canvas. It is deliberately FLAT: library + form editor + plan editor + run detail. There
// is no canvas, node palette, port, edge, or arbitrary branching here, and there is no workflow
// compatibility view (design §4).
//
// Division of labour with Settings → Agents: that rail panel is the QUICK-adjustment surface (scan
// the folder, enable/disable, bind roles). This popup is the editor.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentCatalogSummary,
  AgentDefinition,
  AgentRole,
  AgentRunRecord,
  InvocationPlan,
  JsonObject
} from '../../../../shared/agentRuntime'
import { useAgentCatalogStore } from '../../stores/agentCatalogStore'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../i18n'
import { agentErrorMessage } from '../../i18n/errorMessages'
import { ConfirmDialog } from '../ConfirmDialog'
import { Modal } from '../Modal'
import { useWcvSuppression } from '../useWcvSuppression'
import { AgentEditor, validateDraft } from './AgentEditor'
import { AgentManualRunForm } from './AgentManualRunForm'
import { AgentPlanEditor } from './AgentPlanEditor'
import { AgentRunDetail } from './AgentRunDetail'

type Tab = 'definition' | 'plan' | 'runs'
type CreationIntent = 'narrative' | 'background' | 'custom'
type CreationStep = 'choose' | 'edit'
type PendingTransition =
  | { type: 'close' }
  | { type: 'select'; agentId: string }
  | { type: 'create' }
  | { type: 'open-preset' }
type PendingAgentAction = {
  type: 'delete' | 'restore' | 'upgrade-source'
  agent: AgentCatalogSummary
}

const ROLES: AgentRole[] = ['classic.narrator', 'yuzu.sceneDirector']
const EMPTY_PLAN: InvocationPlan = { steps: [] }
const planRecoveryKey = (profileId: string): string => `rpt.agentWorkspace.planDraft.${profileId}`

const cloneDefinition = (definition: AgentDefinition): AgentDefinition =>
  structuredClone(definition)

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const readPlanRecovery = (
  profileId: string
): { plan: InvocationPlan; importText: string } | null => {
  try {
    const raw = sessionStorage.getItem(planRecoveryKey(profileId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { plan?: InvocationPlan; importText?: string }
    if (!parsed.plan || !Array.isArray(parsed.plan.steps)) return null
    return { plan: parsed.plan, importText: parsed.importText ?? '' }
  } catch {
    return null
  }
}

function UnsavedChangesDialog({
  busy,
  onSave,
  onDiscard,
  onKeepEditing,
  t
}: {
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  onKeepEditing: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): React.ReactElement {
  return (
    <Modal title={t('agents.workspace.unsavedTitle')} onClose={onKeepEditing}>
      <p style={{ margin: '0 0 16px' }}>{t('agents.workspace.unsavedBody')}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onKeepEditing}>
          {t('agents.workspace.keepEditing')}
        </button>
        <button type="button" className="btn-danger" disabled={busy} onClick={onDiscard}>
          {t('agents.workspace.discardChanges')}
        </button>
        <button type="button" className="btn-accent" disabled={busy} onClick={onSave}>
          {busy ? t('agents.editor.saving') : t('agents.workspace.saveChanges')}
        </button>
      </div>
    </Modal>
  )
}

const blankDefinition = (name: string, intent: CreationIntent = 'custom'): AgentDefinition => ({
  format: 'rpt-agent',
  formatVersion: 1,
  name,
  prompt: [{ role: 'system', content: [{ type: 'text', text: '' }] }],
  inputSchema: { type: 'object' },
  result: intent === 'background' ? { mode: 'json', schema: { type: 'object' } } : { mode: 'text' },
  tools: [],
  ...(intent === 'background' ? { trigger: { onFloorCommitted: { everyNFloors: 3 } } } : {}),
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

/**
 * Per-Agent API-preset binding (`invocationConfig.apiPresetId`). Owner policy: an imported Agent starts
 * with NO preset selected — the user picks one here, or the Agent runs on the profile's active preset.
 * The imported model (if the card/file declared one) is shown read-only as a recommendation and is never
 * applied at runtime. User-authored Agents bind a preset the same way.
 */
function AgentPresetBinding({
  profileId,
  agent,
  onNotice,
  t
}: {
  profileId: string
  agent: AgentCatalogSummary
  onNotice: (message: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): React.ReactElement {
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([])
  const [presetId, setPresetId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [cfg, settings] = await Promise.all([
        window.api.getAgentInvocationConfig(profileId, agent.id),
        window.api.getSettings(profileId)
      ])
      if (cancelled) return
      setPresetId(typeof cfg?.apiPresetId === 'string' ? cfg.apiPresetId : '')
      setPresets(
        ((settings?.api_presets ?? []) as { id: string; name: string }[]).map((preset) => ({
          id: preset.id,
          name: preset.name
        }))
      )
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, agent.id])

  const commit = async (next: string): Promise<void> => {
    const previous = presetId
    setPresetId(next)
    setBusy(true)
    try {
      const result = await window.api.setAgentInvocationConfig(
        profileId,
        agent.id,
        next ? { apiPresetId: next } : {}
      )
      if (!result.ok) {
        setPresetId(previous)
        onNotice(agentErrorMessage(t, result.code))
      } else {
        onNotice(t('agents.workspace.immediateApplied'))
      }
    } catch {
      setPresetId(previous)
      onNotice(agentErrorMessage(t))
    } finally {
      setBusy(false)
    }
  }

  const imported = agent.sourceKind === 'card' || agent.sourceKind === 'user-imported'

  return (
    <div className="agent-workspace__preset">
      <label className="agent-field agent-field--inline">
        <span>{t('agents.apiPreset')}</span>
        <select
          value={presetId}
          disabled={busy}
          onChange={(event) => void commit(event.target.value)}
        >
          <option value="">{t('agents.apiPreset.default')}</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      {agent.recommendedModel ? (
        <p className="agents-panel__hint">
          {t('agents.apiPreset.recommendation', { model: agent.recommendedModel })}
        </p>
      ) : null}
      {imported && !presetId ? (
        <p className="agent-workspace__notice" role="status">
          {t('agents.apiPreset.notice')}
        </p>
      ) : null}
    </div>
  )
}

export function AgentWorkspace({ profileId }: { profileId: string }): React.ReactElement {
  return <ProfileAgentWorkspace key={profileId} profileId={profileId} />
}

function ProfileAgentWorkspace({ profileId }: { profileId: string }): React.ReactElement | null {
  const open = useUiStore((s) => s.agentWorkspaceOpen)
  const close = useUiStore((s) => s.closeAgentWorkspace)
  const deepLinkId = useUiStore((s) => s.agentWorkspaceAgentId)
  const deepLinkRunId = useUiStore((s) => s.agentWorkspaceRunId)
  const deepLinkAgentName = useUiStore((s) => s.agentWorkspaceAgentName)
  const initialTab = useUiStore((s) => s.agentWorkspaceInitialTab)
  const chatId = useChatStore((s) => s.activeChatId)
  const t = useT()

  const agents = useAgentCatalogStore((s) => s.agents)
  const bindings = useAgentCatalogStore((s) => s.bindings)
  const storeError = useAgentCatalogStore((s) => s.error)
  const load = useAgentCatalogStore((s) => s.load)
  const loadDefinition = useAgentCatalogStore((s) => s.loadDefinition)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(
    () => useUiStore.getState().agentWorkspaceInitialTab ?? 'definition'
  )
  const [creating, setCreating] = useState(false)
  const [creationStep, setCreationStep] = useState<CreationStep>('choose')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [runs, setRuns] = useState<AgentRunRecord[]>([])
  const [runDetail, setRunDetail] = useState<AgentRunRecord | null>(null)
  const [manualInput, setManualInput] = useState<JsonObject | undefined>(undefined)
  const [manualInputRevision, setManualInputRevision] = useState(0)
  const [definitionDrafts, setDefinitionDrafts] = useState<Record<string, AgentDefinition>>({})
  const [definitionBaselines, setDefinitionBaselines] = useState<Record<string, AgentDefinition>>(
    {}
  )
  const [creationBaseline, setCreationBaseline] = useState<AgentDefinition>(() =>
    blankDefinition(t('agents.workspace.newName'))
  )
  const [creationDraft, setCreationDraft] = useState<AgentDefinition>(() =>
    blankDefinition(t('agents.workspace.newName'))
  )
  const [editorRevision, setEditorRevision] = useState(0)
  const [plan, setPlan] = useState<InvocationPlan>(
    () => readPlanRecovery(profileId)?.plan ?? structuredClone(EMPTY_PLAN)
  )
  const [planImportText, setPlanImportText] = useState(
    () => readPlanRecovery(profileId)?.importText ?? ''
  )
  const [planBaseline, setPlanBaseline] = useState<InvocationPlan>(
    () => readPlanRecovery(profileId)?.plan ?? structuredClone(EMPTY_PLAN)
  )
  const [planImportBaseline, setPlanImportBaseline] = useState(
    () => readPlanRecovery(profileId)?.importText ?? ''
  )
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null)
  const [pendingAgentAction, setPendingAgentAction] = useState<PendingAgentAction | null>(null)
  const handledDeepLinkRef = React.useRef<string | null>(null)

  useWcvSuppression(open)

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId]
  )

  const activeDefinitionDraft = creating
    ? creationDraft
    : selectedId
      ? definitionDrafts[selectedId]
      : undefined
  const activeDefinitionBaseline = creating
    ? creationBaseline
    : selectedId
      ? definitionBaselines[selectedId]
      : undefined
  const definitionDirty = Boolean(
    activeDefinitionDraft &&
    activeDefinitionBaseline &&
    !sameJson(activeDefinitionDraft, activeDefinitionBaseline)
  )
  const planDirty =
    !sameJson(plan, planBaseline) || planImportText.trim() !== planImportBaseline.trim()

  const applyTransition = useCallback(
    (transition: PendingTransition): void => {
      setPendingTransition(null)
      if (transition.type === 'close') {
        close()
        return
      }
      if (transition.type === 'open-preset') {
        close()
        useUiStore.getState().openSettings('preset')
        return
      }
      if (transition.type === 'create') {
        const blank = blankDefinition(t('agents.workspace.newName'))
        setCreationBaseline(blank)
        setCreationDraft(cloneDefinition(blank))
        setCreating(true)
        setCreationStep('choose')
        setSelectedId(null)
        setTab('definition')
        setNotice(null)
        setEditorRevision((revision) => revision + 1)
        return
      }
      setCreating(false)
      setSelectedId(transition.agentId)
      setNotice(null)
    },
    [close, t]
  )

  const requestTransition = useCallback(
    (transition: PendingTransition): void => {
      const leavingWorkspace = transition.type === 'close' || transition.type === 'open-preset'
      const atRisk = definitionDirty || (leavingWorkspace && planDirty)
      if (atRisk) setPendingTransition(transition)
      else applyTransition(transition)
    },
    [applyTransition, definitionDirty, planDirty]
  )

  useEffect(() => {
    if (open) void load(profileId)
  }, [open, profileId, load])

  useEffect(() => {
    if (!open) {
      handledDeepLinkRef.current = null
      return
    }
    const targetAgent = deepLinkId
      ? agents.find((agent) => agent.id === deepLinkId)
      : deepLinkAgentName
        ? agents.find((agent) => agent.name === deepLinkAgentName)
        : initialTab === 'runs'
          ? agents[0]
          : undefined
    const deepLinkKey = `${deepLinkId ?? ''}:${deepLinkRunId ?? ''}:${deepLinkAgentName ?? ''}:${initialTab ?? ''}`
    if (handledDeepLinkRef.current === deepLinkKey) return
    if ((deepLinkId || deepLinkAgentName || initialTab === 'runs') && !targetAgent) return

    handledDeepLinkRef.current = deepLinkKey
    if (targetAgent) requestTransition({ type: 'select', agentId: targetAgent.id })
  }, [open, deepLinkId, deepLinkRunId, deepLinkAgentName, initialTab, agents, requestTransition])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestTransition({ type: 'close' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, requestTransition])

  useEffect(() => {
    if (!selected) return
    if (definitionBaselines[selected.id]) return
    let cancelled = false
    void loadDefinition(profileId, selected.id).then((loaded) => {
      if (cancelled || !loaded) return
      const baseline = cloneDefinition(loaded)
      setDefinitionBaselines((current) => ({ ...current, [selected.id]: baseline }))
      setDefinitionDrafts((current) => ({
        ...current,
        [selected.id]: current[selected.id] ?? cloneDefinition(loaded)
      }))
    })
    return () => {
      cancelled = true
    }
  }, [selected, profileId, loadDefinition, definitionBaselines])

  const refreshRuns = useCallback(async (): Promise<void> => {
    if (!chatId) return setRuns([])
    try {
      const nextRuns = await window.api.listAgentRuns(profileId, chatId)
      setRuns(nextRuns)
      const targetId = useUiStore.getState().agentWorkspaceRunId
      const target = targetId ? nextRuns.find((run) => run.invocationId === targetId) : undefined
      if (target) setRunDetail(target)
    } catch {
      setRuns([])
    }
  }, [profileId, chatId])

  useEffect(() => {
    if (open && tab === 'runs') void refreshRuns()
  }, [open, tab, refreshRuns])

  if (!open) return null

  const definition = selected ? definitionDrafts[selected.id] : undefined

  const act = async (action: () => Promise<string | null>, success: string): Promise<boolean> => {
    setSaving(true)
    setNotice(null)
    const error = await action()
    setSaving(false)
    setNotice(error ?? success)
    return !error
  }

  const refreshDefinition = async (agentId: string): Promise<void> => {
    const loaded = await useAgentCatalogStore.getState().loadDefinition(profileId, agentId)
    if (!loaded) return
    const baseline = cloneDefinition(loaded)
    setDefinitionBaselines((current) => ({ ...current, [agentId]: baseline }))
    setDefinitionDrafts((current) => ({ ...current, [agentId]: cloneDefinition(loaded) }))
    setEditorRevision((revision) => revision + 1)
  }

  const confirmAgentAction = async (): Promise<void> => {
    const pending = pendingAgentAction
    if (!pending) return
    setPendingAgentAction(null)

    if (pending.type === 'delete') {
      await act(async () => {
        const error = await useAgentCatalogStore.getState().remove(profileId, pending.agent.id)
        if (!error) setSelectedId(null)
        return error
      }, t('agents.workspace.deleted'))
      return
    }

    const succeeded = await act(
      () =>
        pending.type === 'restore'
          ? useAgentCatalogStore.getState().restore(profileId, pending.agent.id)
          : useAgentCatalogStore.getState().upgrade(profileId, pending.agent.id, 'use-source'),
      pending.type === 'restore' ? t('agents.workspace.restored') : t('agents.workspace.upgraded')
    )
    if (succeeded) await refreshDefinition(pending.agent.id)
  }

  const saveActiveDefinition = async (success: string): Promise<boolean> => {
    const draft = activeDefinitionDraft
    if (!draft) return true
    if (validateDraft(draft).length > 0) {
      setTab('definition')
      setNotice(t('agents.editor.fixErrors'))
      return false
    }

    setSaving(true)
    setNotice(null)
    const error = creating
      ? await useAgentCatalogStore.getState().createAgent(profileId, draft)
      : selectedId
        ? await useAgentCatalogStore.getState().save(profileId, selectedId, draft)
        : null
    setSaving(false)
    if (error) {
      setNotice(error)
      return false
    }

    if (creating) {
      const saved = cloneDefinition(draft)
      setCreationBaseline(saved)
      setCreationDraft(cloneDefinition(saved))
      setCreating(false)
    } else if (selectedId) {
      const saved = cloneDefinition(draft)
      setDefinitionBaselines((current) => ({ ...current, [selectedId]: saved }))
      setDefinitionDrafts((current) => ({
        ...current,
        [selectedId]: cloneDefinition(saved)
      }))
    }
    setNotice(success)
    return true
  }

  const saveAndContinue = async (): Promise<void> => {
    const transition = pendingTransition
    if (!transition) return
    if (definitionDirty && !(await saveActiveDefinition(t('agents.workspace.saved')))) {
      setPendingTransition(null)
      return
    }
    if ((transition.type === 'close' || transition.type === 'open-preset') && planDirty) {
      try {
        sessionStorage.setItem(
          planRecoveryKey(profileId),
          JSON.stringify({ plan, importText: planImportText })
        )
        setPlanBaseline(structuredClone(plan))
        setPlanImportBaseline(planImportText)
      } catch {
        setPendingTransition(null)
        setNotice(t('agents.workspace.planRecoveryFailed'))
        return
      }
    }
    applyTransition(transition)
  }

  const discardAndContinue = (): void => {
    const transition = pendingTransition
    if (!transition) return
    if (definitionDirty) {
      if (creating) setCreationDraft(cloneDefinition(creationBaseline))
      else if (selectedId && activeDefinitionBaseline) {
        setDefinitionDrafts((current) => ({
          ...current,
          [selectedId]: cloneDefinition(activeDefinitionBaseline)
        }))
      }
      setEditorRevision((revision) => revision + 1)
    }
    if ((transition.type === 'close' || transition.type === 'open-preset') && planDirty) {
      setPlan(structuredClone(planBaseline))
      setPlanImportText(planImportBaseline)
    }
    applyTransition(transition)
  }

  const cancelDefinition = (): void => {
    if (creating) {
      setCreationDraft(cloneDefinition(creationBaseline))
      setCreating(false)
    } else if (selectedId && activeDefinitionBaseline) {
      setDefinitionDrafts((current) => ({
        ...current,
        [selectedId]: cloneDefinition(activeDefinitionBaseline)
      }))
    }
    setEditorRevision((revision) => revision + 1)
  }

  const startCreation = (intent: CreationIntent): void => {
    const blank = blankDefinition(t(`agents.create.${intent}.name`), intent)
    setCreationBaseline(blank)
    setCreationDraft(cloneDefinition(blank))
    setCreationStep('edit')
    setEditorRevision((revision) => revision + 1)
  }

  const runNow = async (input: JsonObject): Promise<void> => {
    if (!selected || !chatId) return
    setSaving(true)
    setNotice(null)
    const result = await window.api.runAgentManually(profileId, chatId, selected.name, input)
    setSaving(false)
    setNotice(
      result.ok
        ? 'invocationId' in result
          ? t('agents.run.started', { status: result.status, id: result.invocationId })
          : t('agents.run.nothingDue')
        : agentErrorMessage(t, result.code)
    )
    await refreshRuns()
  }

  return (
    <div className="modal-overlay" onClick={() => requestTransition({ type: 'close' })}>
      <div
        className="rpt-popup-modal rpt-popup-modal-agents"
        role="dialog"
        aria-modal="true"
        aria-label={t('agents.workspace.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rpt-popup-modal-head">
          <strong>{t('agents.workspace.title')}</strong>
          <button
            className="btn-ghost"
            title={`${t('common.close')} (Esc)`}
            onClick={() => requestTransition({ type: 'close' })}
          >
            ✕
          </button>
        </div>

        <div className="rpt-popup-modal-body agent-workspace">
          <aside className="agent-workspace__library">
            <div className="agent-workspace__library-head">
              <span>{t('agents.installed', { count: agents.length })}</span>
              <button type="button" onClick={() => requestTransition({ type: 'create' })}>
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
                    onClick={() => requestTransition({ type: 'select', agentId: agent.id })}
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

            {creating && creationStep === 'choose' ? (
              <section className="agent-create" aria-labelledby="agent-create-title">
                <header>
                  <h3 id="agent-create-title">{t('agents.create.title')}</h3>
                  <p>{t('agents.create.hint')}</p>
                </header>
                <div className="agent-create__choices">
                  {(['narrative', 'background', 'custom'] as CreationIntent[]).map((intent) => (
                    <button type="button" key={intent} onClick={() => startCreation(intent)}>
                      <strong>{t(`agents.create.${intent}.title`)}</strong>
                      <span>{t(`agents.create.${intent}.description`)}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>
                  {t('common.cancel')}
                </button>
              </section>
            ) : creating ? (
              <>
                <div className="agent-workspace__save-boundary">
                  <div>
                    <strong>{t('agents.workspace.definitionDraft')}</strong>
                    <span>{t('agents.workspace.definitionSaveHint')}</span>
                  </div>
                  <span className={definitionDirty ? 'is-dirty' : ''}>
                    {t(
                      creating
                        ? 'agents.workspace.definitionNotSaved'
                        : definitionDirty
                          ? 'agents.workspace.definitionUnsaved'
                          : 'agents.workspace.definitionSaved'
                    )}
                  </span>
                </div>
                <AgentEditor
                  key={`new:${editorRevision}`}
                  definition={creationDraft}
                  readOnly={false}
                  saving={saving}
                  serverError={null}
                  onChange={setCreationDraft}
                  onCancel={cancelDefinition}
                  onSave={() => void saveActiveDefinition(t('agents.workspace.created'))}
                />
              </>
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
                        onClick={() => setPendingAgentAction({ type: 'restore', agent: selected })}
                      >
                        {t('agents.workspace.restore')}
                      </button>
                    ) : null}
                    {selected.upgradeAvailable ? (
                      <>
                        <button
                          type="button"
                          disabled={saving || definitionDirty}
                          title={
                            definitionDirty
                              ? t('agents.workspace.saveBeforeSourceAction')
                              : undefined
                          }
                          onClick={() => {
                            void (async () => {
                              const succeeded = await act(
                                () =>
                                  useAgentCatalogStore
                                    .getState()
                                    .upgrade(profileId, selected.id, 'keep-customization'),
                                t('agents.workspace.upgraded')
                              )
                              if (succeeded) await refreshDefinition(selected.id)
                            })()
                          }}
                        >
                          {t('agents.workspace.upgradeKeep')}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            setPendingAgentAction({ type: 'upgrade-source', agent: selected })
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

                <section
                  className="agent-workspace__immediate"
                  aria-labelledby="agent-workspace-immediate-title"
                >
                  <div className="agent-workspace__immediate-head">
                    <div>
                      <h4 id="agent-workspace-immediate-title">
                        {t('agents.workspace.immediateTitle')}
                      </h4>
                      <p>{t('agents.workspace.immediateHint')}</p>
                    </div>
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
                          t('agents.workspace.immediateApplied')
                        )
                      }
                    >
                      {selected.enabled ? t('agents.disable') : t('agents.enable')}
                    </button>
                  </div>
                  <div className="agent-workspace__immediate-fields">
                    <AgentPresetBinding
                      profileId={profileId}
                      agent={selected}
                      onNotice={setNotice}
                      t={t}
                    />
                    <label className="agent-field agent-field--inline">
                      <span>{t('agents.roles')}</span>
                      <select
                        value={
                          ROLES.find(
                            (role) =>
                              bindings[role] === selected.id || bindings[role] === selected.name
                          ) ?? ''
                        }
                        disabled={saving}
                        onChange={(event) => {
                          const role = event.target.value as AgentRole
                          if (role) {
                            void act(
                              () =>
                                useAgentCatalogStore
                                  .getState()
                                  .bindRole(profileId, role, selected.id),
                              t('agents.workspace.immediateApplied')
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
                  </div>
                </section>

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
                    <>
                      <div className="agent-workspace__save-boundary">
                        <div>
                          <strong>{t('agents.workspace.definitionDraft')}</strong>
                          <span>{t('agents.workspace.definitionSaveHint')}</span>
                        </div>
                        <span className={definitionDirty ? 'is-dirty' : ''}>
                          {t(
                            definitionDirty
                              ? 'agents.workspace.definitionUnsaved'
                              : 'agents.workspace.definitionSaved'
                          )}
                        </span>
                      </div>
                      <AgentEditor
                        key={`${selected.id}:${editorRevision}`}
                        definition={definition}
                        readOnly={false}
                        saving={saving}
                        serverError={null}
                        onChange={(next) =>
                          setDefinitionDrafts((current) => ({ ...current, [selected.id]: next }))
                        }
                        onCancel={cancelDefinition}
                        onSave={() => void saveActiveDefinition(t('agents.workspace.saved'))}
                      />
                    </>
                  ) : (
                    <p className="agents-panel__empty">{t('agents.workspace.loadingDefinition')}</p>
                  )
                ) : null}

                {tab === 'plan' ? (
                  <AgentPlanEditor
                    agents={agents}
                    plan={plan}
                    onPlanChange={setPlan}
                    importText={planImportText}
                    onImportTextChange={setPlanImportText}
                  />
                ) : null}

                {tab === 'runs' ? (
                  <div className="agent-runs">
                    {definition ? (
                      <AgentManualRunForm
                        key={`${selected.id}:${manualInputRevision}`}
                        inputSchema={definition.inputSchema}
                        initialInput={manualInput}
                        disabled={saving}
                        hasChat={Boolean(chatId)}
                        onRun={(input) => void runNow(input)}
                      />
                    ) : null}

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
                      <AgentRunDetail
                        record={runDetail}
                        onClose={() => setRunDetail(null)}
                        onCopied={() => setNotice(t('agents.run.copied'))}
                        onEditInput={(input) => {
                          setManualInput(input)
                          setManualInputRevision((revision) => revision + 1)
                          setRunDetail(null)
                        }}
                        onOpenPreset={() => requestTransition({ type: 'open-preset' })}
                      />
                    ) : null}
                  </div>
                ) : null}

                <footer className="agent-workspace__footer">
                  <button
                    type="button"
                    className="agents-row__delete"
                    disabled={saving || selected.roles.length > 0}
                    title={selected.roles.length > 0 ? t('agents.roleBoundLocked') : undefined}
                    onClick={() => setPendingAgentAction({ type: 'delete', agent: selected })}
                  >
                    {t('agents.delete')}
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      </div>
      {pendingTransition ? (
        <div onClick={(event) => event.stopPropagation()}>
          <UnsavedChangesDialog
            busy={saving}
            onSave={() => void saveAndContinue()}
            onDiscard={discardAndContinue}
            onKeepEditing={() => setPendingTransition(null)}
            t={t}
          />
        </div>
      ) : null}
      {pendingAgentAction ? (
        <div onClick={(event) => event.stopPropagation()}>
          <ConfirmDialog
            title={t(`agents.workspace.confirm.${pendingAgentAction.type}.title`, {
              name: pendingAgentAction.agent.name
            })}
            body={t(`agents.workspace.confirm.${pendingAgentAction.type}.body`, {
              name: pendingAgentAction.agent.name
            })}
            confirmLabel={t(
              pendingAgentAction.type === 'delete'
                ? 'agents.delete'
                : pendingAgentAction.type === 'restore'
                  ? 'agents.workspace.restore'
                  : 'agents.workspace.upgradeSource'
            )}
            danger
            onConfirm={() => void confirmAgentAction()}
            onCancel={() => setPendingAgentAction(null)}
          />
        </div>
      ) : null}
    </div>
  )
}
