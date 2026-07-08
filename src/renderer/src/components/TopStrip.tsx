import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore, type SettingsSection } from '../stores/uiStore'
import { useT } from '../i18n'

/**
 * The play-mode top strip — a menu-bar shell that REPLACES the old tab TopNav. The tab nav was
 * retired (workspace panels are now game + debug only); instead the config/authoring surfaces are
 * reached from direct buttons here, each opening its Settings section, and the full editors live in
 * the Settings hub (useUiStore.openSettings(section)). Layout: brand · world/session breadcrumb ·
 * ‹spacer› · Persona / Preset / Lorebook / Assets / Connection buttons · Workflow · settings gear.
 * The right padding (in CSS) reserves the OS window-control overlay; the strip is the window drag
 * region. (These were once dropdowns; they were flattened to plain buttons because the dropdowns'
 * WCV suppression caused a visible flash of the native play-area panels.)
 */

export function TopStrip({
  profileName
}: {
  profileId: string
  profileName: string
}): React.ReactElement {
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const activePresetName = usePresetStore((s) => s.preset?.name)
  const t = useT()

  const worldName = activeCharacter?.card.data.name || t('nav.session')
  const openSettings = (section: SettingsSection): void => useUiStore.getState().openSettings(section)

  return (
    <div className="tstrip">
      <button
        className="tstrip-brand"
        onClick={() => useChatStore.getState().clearActiveChat()}
        title={t('nav.backToWorlds')}
      >
        <span className="dot" aria-hidden="true">
          ▮
        </span>
        RP Terminal
      </button>

      <div className="tstrip-crumbs">
        <button
          className="tmenu-btn crumb"
          onClick={() => {
            useUiStore.getState().setLauncherWorldId(null)
            useChatStore.getState().clearActiveChat()
          }}
          title={t('nav.switchWorld')}
        >
          <span className="tstrip-crumb-label">{worldName}</span>
          <span className="caret" aria-hidden="true">
            ⌄
          </span>
        </button>
        <span className="tstrip-sep">/</span>
        <button
          className="tmenu-btn crumb"
          onClick={() => {
            if (activeCharacter) useUiStore.getState().setLauncherWorldId(activeCharacter.id)
            useChatStore.getState().clearActiveChat()
          }}
          title={t('nav.switchSession')}
        >
          <span className="tstrip-crumb-label">{t('nav.session')}</span>
          <span className="caret" aria-hidden="true">
            ⌄
          </span>
        </button>
      </div>

      <span className="tstrip-spacer" title={`${profileName} · ${activePresetName || ''}`} />

      <div className="tstrip-menus">
        <button
          className="tmenu-btn"
          onClick={() => openSettings('persona')}
          title={t('strip.open', { name: t('nav.persona') })}
        >
          {t('nav.persona')}
        </button>

        <button
          className="tmenu-btn"
          onClick={() => openSettings('preset')}
          title={t('strip.open', { name: t('nav.preset') })}
        >
          {t('nav.preset')}
        </button>

        <button
          className="tmenu-btn"
          onClick={() => openSettings('lorebook')}
          title={t('strip.open', { name: t('nav.lorebook') })}
        >
          {t('nav.lorebook')}
        </button>

        <button
          className="tmenu-btn"
          onClick={() => openSettings('assets')}
          title={t('strip.open', { name: t('nav.assets') })}
        >
          {t('nav.assets')}
        </button>

        <button
          className="tmenu-btn"
          onClick={() => openSettings('connection')}
          title={t('strip.open', { name: t('settings.connection') })}
        >
          {t('settings.connection')}
        </button>

        <button
          className="tmenu-btn"
          onClick={() => useUiStore.getState().openWorkflowEditor()}
          title={t('nav.workflowTitle')}
        >
          {t('nav.workflow')}
        </button>

        <button
          className="tmenu-btn gear"
          onClick={() => openSettings('app')}
          title={t('nav.settings')}
        >
          ⚙
        </button>
      </div>
    </div>
  )
}
