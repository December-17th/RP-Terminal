import React from 'react'
import type { PanelNode } from '../../../../shared/workspaceLayout'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { ViewRegistry, VIEW_OPTIONS } from './viewRegistry'

/**
 * One workspace panel: a header (view-picker + hide + reset) over the hosted view's body.
 * The body is `fill` (flex column, view manages its own scroll — chat/nav/logs) or `scroll`
 * (a plain scrollable block — status/scripts), matching how each view behaved in the old
 * fixed columns. `mode` is the active FSM mode the mutations are scoped to.
 */
export const Panel: React.FC<{ node: PanelNode; mode: string }> = ({ node, mode }) => {
  const setView = useWorkspaceStore((s) => s.setView)
  const toggleHidden = useWorkspaceStore((s) => s.toggleHidden)
  const resetMode = useWorkspaceStore((s) => s.resetMode)
  const entry = ViewRegistry[node.view]

  return (
    <div className="ws-panel">
      <div className="ws-panel-head">
        <select
          className="ws-view-pick"
          value={node.view}
          title="Choose which view this panel shows"
          onChange={(e) => setView(mode, node.key, e.target.value)}
        >
          {VIEW_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
        <span className="ws-panel-spacer" />
        <button
          className="ws-panel-btn"
          title={node.hidden ? 'Show panel' : 'Collapse panel'}
          onClick={() => toggleHidden(mode, node.key)}
        >
          {node.hidden ? '▢' : '—'}
        </button>
        <button
          className="ws-panel-btn"
          title={`Reset the ${mode} layout to default`}
          onClick={() => resetMode(mode)}
        >
          ↺
        </button>
      </div>
      {!node.hidden &&
        (entry ? (
          <div className={`ws-panel-body ${entry.fill ? 'ws-fill' : 'ws-scroll'}`}>
            <entry.Component />
          </div>
        ) : (
          <div className="ws-panel-body ws-scroll" style={{ color: 'var(--rpt-danger, #e66)' }}>
            Unknown view: {node.view}
          </div>
        ))}
    </div>
  )
}
