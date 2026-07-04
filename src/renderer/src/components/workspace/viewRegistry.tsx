/* eslint-disable react-refresh/only-export-components -- a view registry intentionally
   co-locates its internal wrapper components with the registry/options it exports. */
import React from 'react'
import { useNavStore } from '../../stores/navStore'
import { ChatView } from '../ChatView'
import { StatusView } from '../StatusView'
import { LogsPanel } from '../LogsPanel'
import { PanelRouter } from '../PanelRouter'
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

// The workflow EDITOR is deliberately NOT a panel view: the canvas needs the whole window, so it
// lives in the app-level WorkflowEditorOverlay (uiStore.openWorkflowEditor). The retired
// agents/workflow launcher stubs + the card-scripts explanatory-note view were removed — a saved
// layout still referencing them resolves to the graceful "unknown view" placeholder (Panel.tsx).

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
  usage: { title: 'Usage', Component: UsagePanel, fill: true },
  logs: { title: 'Logs', Component: LogsPanel, fill: true }
  // (The dev-only "Card UI (WCV test)" round-trip panel was retired — card UIs render inline by
  //  default, or the user promotes one to a panel. The WcvPanel host lives on for those + card
  //  static layouts; see Panel.tsx / StaticWorkspace.tsx.)
}

/** Stable list of pickable views for a panel header's dropdown. */
export const VIEW_OPTIONS = Object.entries(ViewRegistry).map(([id, e]) => ({
  id,
  title: e.title
}))
