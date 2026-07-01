import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'

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

export const WorkflowView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const chats = useChatStore((s) => s.chats)
  const characterId = chats.find((c) => c.id === activeChatId)?.character_id ?? null

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

  const onExport = (id: string, name: string): void => {
    void api().exportWorkflowDialog(profileId, id, name)
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
          {t('workflow.resolved')} {resolved}
        </div>
      )}
    </div>
  )
}
