import React from 'react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProfileStore } from '../stores/profileStore'
import type { FloorMetrics } from '../../../shared/usageTypes'
import { costFor, cacheHitPct } from '../../../shared/usageCost'
import { TurnChart } from './TurnChart'
import { useT } from '../i18n'

const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)
const pct = (n: number): string => `${Math.round(n)}%`

/** Flatten the active chat's floors into a per-turn metric series. */
const useSeries = (): { floor: number; m: FloorMetrics }[] => {
  const floors = useChatStore((s) => s.floors)
  return floors
    .filter((f) => f.metrics)
    .map((f) => ({ floor: f.floor, m: f.metrics as FloorMetrics }))
}

export const UsageView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const series = useSeries()
  const settings = useSettingsStore((s) => s.settings)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChat = useChatStore((s) => s.setActiveChat)
  const activeProfile = useProfileStore((s) => s.activeProfile)
  const t = useT()

  if (!settings) return null
  if (series.length === 0) {
    return (
      <div style={{ padding: 12 }}>
        <div style={{ opacity: 0.6 }}>{t('usage.view.noMetered')}</div>
        <BackfillButton
          profileId={profileId}
          chatId={activeChatId}
          onDone={() => activeProfile && setActiveChat(profileId, activeChatId!)}
        />
      </div>
    )
  }

  const last = series[series.length - 1].m
  const c = last.cumulative
  const rates = settings.pricing?.[last.turn.model]
  const sessionCost = costFor(c.usage, rates)

  const estPct = series.map((s) => s.m.turn.proxyPct)
  const actualPct = series.map((s) => (s.m.turn.usage ? cacheHitPct(s.m.turn.usage) : 0))

  const exportData = (kind: 'csv' | 'json'): void => {
    if (series.length === 0) return
    const rows = series.map((s) => ({
      floor: s.floor,
      promptTokens: s.m.turn.promptTokens,
      proxyPct: s.m.turn.proxyPct,
      cacheHitPct: s.m.turn.usage ? cacheHitPct(s.m.turn.usage) : null,
      cacheRead: s.m.turn.usage?.cacheRead ?? null,
      cacheWrite: s.m.turn.usage?.cacheWrite ?? null,
      outputTokens: s.m.turn.outputTokens,
      cost: costFor(s.m.turn.usage, rates)
    }))
    let blob: Blob
    if (kind === 'json') {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    } else {
      const cols = Object.keys(rows[0])
      const csv = [
        cols.join(','),
        ...rows.map((r) => cols.map((k) => (r as any)[k] ?? '').join(','))
      ].join('\n')
      blob = new Blob([csv], { type: 'text/csv' })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usage-${activeChatId}.${kind}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px', fontSize: 13 }}
      >
        <span>{t('usage.turns')}</span>
        <span>{c.turns}</span>
        <span>{t('usage.view.avgEstCache')}</span>
        <span>{pct(c.avgProxyPct)}</span>
        <span>{t('usage.view.avgActualCache')}</span>
        <span>{c.usageTurns ? pct(c.avgCacheHitPct) : '—'}</span>
        <span>{t('usage.view.avgPromptTok')}</span>
        <span>{tok(c.avgPromptTokens)}</span>
        <span>{t('usage.view.totalReadWrite')}</span>
        <span>{c.usage ? `${tok(c.usage.cacheRead)} / ${tok(c.usage.cacheWrite)}` : '—'}</span>
        <span>{t('usage.sessionCost')}</span>
        <span>{sessionCost == null ? '—' : `$${sessionCost.toFixed(2)}`}</span>
      </div>

      <div>
        <div style={{ fontSize: 12, opacity: 0.7, display: 'flex', gap: 12 }}>
          <span style={{ color: '#7aa2f7' }}>{t('usage.view.legendEst')}</span>
          <span style={{ color: '#4caf72' }}>{t('usage.view.legendActual')}</span>
        </div>
        <TurnChart
          min={0}
          max={100}
          series={[
            { label: 'est', color: '#7aa2f7', values: estPct },
            { label: 'actual', color: '#4caf72', values: actualPct }
          ]}
        />
      </div>

      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'right', opacity: 0.7 }}>
            <th style={{ textAlign: 'left' }}>#</th>
            <th>{t('usage.view.colPrompt')}</th>
            <th>{t('usage.view.colEst')}</th>
            <th>{t('usage.view.colActual')}</th>
            <th>{t('usage.view.colRead')}</th>
            <th>{t('usage.view.colWrite')}</th>
            <th>{t('usage.view.colOut')}</th>
            <th>$</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const t = s.m.turn
            const $ = costFor(t.usage, rates)
            return (
              <tr key={s.floor} style={{ textAlign: 'right' }}>
                <td style={{ textAlign: 'left' }}>{s.floor}</td>
                <td>{tok(t.promptTokens)}</td>
                <td>{pct(t.proxyPct)}</td>
                <td>{t.usage ? pct(cacheHitPct(t.usage)) : '—'}</td>
                <td>{t.usage ? tok(t.usage.cacheRead) : '—'}</td>
                <td>{t.usage ? tok(t.usage.cacheWrite) : '—'}</td>
                <td>{tok(t.outputTokens)}</td>
                <td>{$ == null ? '—' : `$${$.toFixed(4)}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => exportData('csv')}>{t('usage.view.exportCsv')}</button>
        <button onClick={() => exportData('json')}>{t('usage.view.exportJson')}</button>
        <BackfillButton
          profileId={profileId}
          chatId={activeChatId}
          onDone={() => activeProfile && setActiveChat(profileId, activeChatId!)}
        />
      </div>
    </div>
  )
}

const BackfillButton: React.FC<{
  profileId: string
  chatId: string | null
  onDone: () => void
}> = ({ profileId, chatId, onDone }) => {
  const [busy, setBusy] = React.useState(false)
  const t = useT()
  if (!chatId) return null
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await window.api.backfillUsageMetrics(profileId, chatId)
        setBusy(false)
        onDone()
      }}
    >
      {busy ? t('usage.view.backfilling') : t('usage.view.backfill')}
    </button>
  )
}
