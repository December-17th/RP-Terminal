import React, { useEffect, useState } from 'react'
import { LogsPanel } from '../LogsPanel'
import { useLogStore } from '../../stores/logStore'
import { applyThemeForScheme } from '../../theme'
import { useT } from '../../i18n'
import './debug.css'

/**
 * The standalone shell for the separate Debug window (WP-D1). Deliberately minimal: it does NOT mount
 * the full app (no chat/character/preset stores, no card runtime) — it exists so the Logs panel (and,
 * later, a Retrieval tab — WP-D2) stays reachable even when a card's custom UI covers the main window.
 *
 * Log wiring mirrors App.tsx: seed the store from getLogs(), then subscribe to the live 'log-event'
 * stream via onLog (logService already fans out to every open window, this one included). The tab
 * strip carries a single "Logs" tab today; it is a list so WP-D2 can add "Retrieval" beside it.
 */

type DebugTab = 'logs'

export function DebugApp(): React.ReactElement {
  const t = useT()
  const [tab, setTab] = useState<DebugTab>('logs')

  // Follow the OS light/dark preference so the window is legible in both themes without a profile.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => applyThemeForScheme(undefined, mq.matches ? 'dark' : 'light')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // Seed history, then follow the live log stream (mirror of App.tsx's onLog wiring).
  useEffect(() => {
    void useLogStore.getState().load()
    const unsub = window.api.onLog((entry) => useLogStore.getState().add(entry))
    return unsub
  }, [])

  const tabs: { id: DebugTab; label: string }[] = [{ id: 'logs', label: t('debug.tabLogs') }]

  return (
    <div className="debug-shell">
      <header className="debug-header">
        <span className="debug-title">{t('debug.title')}</span>
        <nav className="debug-tabs" role="tablist">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              role="tab"
              aria-selected={tab === tb.id}
              className={`debug-tab${tab === tb.id ? ' is-active' : ''}`}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="debug-body">{tab === 'logs' && <LogsPanel />}</main>
    </div>
  )
}
