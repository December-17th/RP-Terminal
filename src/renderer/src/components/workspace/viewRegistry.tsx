/* eslint-disable react-refresh/only-export-components -- a view registry intentionally
   co-locates its internal wrapper components with the registry/options it exports. */
import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useCharacterStore } from '../../stores/characterStore'
import { useNavStore } from '../../stores/navStore'
import { ChatView } from '../ChatView'
import { StatusView } from '../StatusView'
import { CardScriptHost } from '../CardScriptHost'
import { LogsPanel } from '../LogsPanel'
import { PanelRouter } from '../PanelRouter'
import { useWorkspaceContext } from './context'

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

// The card's sandboxed script runtime. Keyed by card+chat so switching sessions
// remounts cleanly (matches the old RightPanel behavior).
const CardScriptsPanel: React.FC = () => {
  const { profileId } = useWorkspaceContext()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  if (!activeChatId || !activeCharacter) {
    return <div style={{ opacity: 0.5 }}>Waiting for session...</div>
  }
  return (
    <CardScriptHost
      key={`${activeCharacter.id}:${activeChatId}`}
      profileId={profileId}
      chatId={activeChatId}
      cardId={activeCharacter.id}
      cardName={activeCharacter.card.data.name}
      scripts={activeCharacter.card.data.extensions?.rp_terminal?.scripts || []}
    />
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
  'card-scripts': { title: 'Card Scripts', Component: CardScriptsPanel },
  logs: { title: 'Logs', Component: LogsPanel, fill: true }
}

/** Stable list of pickable views for a panel header's dropdown. */
export const VIEW_OPTIONS = Object.entries(ViewRegistry).map(([id, e]) => ({
  id,
  title: e.title
}))
