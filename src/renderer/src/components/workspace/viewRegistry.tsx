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
import { DuelView } from './DuelView'
import { useWorkspaceContext } from './context'
import { UsageView } from '../UsageView'
import { useT } from '../../i18n'

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

const DuelPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <DuelView profileId={profileId} />
}

const UsagePanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  return <UsageView profileId={profileId} />
}

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
