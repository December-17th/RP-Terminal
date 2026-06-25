import React, { useEffect, useRef, useState } from 'react'
import { useLogStore, LogEntry } from '../stores/logStore'
import { useT } from '../i18n'

const LEVEL_GLYPH: Record<string, string> = {
  info: 'ℹ',
  request: '→',
  response: '←',
  error: '✗'
}

export const LogsPanel: React.FC = () => {
  const { entries, load, clear } = useLogStore()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [autoscroll, setAutoscroll] = useState(true)
  const t = useT()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (autoscroll) endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, autoscroll])

  const toggle = (id: string): void =>
    setExpanded((cur) => {
      const next = new Set(cur)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('logs.heading')}</h3>
        <div className="panel-header-actions">
          <label className="log-autoscroll">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            {t('logs.auto')}
          </label>
          <button className="btn-ghost danger" onClick={clear}>
            {t('logs.clear')}
          </button>
        </div>
      </div>
      <div className="panel-body log-console">
        {entries.length === 0 ? (
          <div className="log-empty">{t('logs.empty')}</div>
        ) : (
          entries.map((e) => (
            <LogLine
              key={e.id}
              entry={e}
              expanded={expanded.has(e.id)}
              onToggle={() => toggle(e.id)}
            />
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

interface LineProps {
  entry: LogEntry
  expanded: boolean
  onToggle: () => void
}

const LogLine: React.FC<LineProps> = ({ entry, expanded, onToggle }) => {
  const time = new Date(entry.ts).toLocaleTimeString()
  return (
    <div className={`log-line lvl-${entry.level}`}>
      <div className="log-line-head" onClick={entry.detail ? onToggle : undefined}>
        <span className="log-time">{time}</span>
        <span className="log-glyph">{LEVEL_GLYPH[entry.level] ?? '·'}</span>
        <span className="log-label">{entry.label}</span>
        {entry.detail && <span className="log-caret">{expanded ? '▾' : '▸'}</span>}
      </div>
      {expanded && entry.detail && <pre className="log-detail">{entry.detail}</pre>}
    </div>
  )
}
