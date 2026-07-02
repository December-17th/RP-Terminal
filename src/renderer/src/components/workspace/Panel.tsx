import React from 'react'
import type { PanelNode } from '../../../../shared/workspaceLayout'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { usePanelRegexStore, VIEW_PREFIX } from '../../stores/panelRegexStore'
import { ViewRegistry, VIEW_OPTIONS } from './viewRegistry'
import { WcvPanel } from './WcvPanel'
import { useT } from '../../i18n'

/** Maps the built-in view ids to i18n keys; unknown/spike views fall back to their English title. */
const VIEW_LABEL_KEY: Record<string, string> = {
  navigator: 'view.navigator',
  chat: 'view.chat',
  status: 'status.heading',
  usage: 'view.usage',
  'card-scripts': 'view.cardScripts',
  logs: 'logs.heading',
  memory: 'view.memory',
  workflow: 'workflow.viewTitle',
  'workflow-editor': 'workflowEditor.viewTitle'
}

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
  const panelRegexes = usePanelRegexStore((s) => s.panels)
  const entry = ViewRegistry[node.view]
  const t = useT()

  // Card UIs the user promoted to panels (renderMode:'panel') extend the built-in views; a panel hosting one
  // loads its page URL in a WebContentsView.
  const regexPanel =
    node.view.startsWith(VIEW_PREFIX) &&
    panelRegexes.find((p) => `${VIEW_PREFIX}${p.file}` === node.view)
  const viewOptions = [
    ...VIEW_OPTIONS,
    ...panelRegexes.map((p) => ({ id: `${VIEW_PREFIX}${p.file}`, title: p.scriptName }))
  ]

  return (
    <div className="ws-panel">
      <div className="ws-panel-head">
        <select
          className="ws-view-pick"
          value={node.view}
          title={t('panel.chooseView')}
          onChange={(e) => setView(mode, node.key, e.target.value)}
        >
          {viewOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {VIEW_LABEL_KEY[o.id] ? t(VIEW_LABEL_KEY[o.id]) : o.title}
            </option>
          ))}
        </select>
        <span className="ws-panel-spacer" />
        <button
          className="ws-panel-btn"
          title={node.hidden ? t('panel.showPanel') : t('panel.collapsePanel')}
          onClick={() => toggleHidden(mode, node.key)}
        >
          {node.hidden ? '▢' : '—'}
        </button>
        <button
          className="ws-panel-btn"
          title={t('panel.resetLayout', { mode })}
          onClick={() => resetMode(mode)}
        >
          ↺
        </button>
      </div>
      {!node.hidden &&
        (regexPanel ? (
          <div className="ws-panel-body ws-fill">
            <WcvPanel
              slotId={`${VIEW_PREFIX}${regexPanel.file}:${node.key}`}
              url={regexPanel.url}
            />
          </div>
        ) : entry ? (
          <div className={`ws-panel-body ${entry.fill ? 'ws-fill' : 'ws-scroll'}`}>
            <entry.Component />
          </div>
        ) : (
          <div className="ws-panel-body ws-scroll" style={{ color: 'var(--rpt-danger, #e66)' }}>
            {t('panel.unknownView', { view: node.view })}
          </div>
        ))}
    </div>
  )
}
