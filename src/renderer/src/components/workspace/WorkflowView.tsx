import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useWorkflowTraceStore } from '../../stores/workflowTraceStore'
import { useOptionalT, useT } from '../../i18n'
import {
  formatTraceSeconds,
  type TraceNode,
  type WorkflowRunTrace
} from '../../../../shared/workflow/trace'

/**
 * Minimal workflow manager: list/import/export/clone/delete built-in + custom node-workflow
 * graphs, plus the three-tier selection (global default / world default / session override)
 * with a live resolved-id line. Node-workflow Phase 3 persistence surface — see
 * docs/superpowers/plans (node-workflow-phase3-persistence).
 */
const api = (): any => (window as unknown as { api: any }).api

interface WorkflowSummary {
  id: string
  name: string
  description?: string
  builtin?: boolean
}

const STATUS_COLOR: Record<TraceNode['status'], string> = {
  ran: 'var(--rpt-success)',
  skipped: 'var(--rpt-text-tertiary)',
  failed: 'var(--rpt-danger)'
}

/** Last run's per-node trace for the active chat (spec §13 run/trace panel): status dot,
 *  localized node title (reuses the editor's nodeTitle keys), phase chip, timing, error. */
const TracePanel: React.FC<{ trace: WorkflowRunTrace | undefined }> = ({ trace }) => {
  const t = useT()
  const tOpt = useOptionalT()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 6
        }}
      >
        <strong>{t('workflow.trace.heading')}</strong>
        {trace && (
          <span style={{ fontSize: 11, color: 'var(--rpt-text-tertiary)' }}>
            {t('workflow.trace.total', { s: formatTraceSeconds(trace.durationMs) })}
          </span>
        )}
      </div>

      {!trace && <div style={{ opacity: 0.6 }}>{t('workflow.trace.empty')}</div>}

      {trace?.aborted && (
        <div style={{ color: 'var(--rpt-warning)' }}>{t('workflow.trace.aborted')}</div>
      )}
      {trace?.error && (
        <div style={{ color: 'var(--rpt-danger)' }}>
          {t('workflow.trace.error')} {trace.error.message}
        </div>
      )}

      {trace?.nodes.map((n) => {
        const title = tOpt(`workflowEditor.nodeTitle.${n.nodeType}`) || n.nodeType
        const tooltip = n.outputs
          ? Object.entries(n.outputs)
              .map(([port, v]) => `${port}: ${v}`)
              .join('\n')
          : undefined
        return (
          <div key={`${n.nodeId}-${n.phase}`} title={tooltip} style={{ padding: '2px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                aria-label={t(`workflow.trace.status.${n.status}`)}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flex: '0 0 auto',
                  background: STATUS_COLOR[n.status]
                }}
              />
              <span style={{ flex: 1, opacity: n.status === 'skipped' ? 0.55 : 1 }}>
                {title}
                <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
                  {n.nodeType}
                </span>
              </span>
              {n.phase === 'post' && (
                <span
                  style={{
                    fontSize: 10,
                    padding: '0 5px',
                    borderRadius: 8,
                    border: '1px solid var(--rpt-border)',
                    color: 'var(--rpt-text-tertiary)'
                  }}
                >
                  {t('workflow.trace.postPhase')}
                </span>
              )}
              {n.ms !== undefined && (
                <span style={{ fontSize: 11, color: 'var(--rpt-text-tertiary)' }}>
                  {formatTraceSeconds(n.ms)}
                </span>
              )}
            </div>
            {n.error && (
              <div style={{ marginLeft: 15, fontSize: 11.5, color: 'var(--rpt-danger)' }}>
                {n.error.message}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const WorkflowView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const chats = useChatStore((s) => s.chats)
  const characterId = chats.find((c) => c.id === activeChatId)?.character_id ?? null
  const editorOpen = useUiStore((s) => s.workflowEditorOpen)

  const lastTrace = useWorkflowTraceStore((s) =>
    activeChatId ? s.traces[activeChatId] : undefined
  )
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[]>([])
  const [globalId, setGlobalIdState] = React.useState<string | null>(null)
  const [worldId, setWorldIdState] = React.useState<string | null>(null)
  const [chatId, setChatIdState] = React.useState<string | null>(null)
  const [resolved, setResolved] = React.useState<string | null>(null)

  const loadList = React.useCallback(async () => {
    setWorkflows(await api().listWorkflows(profileId))
  }, [profileId])

  const loadSelection = React.useCallback(async () => {
    const sel = await api().getWorkflowSelection(profileId)
    setGlobalIdState(sel.global ?? null)
    setWorldIdState(characterId ? (sel.worlds?.[characterId] ?? null) : null)
  }, [profileId, characterId])

  const loadChatWorkflow = React.useCallback(async () => {
    if (!activeChatId) {
      setChatIdState(null)
      return
    }
    setChatIdState(await api().getChatWorkflow(profileId, activeChatId))
  }, [profileId, activeChatId])

  const loadResolved = React.useCallback(async () => {
    if (!activeChatId) {
      setResolved(null)
      return
    }
    setResolved(await api().resolveWorkflowId(profileId, activeChatId))
  }, [profileId, activeChatId])

  const reloadAll = React.useCallback(async () => {
    await Promise.all([loadList(), loadSelection(), loadChatWorkflow()])
    await loadResolved()
  }, [loadList, loadSelection, loadChatWorkflow, loadResolved])

  React.useEffect(() => {
    void reloadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadAll already depends on profileId/activeChatId/characterId
  }, [profileId, activeChatId, characterId])

  // The full-screen editor clones/renames/imports workflows while this view stays mounted —
  // refresh the list + selectors when it closes, so a fresh clone is immediately selectable.
  React.useEffect(() => {
    if (!editorOpen) void reloadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on the editor closing only
  }, [editorOpen])

  const onExport = (id: string, name: string): void => {
    void api().exportWorkflowDialog(profileId, id, name)
  }

  const onEdit = async (id: string): Promise<void> => {
    // Open the workflow in the editor store first, then raise the full-screen overlay (the
    // editor is not a panel view — the canvas needs the whole window).
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, id)
    useUiStore.getState().openWorkflowEditor()
  }

  const onClone = async (id: string): Promise<void> => {
    await api().cloneWorkflow(profileId, id)
    await loadList()
  }

  const onDelete = async (id: string): Promise<void> => {
    if (!confirm(t('workflow.confirmDelete'))) return
    await api().deleteWorkflow(profileId, id)
    await reloadAll()
  }

  const onImport = async (): Promise<void> => {
    const result = await api().importWorkflowDialog(profileId)
    if (result === null) return
    if (!result.ok) {
      useToastStore.getState().push(`${t('workflow.importFailed')}: ${result.error}`)
      return
    }
    await loadList()
  }

  const onGlobalChange = async (value: string): Promise<void> => {
    const id = value === '' ? null : value
    await api().setGlobalWorkflow(profileId, id)
    setGlobalIdState(id)
    await loadResolved()
  }

  const onWorldChange = async (value: string): Promise<void> => {
    if (!characterId) return
    const id = value === '' ? null : value
    await api().setWorldWorkflow(profileId, characterId, id)
    setWorldIdState(id)
    await loadResolved()
  }

  const onChatChange = async (value: string): Promise<void> => {
    if (!activeChatId) return
    const id = value === '' ? null : value
    await api().setChatWorkflow(profileId, activeChatId, id)
    setChatIdState(id)
    await loadResolved()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 8
        }}
      >
        <strong>{t('workflow.heading')}</strong>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          onClick={() => void onImport()}
        >
          {t('workflow.import')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {workflows.map((w) => (
          <div
            key={w.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 0',
              borderBottom: '1px solid var(--rpt-border)'
            }}
          >
            <span style={{ flex: 1 }}>
              {w.name}
              {w.builtin && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 11,
                    opacity: 0.6,
                    border: '1px solid var(--rpt-border)',
                    borderRadius: 4,
                    padding: '1px 5px'
                  }}
                >
                  {t('workflow.builtin')}
                </span>
              )}
            </span>
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 12, padding: '2px 8px' }}
              onClick={() => void onEdit(w.id)}
            >
              {t('common.edit')}
            </button>
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 12, padding: '2px 8px' }}
              onClick={() => onExport(w.id, w.name)}
            >
              {t('workflow.export')}
            </button>
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 12, padding: '2px 8px' }}
              onClick={() => void onClone(w.id)}
            >
              {t('workflow.clone')}
            </button>
            {!w.builtin && (
              <button
                className="rpt-duel-secondary"
                style={{ fontSize: 12, padding: '2px 8px' }}
                onClick={() => void onDelete(w.id)}
              >
                {t('workflow.delete')}
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ opacity: 0.7 }}>{t('workflow.globalDefault')}</span>
          <select value={globalId ?? ''} onChange={(e) => void onGlobalChange(e.target.value)}>
            <option value="">{t('workflow.inherit')}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>

        {activeChatId && characterId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ opacity: 0.7 }}>{t('workflow.worldDefault')}</span>
            <select value={worldId ?? ''} onChange={(e) => void onWorldChange(e.target.value)}>
              <option value="">{t('workflow.inherit')}</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {activeChatId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ opacity: 0.7 }}>{t('workflow.sessionOverride')}</span>
            <select value={chatId ?? ''} onChange={(e) => void onChatChange(e.target.value)}>
              <option value="">{t('workflow.inherit')}</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {activeChatId && resolved && (
        <div style={{ opacity: 0.7 }}>
          {t('workflow.resolved')} {workflows.find((w) => w.id === resolved)?.name ?? resolved}
        </div>
      )}

      {activeChatId && <TracePanel trace={lastTrace} />}
    </div>
  )
}
