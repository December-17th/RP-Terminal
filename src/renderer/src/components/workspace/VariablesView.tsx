import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { JsonTreeEditor } from './JsonTreeEditor'
import type { EditOp } from './jsonTreeEdit'

/**
 * Variable inspector + editor for the active chat. Three collapsible sections:
 *  - MVU stat_data (editable → persisted via chatStore.applyVariableOps / applyJsonPatch on the latest floor),
 *  - the full floor variables blob (read-only; derived snapshot),
 *  - the per-chat card KV / "session KV" (editable → persisted whole via chat-card-vars-set).
 * Edits persist immediately. Chat-scoped; refetched when the active chat changes.
 */
const api = (): any => (window as unknown as { api: any }).api

const Section: React.FC<{
  title: string
  value: unknown
  empty: string
  children: React.ReactNode
  /** Render children even when the value is empty — for editable sections, so the tree editor's
   *  root "+ key" row is reachable to add the FIRST key to an empty stat_data / KV. */
  alwaysRender?: boolean
}> = ({ title, value, empty, children, alwaysRender }) => {
  const t = useT()
  const isEmpty =
    value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)
  return (
    <details open style={{ marginBottom: 12 }}>
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        <span>{title}</span>
        {!isEmpty ? (
          <button
            className="rpt-duel-secondary"
            style={{ fontSize: 11, padding: '2px 6px' }}
            onClick={(e) => {
              e.preventDefault()
              void navigator.clipboard?.writeText(JSON.stringify(value, null, 2))
              useToastStore.getState().push(t('variables.copied'))
            }}
          >
            {t('variables.copy')}
          </button>
        ) : null}
      </summary>
      <div style={{ marginTop: 6 }}>
        {isEmpty && !alwaysRender ? (
          <div style={{ opacity: 0.5, fontSize: 12, padding: '2px' }}>
            <em>{empty}</em>
          </div>
        ) : (
          children
        )}
      </div>
    </details>
  )
}

export const VariablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()
  const [cardKv, setCardKv] = React.useState<Record<string, unknown> | null>(null)

  const loadKv = React.useCallback(async () => {
    if (!activeChatId) {
      setCardKv(null)
      return
    }
    try {
      setCardKv((await api().chatCardVarsGet(profileId, activeChatId)) ?? {})
    } catch {
      setCardKv({})
    }
  }, [profileId, activeChatId])

  React.useEffect(() => {
    void loadKv()
  }, [loadKv, floors.length])

  if (!activeChatId) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  const latest = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = (latest as Record<string, unknown> | undefined)?.stat_data
  const hasFloor = floors.length > 0

  const onStatEdit = async (_next: unknown, op: EditOp): Promise<void> => {
    try {
      await useChatStore.getState().applyVariableOps(profileId, [op])
    } catch {
      useToastStore.getState().push(t('variables.editFailed'))
    }
  }

  const onKvEdit = async (next: unknown): Promise<void> => {
    setCardKv(next as Record<string, unknown>)
    try {
      await api().chatCardVarsSet(profileId, activeChatId, next)
    } catch {
      useToastStore.getState().push(t('variables.editFailed'))
      void loadKv()
    }
  }

  return (
    <div>
      <h3
        style={{
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        {t('variables.heading')}
        <button
          className="btn-accent"
          style={{ fontSize: '0.62em', padding: '3px 8px', fontWeight: 400 }}
          onClick={() => void loadKv()}
        >
          {t('variables.refresh')}
        </button>
      </h3>
      <div style={{ marginTop: 16 }}>
        <Section title={t('variables.mvuState')} value={statData} empty={t('variables.empty')} alwaysRender>
          <JsonTreeEditor value={statData ?? {}} onEdit={onStatEdit} readOnly={!hasFloor} />
          {!hasFloor ? (
            <div style={{ opacity: 0.5, fontSize: 12 }}>
              <em>{t('variables.readOnlyHint')}</em>
            </div>
          ) : null}
        </Section>
        <Section title={t('variables.floorVars')} value={latest} empty={t('variables.empty')}>
          <JsonTreeEditor value={latest} onEdit={() => {}} readOnly />
        </Section>
        <Section title={t('variables.sessionKv')} value={cardKv} empty={t('variables.empty')} alwaysRender>
          <JsonTreeEditor value={cardKv ?? {}} onEdit={onKvEdit} />
        </Section>
      </div>
    </div>
  )
}
