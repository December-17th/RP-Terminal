import React from 'react'
import { asBar, asValueDesc, isPlainObject, formatPrimitive } from './statViewHelpers'

/**
 * Recursive auto-renderer for MVU/RPG `stat_data` (Track R / R3). Renders arbitrary
 * nested state — objects as collapsible groups, arrays as lists, value/description
 * tuples with their note, and value/max pairs as bars — so a card needs no
 * hand-authored `ui_layout` to get a full status panel. Live updates come for free:
 * the latest floor's variables flow in as `data` and re-render on each fold.
 */

const Bar: React.FC<{ label?: string; value: number; max: number }> = ({ label, value, max }) => {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <div className="stat-bar">
      <div className="stat-bar-head">
        <span className="stat-key">{label}</span>
        <span className="stat-val">
          {value} / {max}
        </span>
      </div>
      <div className="stat-bar-track">
        <div className="stat-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const Node: React.FC<{ name?: string; value: unknown }> = ({ name, value }) => {
  const bar = asBar(value)
  if (bar) return <Bar label={name} value={bar.value} max={bar.max} />

  const vd = asValueDesc(value)
  if (vd)
    return (
      <div className="stat-row" title={vd.description}>
        <span className="stat-key">{name}</span>
        <span className="stat-val">{formatPrimitive(vd.value)}</span>
        {vd.description ? <span className="stat-desc">{vd.description}</span> : null}
      </div>
    )

  if (Array.isArray(value))
    return (
      <details className="stat-group" open>
        <summary className="stat-group-title">
          {name} <span className="stat-count">({value.length})</span>
        </summary>
        <div className="stat-array">
          {value.length === 0 ? <div className="stat-empty">—</div> : null}
          {value.map((item, i) =>
            isPlainObject(item) || Array.isArray(item) ? (
              <div className="stat-item" key={i}>
                <Node value={item} />
              </div>
            ) : (
              <div className="stat-item" key={i}>
                {formatPrimitive(item)}
              </div>
            )
          )}
        </div>
      </details>
    )

  if (isPlainObject(value)) {
    const children = (
      <div className="stat-children">
        {Object.entries(value).map(([k, v]) => (
          <Node key={k} name={k} value={v} />
        ))}
      </div>
    )
    // The root object renders its entries directly (no wrapping title).
    if (!name) return children
    return (
      <details className="stat-group" open>
        <summary className="stat-group-title">{name}</summary>
        {children}
      </details>
    )
  }

  return (
    <div className="stat-row">
      <span className="stat-key">{name}</span>
      <span className="stat-val">{formatPrimitive(value)}</span>
    </div>
  )
}

export const StatView: React.FC<{ data: Record<string, unknown> }> = ({ data }) => (
  <div className="stat-view">
    <Node value={data} />
  </div>
)
