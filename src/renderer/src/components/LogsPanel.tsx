import React, { useEffect, useRef, useState } from 'react'
import { useLogStore, LogEntry } from '../stores/logStore'

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
        <h3>Logs</h3>
        <div className="panel-header-actions">
          <label className="log-autoscroll">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            auto
          </label>
          <button className="btn-ghost danger" onClick={clear}>
            Clear
          </button>
        </div>
      </div>
      <div className="panel-body log-console">
        {entries.length === 0 ? (
          <div className="log-empty">
            No activity yet. Send a message to see raw requests, responses and errors.
          </div>
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
