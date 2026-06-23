import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
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
      <span className="nav-brand">RP Terminal</span>
      <div className="nav-tabs">
        {tab('world', 'World')}
        {tab('sessions', 'Sessions', !hasCharacter)}
        {tab('persona', 'Persona')}
        {tab('preset', 'Preset')}
        {tab('lorebook', 'Lorebook', !hasCharacter)}
        {tab('scripts', 'Scripts', !hasCharacter)}
        {tab('regex', 'Regex')}
        {tab('api', 'API')}
        {tab('settings', 'Settings')}
        {tab('logs', 'Logs')}
      </div>
      <span className="nav-status">
        {profileName} · {activeCharacter?.card.data.name || 'no world'} ·{' '}
        {activePresetName || 'no preset'}
      </span>
    </div>
  )
}
