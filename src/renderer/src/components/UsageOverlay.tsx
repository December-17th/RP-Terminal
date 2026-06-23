import React, { useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { FloorMetrics } from '../../../shared/usageTypes'
import { costFor } from '../../../shared/usageCost'

/** The metric rows the overlay can show, in display order. `group` splits This-turn vs Session. */
const FIELD_CATALOG: { key: string; label: string; group: 'turn' | 'session' }[] = [
  { key: 'promptTokens', label: 'prompt tok', group: 'turn' },
  { key: 'outputTokens', label: 'output tok', group: 'turn' },
  { key: 'proxyPct', label: 'est cache', group: 'turn' },
  { key: 'cacheHitPct', label: 'actual cache', group: 'turn' },
  { key: 'cacheRead', label: 'cache read', group: 'turn' },
  { key: 'cacheWrite', label: 'cache write', group: 'turn' },
  { key: 'cost', label: 'turn $', group: 'turn' },
  { key: 'turns', label: 'turns', group: 'session' },
  { key: 'avgProxyPct', label: 'avg est', group: 'session' },
  { key: 'avgCacheHitPct', label: 'avg cache', group: 'session' },
  { key: 'avgPromptTokens', label: 'avg prompt', group: 'session' },
  { key: 'sessionCost', label: 'session $', group: 'session' }
]

const pct = (n: number): string => `${Math.round(n)}%`
const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)

/** Resolve one field's display value from the latest floor metrics + pricing (null = hide row). */
const valueFor = (
  key: string,
  m: FloorMetrics,
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
): string | null => {
  const t = m.turn
  const c = m.cumulative
  switch (key) {
    case 'promptTokens':
      return tok(t.promptTokens)
    case 'outputTokens':
      return tok(t.outputTokens)
    case 'proxyPct':
      return pct(t.proxyPct)
    case 'cacheHitPct':
      return t.usage ? pct((t.usage.cacheRead / Math.max(1, t.usage.cacheRead + t.usage.cacheWrite + t.usage.input)) * 100) : '—'
    case 'cacheRead':
      return t.usage ? tok(t.usage.cacheRead) : '—'
    case 'cacheWrite':
      return t.usage ? tok(t.usage.cacheWrite) : '—'
    case 'cost': {
      const $ = costFor(t.usage, rates)
      return $ == null ? null : `$${$.toFixed(4)}`
    }
    case 'turns':
      return `${c.turns}`
    case 'avgProxyPct':
      return pct(c.avgProxyPct)
    case 'avgCacheHitPct':
      return c.usageTurns ? pct(c.avgCacheHitPct) : '—'
    case 'avgPromptTokens':
      return tok(c.avgPromptTokens)
    case 'sessionCost': {
      const $ = costFor(c.usage, rates)
      return $ == null ? null : `$${$.toFixed(2)}`
    }
    default:
      return null
  }
}

export const UsageOverlay: React.FC<{ profileId: string }> = ({ profileId }) => {
  const floors = useChatStore((s) => s.floors)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [gearOpen, setGearOpen] = useState(false)
  const dragState = useRef<{ dx: number; dy: number } | null>(null)

  if (!settings) return null
  const meter = settings.ui.usage_meter
  const latest = [...floors].reverse().find((f) => f.metrics)?.metrics ?? null
  const rates = latest ? settings.pricing?.[latest.turn.model] : undefined
  const enabledFields = new Set(meter.fields)

  const persist = (patch: Partial<typeof meter>): void => {
    updateSettings(profileId, { ui: { ...settings.ui, usage_meter: { ...meter, ...patch } } })
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragState.current = { dx: e.clientX - (meter.x ?? 16), dy: e.clientY - (meter.y ?? window.innerHeight - 160) }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragState.current) return
    persist({ x: e.clientX - dragState.current.dx, y: e.clientY - dragState.current.dy })
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    dragState.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  const pos: React.CSSProperties =
    meter.x != null && meter.y != null
      ? { left: meter.x, top: meter.y }
      : { left: 16, bottom: 16 }

  const rows = FIELD_CATALOG.filter((f) => enabledFields.has(f.key)).map((f) => ({
    ...f,
    value: latest ? valueFor(f.key, latest, rates) : '—'
  }))

  return (
    <div className="usage-overlay" style={{ position: 'fixed', zIndex: 60, ...pos }}>
      <div
        className="usage-overlay-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: 'move', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontWeight: 600 }}>usage</span>
        <button title="Fields" onClick={() => setGearOpen((v) => !v)}>⚙</button>
        <button title={meter.collapsed ? 'Expand' : 'Collapse'} onClick={() => persist({ collapsed: !meter.collapsed })}>
          {meter.collapsed ? '▣' : '▢'}
        </button>
        <button title="Hide (Settings to re-enable)" onClick={() => persist({ enabled: false })}>✕</button>
      </div>

      {gearOpen && (
        <div className="usage-overlay-gear">
          {FIELD_CATALOG.map((f) => (
            <label key={f.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={enabledFields.has(f.key)}
                onChange={(e) => {
                  const next = new Set(enabledFields)
                  e.target.checked ? next.add(f.key) : next.delete(f.key)
                  persist({ fields: FIELD_CATALOG.map((c) => c.key).filter((k) => next.has(k)) })
                }}
              />
              {f.label}
            </label>
          ))}
        </div>
      )}

      {!meter.collapsed && !gearOpen && (
        <div className="usage-overlay-body">
          {!latest && <div style={{ opacity: 0.6 }}>no turns yet</div>}
          {rows
            .filter((r) => r.value != null)
            .map((r) => (
              <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ opacity: 0.7 }}>{r.label}</span>
                <span>{r.value}</span>
              </div>
            ))}
        </div>
      )}

      {meter.collapsed && latest && (
        <div className="usage-overlay-chip">
          {pct(latest.turn.proxyPct)} · {tok(latest.turn.promptTokens)}
        </div>
      )}
    </div>
  )
}
