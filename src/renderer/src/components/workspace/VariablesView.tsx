import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { JsonEditor } from './JsonEditor'

/**
 * Variable inspector + editor for the active chat, tabbed by layer:
 *  - MVU stat_data (editable → whole-object persist via chatStore.setStatData),
 *  - Session variables / per-chat card KV (会话变量, editable → chatCardVarsSet),
 *  - Global variables / per-profile template-globals (全局变量, editable → pluginGlobalsSet) — where a
 *    beautification card keeps its UI settings,
 *  - Floor variables (read-only; derived snapshot).
 * Uses vanilla-jsoneditor (ISC) via the JsonEditor wrapper. Chat-scoped; KV/globals refetched on change.
 */
const api = (): any => (window as unknown as { api: any }).api
type Tab = 'stat' | 'kv' | 'global' | 'floor'

export const VariablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()
  const [tab, setTab] = React.useState<Tab>('stat')
  const [cardKv, setCardKv] = React.useState<Record<string, unknown> | null>(null)
  const [globals, setGlobals] = React.useState<Record<string, unknown> | null>(null)

  const loadKv = React.useCallback(async () => {
    // Global vars are per-profile (not chat-scoped), so they load even before a chat is open.
    try {
      setGlobals(api().pluginGlobalsGetSync(profileId) ?? {})
    } catch {
      setGlobals({})
    }
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

  // A card's global-var write (inline host setGlobalVars) emits this once disk is written — re-read so the
  // panel reflects it immediately, not only after a new floor. Event name mirrors cardBridge/host.ts.
  React.useEffect(() => {
    const onRefetch = (e: Event): void => {
      if ((e as CustomEvent).detail?.profileId !== profileId) return
      try {
        setGlobals(api().pluginGlobalsGetSync(profileId) ?? {})
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('rpt-globals-refetch', onRefetch)
    return () => window.removeEventListener('rpt-globals-refetch', onRefetch)
  }, [profileId])

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
  const onGlobalChange = (json: unknown): void => {
    setGlobals(json as Record<string, unknown>)
    void api()
      .pluginGlobalsSet(profileId, json)
      .then(() =>
        // Open cards cache globals in the renderer realm — tell them to drop it and re-read this edit.
        // Event name mirrors cardBridge/host.ts (GLOBALS_INVALIDATE_EVENT).
        window.dispatchEvent(new CustomEvent('rpt-globals-invalidate', { detail: { profileId } }))
      )
      .catch(() => {
        useToastStore.getState().push(t('variables.editFailed'))
        void loadKv()
      })
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'stat', label: t('variables.mvuState') },
    { id: 'kv', label: t('variables.sessionVars') },
    { id: 'global', label: t('variables.globalVars') },
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
        {tab === 'global' && <JsonEditor value={globals ?? {}} onChange={onGlobalChange} />}
        {tab === 'floor' && (
          <>
            {/* Agent Result Slots live at variables.__rpt.agent_results and are runtime-owned: the
                runtime writes them on Result Incorporation and floor deletion rewinds them, so they
                are shown but never editable here (Session 10). */}
            <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 4 }}>
              <em>{t('variables.rptReadOnly')}</em>
            </div>
            <JsonEditor value={latest ?? {}} readOnly />
          </>
        )}
      </div>
    </div>
  )
}
