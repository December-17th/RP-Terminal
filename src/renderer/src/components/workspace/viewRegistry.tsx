/* eslint-disable react-refresh/only-export-components -- a view registry intentionally
   co-locates its internal wrapper components with the registry/options it exports. */
import React from 'react'
import { useNavStore } from '../../stores/navStore'
import { ChatView } from '../ChatView'
import { StatusView } from '../StatusView'
import { LogsPanel } from '../LogsPanel'
import { PanelRouter } from '../PanelRouter'
import { WcvTestView } from './WcvPanel'
import { CombatView } from './CombatView'
import { VariablesView } from './VariablesView'
import { TablesView } from './TablesView'
import { useWorkspaceContext } from './context'
import { UsageView } from '../UsageView'
import { useT } from '../../i18n'
import { useUiStore } from '../../stores/uiStore'

/**
 * The set of views a workspace panel can host. Each entry is a self-contained component
 * that pulls everything it needs from the stores / WorkspaceContext, so a panel can render
 * `ViewRegistry[view].Component` with no props. Adding a view here makes it available in
 * every panel's view-picker. (Phase 2 grows this with richer native MVU views.)
 */

const NavigatorPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  const panel = useNavStore((s) => s.panel)
  const setPanel = useNavStore((s) => s.setPanel)
  return <PanelRouter panel={panel} profileId={profileId} onSelectPanel={setPanel} />
}

const ChatPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <ChatView profileId={profileId} />
}

const StatusPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <StatusView profileId={profileId} />
}

const CombatPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <CombatView profileId={profileId} />
}

// The duel now lives in a centered popup (DuelPopup), not a resizable panel — its pixel-positioned
// board scrambled at small panel sizes. A saved layout referencing view:'duel' resolves to this thin
// launcher, which opens the popup (also the debug mock-duel entry when no duel is active).
const DuelPanel: React.FC = () => {
  const t = useT()
  const openDuelPopup = useUiStore((s) => s.openDuelPopup)
  return (
    <div className="rpt-cc-launch">
      <div className="rpt-cc-launch-card">
        <div className="rpt-cc-launch-icon" aria-hidden>
          ⚔
        </div>
        <h2 className="rpt-cc-launch-title">{t('duel.popupTitle')}</h2>
        <p className="rpt-cc-launch-body">{t('duel.launchBody')}</p>
        <button className="btn-accent rpt-cc-launch-btn" onClick={() => openDuelPopup()}>
          {t('duel.open')}
        </button>
      </div>
    </div>
  )
}

const VariablesPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <VariablesView profileId={profileId} />
}

const TablesPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <TablesView profileId={profileId} />
}

const UsagePanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <UsageView profileId={profileId} />
}

// One-canvas rebuild WP6.4b: the workflow editor IS the surface now — workflows AND agents both live
// on that one canvas. These two panel views (view:'agents'/'workflow' in saved layouts) are kept as
// THIN LAUNCHERS so a saved layout still resolves to a designed card (a broken/unknown-view panel
// otherwise) that opens the editor overlay.
const LauncherCard: React.FC<{
  titleKey: string
  bodyKey: string
}> = ({ titleKey, bodyKey }) => {
  const t = useT()
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)
  return (
    <div className="rpt-cc-launch">
      <div className="rpt-cc-launch-card">
        <div className="rpt-cc-launch-icon" aria-hidden>
          ◐
        </div>
        <h2 className="rpt-cc-launch-title">{t(titleKey)}</h2>
        <p className="rpt-cc-launch-body">{t(bodyKey)}</p>
        <button className="btn-accent rpt-cc-launch-btn" onClick={() => openWorkflowEditor()}>
          {t('controlCenter.launch.open')}
        </button>
      </div>
    </div>
  )
}

const AgentsPanel: React.FC = () => (
  <LauncherCard
    titleKey="controlCenter.launch.agentsTitle"
    bodyKey="controlCenter.launch.editorBody"
  />
)

const WorkflowPanel: React.FC = () => (
  <LauncherCard
    titleKey="controlCenter.launch.workflowTitle"
    bodyKey="controlCenter.launch.editorBody"
  />
)

// The workflow EDITOR is deliberately NOT a panel view: the canvas needs the whole window, so it
// lives in the app-level WorkflowEditorOverlay (uiStore.openWorkflowEditor).

// The card's scripts now run in the app-wide invisible script engine (CardScriptWcvHost in App.tsx), not in
// a panel — so this view is just an explanatory note. Visible card UI lives in declared panels (status, …).
const CardScriptsPanel: React.FC = () => {
  const t = useT()
  return (
    <div style={{ opacity: 0.6, fontSize: 13, lineHeight: 1.6, padding: 4 }}>
      {t('cardScripts.engineNote')}
    </div>
  )
}

export interface ViewEntry {
  title: string
  Component: React.FC
  /** true = the view fills its panel and manages its own scrolling (a flex-column body,
   * like the old left/main columns); false/undefined = a plain scrollable block. */
  fill?: boolean
}

export const ViewRegistry: Record<string, ViewEntry> = {
  navigator: { title: 'Navigator', Component: NavigatorPanel, fill: true },
  chat: { title: 'Chat', Component: ChatPanel, fill: true },
  status: { title: 'RPG Status', Component: StatusPanel },
  combat: { title: 'Combat', Component: CombatPanel, fill: true },
  duel: { title: 'Duel', Component: DuelPanel, fill: true },
  variables: { title: 'Variables', Component: VariablesPanel },
  tables: { title: 'Tables', Component: TablesPanel },
  agents: { title: 'Agents', Component: AgentsPanel, fill: true },
  workflow: { title: 'Workflows', Component: WorkflowPanel, fill: true },
  usage: { title: 'Usage', Component: UsagePanel, fill: true },
  'card-scripts': { title: 'Card Scripts', Component: CardScriptsPanel },
  logs: { title: 'Logs', Component: LogsPanel, fill: true },
  // Dev round-trip test for the out-of-process WebContentsView host. Card UIs are no longer hardcoded —
  // a card's UI regexes render inline by default, or the user promotes one to a panel (renderMode:'panel').
  wcv: { title: 'Card UI (WCV test)', Component: WcvTestView, fill: true }
}

/** Stable list of pickable views for a panel header's dropdown. */
export const VIEW_OPTIONS = Object.entries(ViewRegistry).map(([id, e]) => ({
  id,
  title: e.title
}))
