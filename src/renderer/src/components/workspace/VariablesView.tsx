import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'

/**
 * Read-only variable inspector: shows the active chat's live variables for debugging.
 *  - MVU `stat_data` (the latest floor's state),
 *  - the full floor `variables` blob (delta_data / combat_cue / any snapshotted globals),
 *  - the per-chat card KV ("session KV", `chat-card-vars-get`).
 * All chat-scoped, refetched when the active chat changes — a diagnostic for stale-variable /
 * session-switch questions. Pure display; never mutates state.
 */
const api = (): any => (window as unknown as { api: any }).api

const Section: React.FC<{ title: string; value: unknown; empty: string }> = ({
  title,
  value,
  empty
}) => {
  const t = useT()
  const isEmpty =
    value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)
  const json = isEmpty ? '' : JSON.stringify(value, null, 2)
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
              void navigator.clipboard?.writeText(json)
              useToastStore.getState().push(t('variables.copied'))
            }}
          >
            {t('variables.copy')}
          </button>
        ) : null}
      </summary>
      {isEmpty ? (
        <div style={{ opacity: 0.5, fontSize: 12, padding: '6px 2px' }}>
          <em>{empty}</em>
        </div>
      ) : (
        <pre
          style={{
            margin: '6px 0 0',
            padding: 10,
            borderRadius: 6,
            background: 'var(--rpt-bg-secondary)',
            border: '1px solid var(--rpt-border)',
            fontSize: 12,
            lineHeight: 1.5,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {json}
        </pre>
      )}
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
        <Section title={t('variables.mvuState')} value={statData} empty={t('variables.empty')} />
        <Section title={t('variables.floorVars')} value={latest} empty={t('variables.empty')} />
        <Section title={t('variables.sessionKv')} value={cardKv} empty={t('variables.empty')} />
      </div>
    </div>
  )
}
