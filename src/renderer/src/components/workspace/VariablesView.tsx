import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { JsonEditor } from './JsonEditor'

/**
 * Variable inspector + editor for the active chat, tabbed by layer:
 *  - MVU stat_data (editable → whole-object persist via chatStore.setStatData),
 *  - Session KV / per-chat card KV (editable → chatCardVarsSet),
 *  - Floor variables (read-only; derived snapshot).
 * Uses vanilla-jsoneditor (ISC) via the JsonEditor wrapper. Chat-scoped; session KV refetched on chat change.
 */
const api = (): any => (window as unknown as { api: any }).api
type Tab = 'stat' | 'kv' | 'floor'

export const VariablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()
  const [tab, setTab] = React.useState<Tab>('stat')
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
  const statData = (latest as Record<string, unknown> | undefined)?.stat_data ?? {}
  const hasFloor = floors.length > 0

  const onStatChange = (json: unknown): void => {
    void useChatStore
      .getState()
      .setStatData(profileId, json)
      .catch(() => useToastStore.getState().push(t('variables.editFailed')))
  }
  const onKvChange = (json: unknown): void => {
    setCardKv(json as Record<string, unknown>)
    void api()
      .chatCardVarsSet(profileId, activeChatId, json)
      .catch(() => {
        useToastStore.getState().push(t('variables.editFailed'))
        void loadKv()
      })
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'stat', label: t('variables.mvuState') },
    { id: 'kv', label: t('variables.sessionKv') },
    { id: 'floor', label: t('variables.floorVars') }
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 8,
          marginBottom: 8
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map((x) => (
            <button
              key={x.id}
              className={tab === x.id ? 'btn-accent' : 'rpt-duel-secondary'}
              style={{ fontSize: 12, padding: '3px 10px' }}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 8px' }}
          onClick={() => void loadKv()}
        >
          {t('variables.refresh')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'stat' &&
          (hasFloor ? (
            <JsonEditor value={statData} onChange={onStatChange} />
          ) : (
            <div style={{ opacity: 0.5, fontSize: 12 }}>
              <em>{t('variables.readOnlyHint')}</em>
            </div>
          ))}
        {tab === 'kv' && <JsonEditor value={cardKv ?? {}} onChange={onKvChange} />}
        {tab === 'floor' && <JsonEditor value={latest ?? {}} readOnly />}
      </div>
    </div>
  )
}
