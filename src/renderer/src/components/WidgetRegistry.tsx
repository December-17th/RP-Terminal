import React from 'react'

export interface WidgetProps {
  id: string
  type: string
  path: string
  config: any
  value: any
}

export const StatBar: React.FC<WidgetProps> = ({ config, value }) => {
  const max = config.max || 100
  const current = typeof value === 'number' ? value : 0
  const percentage = Math.min(100, Math.max(0, (current / max) * 100))

  return (
    <div style={{ marginBottom: 15 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontWeight: 'bold' }}>{config.label || 'Stat'}</span>
        <span>
          {current} / {max}
        </span>
      </div>
      <div
        style={{
          width: '100%',
          height: 12,
          backgroundColor: 'var(--rpt-bg-primary)',
          borderRadius: 6,
          overflow: 'hidden',
          border: '1px solid var(--rpt-border)'
        }}
      >
        <div
          style={{
            width: `${percentage}%`,
            height: '100%',
            backgroundColor: config.color || 'var(--rpt-accent)',
            transition: 'width 0.3s ease-out'
          }}
        />
      </div>
    </div>
  )
}

export const TextWidget: React.FC<WidgetProps> = ({ config, value }) => {
  return (
    <div style={{ marginBottom: 10 }}>
      <span style={{ fontWeight: 'bold', marginRight: 10, color: 'var(--rpt-text-secondary)' }}>
        {config.label || 'Text'}:
      </span>
      <span>{value !== undefined ? String(value) : config.defaultValue || ''}</span>
    </div>
  )
}

export const ListWidget: React.FC<WidgetProps> = ({ config, value }) => {
  const items = Array.isArray(value) ? value : []
  return (
    <div style={{ marginBottom: 15 }}>
      <div
        style={{
          fontWeight: 'bold',
          marginBottom: 5,
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 5
        }}
      >
        {config.label || 'List'}
      </div>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {items.map((item, idx) => (
          <li key={idx} style={{ color: 'var(--rpt-text-primary)' }}>
            {String(item)}
          </li>
        ))}
      </ul>
      {items.length === 0 && (
        <div style={{ opacity: 0.5, fontStyle: 'italic', fontSize: '0.9em' }}>Empty</div>
      )}
    </div>
  )
}

export const WidgetRegistry: Record<string, React.FC<WidgetProps>> = {
  StatBar,
  Text: TextWidget,
  List: ListWidget
}
