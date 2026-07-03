import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n'
import type { PanelTab } from './panelTabs'

/** The top navigation bar: brand, world/session breadcrumb, panel tabs, and the context status line. */
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
  const t = useT()

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
        title={t('nav.backToWorlds')}
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
          title={t('nav.switchWorld')}
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
          title={t('nav.switchSession')}
        >
          <span className="nav-crumb-label">{t('nav.session')}</span>
          <span className="nav-crumb-caret">⌄</span>
        </button>
      </div>
      <div className="nav-tabs">
        {tab('persona', t('nav.persona'))}
        {tab('preset', t('nav.preset'))}
        {tab('lorebook', t('nav.lorebook'), !hasCharacter)}
        {tab('assets', t('nav.assets'), !hasCharacter)}
        {tab('api', t('nav.api'))}
        <button
          className="nav-tab"
          onClick={() => useUiStore.getState().openControlCenter()}
          title={t('nav.controlCenterTip')}
        >
          {t('nav.controlCenter')}
        </button>
        <button className="nav-tab" onClick={() => useUiStore.getState().openSettings()}>
          {t('nav.settings')}
        </button>
        {tab('logs', t('nav.logs'))}
      </div>
      <span className="nav-status">
        {profileName} · {activeCharacter?.card.data.name || 'no world'} ·{' '}
        {activePresetName || 'no preset'}
      </span>
    </div>
  )
}
