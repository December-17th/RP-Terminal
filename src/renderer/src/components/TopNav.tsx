import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore } from '../stores/uiStore'
import type { PanelTab } from './panelTabs'

/** The top navigation bar: brand, panel tabs, and the active-context status line. */
export function TopNav({
  panel,
  profileName,
  onSelectPanel
}: {
  panel: PanelTab
  profileName: string
  onSelectPanel: (p: PanelTab) => void
}): React.ReactElement {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activePresetName = usePresetStore((s) => s.preset?.name)
  const hasCharacter = !!activeCharacter

  const tab = (key: PanelTab, label: string, disabled = false): React.ReactElement => (
    <button
      className={`nav-tab ${panel === key ? 'active' : ''}`}
      disabled={disabled}
      onClick={() => onSelectPanel(key)}
    >
      {label}
    </button>
  )

  return (
    <div className="top-nav">
      <button
        className="nav-brand"
        onClick={() => useChatStore.getState().clearActiveChat()}
        title="Back to worlds"
      >
        RP Terminal
      </button>
      <div className="nav-crumbs">
        <button
          className="nav-crumb"
          onClick={() => {
            useUiStore.getState().setLauncherWorldId(null)
            useChatStore.getState().clearActiveChat()
          }}
          title="Switch world"
        >
          <span className="nav-crumb-label">{activeCharacter?.card.data.name || 'World'}</span>
          <span className="nav-crumb-caret">⌄</span>
        </button>
        <span className="nav-crumb-sep">/</span>
        <button
          className="nav-crumb"
          onClick={() => {
            if (activeCharacter) useUiStore.getState().setLauncherWorldId(activeCharacter.id)
            useChatStore.getState().clearActiveChat()
          }}
          title="Switch session"
        >
          <span className="nav-crumb-label">Session</span>
          <span className="nav-crumb-caret">⌄</span>
        </button>
      </div>
      <div className="nav-tabs">
        {tab('persona', 'Persona')}
        {tab('preset', 'Preset')}
        {tab('lorebook', 'Lorebook', !hasCharacter)}
        {tab('scripts', 'Scripts', !hasCharacter)}
        {tab('regex', 'Regex')}
        {tab('api', 'API')}
        <button className="nav-tab" onClick={() => useUiStore.getState().openSettings()}>
          Settings
        </button>
        {tab('logs', 'Logs')}
      </div>
      <span className="nav-status">
        {profileName} · {activeCharacter?.card.data.name || 'no world'} ·{' '}
        {activePresetName || 'no preset'}
      </span>
    </div>
  )
}
