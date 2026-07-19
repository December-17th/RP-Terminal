import React from 'react'
import { useCharacterStore } from '../stores/characterStore'
import { usePresetStore } from '../stores/presetStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore, type SettingsSection } from '../stores/uiStore'
import { useT } from '../i18n'
import { maintenanceSummary, type TableStatusLike } from './workspace/memoryPaneModel'

const api = (): any => (window as unknown as { api: any }).api

/**
 * The memory entry chip (table-refill WS6 Phase B): 「记忆 · N」 in the top strip, N = the max
 * unprocessed backlog across the active chat's tables (the maintenanceSummary roll-up). Opens the
 * full-window Memory Manager directly — the manager was previously reachable ONLY through Settings,
 * and this chip is also the table-data route for card `static` layouts that hide the workspace
 * views (the Assets-popup precedent). Quiet by design: a plain strip button; the count pill is
 * warning-TINTED (soft bg + border), its text stays --rpt-text-primary so the pairing holds AA in
 * all three themes (colored small text would fail on light — the Phase A harness finding).
 */
const MemoryChip: React.FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const [backlog, setBacklog] = React.useState(0)

  React.useEffect(() => {
    if (!activeChatId) {
      setBacklog(0)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const status = ((await api().readChatTablesStatus(profileId, activeChatId)) ??
          {}) as Record<string, TableStatusLike>
        if (!cancelled) setBacklog(maintenanceSummary(status).maxUnprocessed)
      } catch {
        if (!cancelled) setBacklog(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, activeChatId, floors.length])

  if (!activeChatId) return null
  return (
    <button
      className="tmenu-btn"
      onClick={() => useUiStore.getState().openMemoryManager()}
      title={
        backlog > 0 ? t('nav.memoryTitleBacklog', { n: backlog }) : t('nav.memoryTitle')
      }
    >
      {t('nav.memory')}
      {backlog > 0 && <span className="rpt-memchip-count">{backlog}</span>}
    </button>
  )
}

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
  profileId,
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
          onClick={() => useUiStore.getState().openAgentWorkspace()}
          title={t('nav.agentsTitle')}
        >
          {t('nav.agents')}
        </button>

        <MemoryChip profileId={profileId} />

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
