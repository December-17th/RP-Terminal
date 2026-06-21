import { useEffect, useState } from 'react'
import { useProfileStore } from './stores/profileStore'
import { useCharacterStore } from './stores/characterStore'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { usePresetStore } from './stores/presetStore'
import { useLogStore } from './stores/logStore'
import { useRegexStore } from './stores/regexStore'
import { usePluginsStore } from './stores/pluginsStore'
import { FpsOverlay } from './components/FpsOverlay'
import { ToastStack } from './components/ToastStack'
import { ProfilePicker } from './components/ProfilePicker'
import { TopNav } from './components/TopNav'
import { PanelRouter } from './components/PanelRouter'
import { ChatView } from './components/ChatView'
import { RightPanel } from './components/RightPanel'
import type { PanelTab } from './components/panelTabs'
import { initSlash } from './plugin/slash'

export default function App(): React.ReactElement {
  const activeProfile = useProfileStore((s) => s.activeProfile)
  const loadProfiles = useProfileStore((s) => s.loadProfiles)
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const loadCharacters = useCharacterStore((s) => s.loadCharacters)
  const activeCharacterId = useCharacterStore((s) => s.activeCharacter?.id ?? null)
  const loadChats = useChatStore((s) => s.loadChats)
  const activeChatId = useChatStore((s) => s.activeChatId)

  const [panel, setPanel] = useState<PanelTab>('world')

  useEffect(() => {
    loadProfiles()
    initSlash() // register built-in slash commands once
    // Live streaming text for the active chat's in-flight response.
    const unsubDelta = window.api.onGenerationDelta(({ chatId, delta }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useChatStore.getState().appendDelta(delta)
      }
    })
    // Live log stream for the Logs panel.
    const unsubLog = window.api.onLog((entry) => useLogStore.getState().add(entry))
    return () => {
      unsubDelta()
      unsubLog()
    }
  }, [])

  useEffect(() => {
    if (activeProfile) {
      loadSettings(activeProfile.id)
      loadCharacters(activeProfile.id)
      loadChats(activeProfile.id)
      usePresetStore.getState().load(activeProfile.id)
      usePluginsStore.getState().load(activeProfile.id)
    }
  }, [activeProfile])

  // Resolve display regex for the active world/session scope (global ⊕ world(card) ⊕
  // session(chat)) so a card's bundled regex only fires when that world is loaded.
  useEffect(() => {
    if (activeProfile) {
      useRegexStore.getState().load(activeProfile.id, {
        cardId: activeCharacterId,
        chatId: activeChatId ?? null
      })
    }
  }, [activeProfile, activeCharacterId, activeChatId])

  // Apply the chat font size preference to the message area.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--rpt-chat-font',
      `${settings?.ui?.font_size ?? 16}px`
    )
  }, [settings?.ui?.font_size])

  if (!activeProfile) return <ProfilePicker />

  return (
    <>
      <TopNav panel={panel} profileName={activeProfile.name} onSelectPanel={setPanel} />

      <div className="app-body">
        <div className="sidebar-left">
          <PanelRouter panel={panel} profileId={activeProfile.id} onSelectPanel={setPanel} />
        </div>

        <div className="main-content">
          <ChatView profileId={activeProfile.id} />
        </div>

        <div className="sidebar-right">
          <RightPanel profileId={activeProfile.id} />
        </div>
      </div>

      {settings?.ui?.show_fps && <FpsOverlay />}

      <ToastStack />
    </>
  )
}
