import { useEffect } from 'react'
import { useProfileStore } from './stores/profileStore'
import { useCharacterStore } from './stores/characterStore'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { usePresetStore } from './stores/presetStore'
import { useLogStore } from './stores/logStore'
import { useRegexStore } from './stores/regexStore'
import { usePluginsStore } from './stores/pluginsStore'
import { FpsOverlay } from './components/FpsOverlay'
import { UsageOverlay } from './components/UsageOverlay'
import { ToastStack } from './components/ToastStack'
import { ProfilePicker } from './components/ProfilePicker'
import { TopNav } from './components/TopNav'
import { Workspace } from './components/workspace/Workspace'
import { StaticWorkspace } from './components/workspace/StaticWorkspace'
import { DEFAULT_STATIC_LAYOUT } from './components/workspace/WcvPanel'
import { PluginHost } from './components/PluginHost'
import { useNavStore } from './stores/navStore'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useComposerStore } from './stores/composerStore'
import { initSlash } from './plugin/slash'
import { chatTransitionEvents, messageMutationEvents } from './plugin/events'
import { emitCardHostEvent } from './cardBridge/cardHostEvents'
import { applyTheme } from './theme'

export default function App(): React.ReactElement {
  const activeProfile = useProfileStore((s) => s.activeProfile)
  const loadProfiles = useProfileStore((s) => s.loadProfiles)
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const loadCharacters = useCharacterStore((s) => s.loadCharacters)
  const activeCharacterId = useCharacterStore((s) => s.activeCharacter?.id ?? null)
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const loadChats = useChatStore((s) => s.loadChats)
  const activeChatId = useChatStore((s) => s.activeChatId)

  const panel = useNavStore((s) => s.panel)
  const setPanel = useNavStore((s) => s.setPanel)

  useEffect(() => {
    loadProfiles()
    initSlash() // register built-in slash commands once
    // Live streaming text for the active chat's in-flight response.
    const unsubDelta = window.api.onGenerationDelta(({ chatId, delta }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useChatStore.getState().appendDelta(delta)
        // Forward streamed tokens to card UIs (STREAM_TOKEN_RECEIVED) — the accumulated text so far.
        const streamingText = useChatStore.getState().streamingText
        window.api.wcvBroadcastEvent(chatId, 'stream_token_received', streamingText)
        emitCardHostEvent('stream_token_received', streamingText)
      }
    })
    // Live log stream for the Logs panel.
    const unsubLog = window.api.onLog((entry) => useLogStore.getState().add(entry))
    // A WebContentsView card panel wrote variables → reflect them in the native panels.
    const unsubWcv = window.api.onWcvHostVars(({ chatId, variables }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useChatStore.getState().setLatestFloorVariables(variables)
      }
    })
    // A card panel asked to set the chat input box (onboarding finish "inject prompt").
    const unsubInput = window.api.onWcvHostInput(({ chatId, text }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useComposerStore.getState().injectInput(text)
      }
    })
    // A card panel (e.g. home "start game") changed message content via saveChat → reload the floors.
    const unsubReload = window.api.onWcvHostReload(({ chatId }) => {
      const st = useChatStore.getState()
      const pid = useProfileStore.getState().activeProfile?.id
      if (pid && chatId === st.activeChatId) st.setActiveChat(pid, chatId)
    })
    // Broadcast the latest stat_data to any WebContentsView card panel whenever floors change
    // (a model turn / re-evaluate / edit), so the card's own UI reflects model-driven updates live.
    const unsubFloors = useChatStore.subscribe((state, prev) => {
      if (state.floors === prev.floors || !state.activeChatId) return
      const sd = state.floors.length
        ? state.floors[state.floors.length - 1]?.variables?.stat_data
        : undefined
      if (sd) window.api.wcvBroadcastVars(state.activeChatId, sd)
    })
    // Broadcast TavernHelper lifecycle/mutation events to WCV cards — reusing the same pure event
    // functions the iframe scripts use (CardScriptHost). generation start/end + message
    // received/updated/deleted/swiped, computed from the chat-store transition.
    const unsubEvents = useChatStore.subscribe((state, prev) => {
      const chatId = state.activeChatId
      if (!chatId) return
      const toDesc = (
        fs: typeof state.floors
      ): { floor: number; content: string; swipeId: number }[] =>
        fs.map((f) => ({ floor: f.floor, content: f.response.content, swipeId: f.swipe_id ?? 0 }))
      const events = [
        ...chatTransitionEvents(
          { isGenerating: prev.isGenerating, floorCount: prev.floors.length },
          { isGenerating: state.isGenerating, floorCount: state.floors.length }
        ),
        ...messageMutationEvents(toDesc(prev.floors), toDesc(state.floors))
      ]
      for (const ev of events) {
        window.api.wcvBroadcastEvent(chatId, ev.name, ev.payload)
        emitCardHostEvent(ev.name, ev.payload)
      }
    })
    return () => {
      unsubDelta()
      unsubLog()
      unsubWcv()
      unsubInput()
      unsubReload()
      unsubFloors()
      unsubEvents()
    }
  }, [])

  useEffect(() => {
    if (activeProfile) {
      const pid = activeProfile.id
      // Seed the workspace from this profile's saved per-mode layouts once settings land.
      loadSettings(pid).then(() =>
        useWorkspaceStore
          .getState()
          .load(pid, useSettingsStore.getState().settings?.workspace?.layouts)
      )
      loadCharacters(pid)
      loadChats(pid)
      usePresetStore.getState().load(pid)
      usePluginsStore.getState().load(pid)
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

  // Apply the selected theme's token set whenever it changes (and on first settings load).
  useEffect(() => {
    applyTheme(settings?.ui?.theme)
  }, [settings?.ui?.theme])

  if (!activeProfile) return <ProfilePicker />

  // A card can declare a static, card-determined layout; the dev flag `localStorage['rpt-static-demo']`
  // forces a default static layout so the StaticWorkspace can be tried on a card that doesn't.
  const cardPanelUi = activeCharacter?.card?.data?.extensions?.rp_terminal?.panel_ui
  const staticLayout =
    cardPanelUi?.mode === 'static' && cardPanelUi.slots?.length
      ? cardPanelUi
      : typeof localStorage !== 'undefined' && localStorage.getItem('rpt-static-demo')
        ? DEFAULT_STATIC_LAYOUT
        : null

  return (
    <>
      <TopNav panel={panel} profileName={activeProfile.name} onSelectPanel={setPanel} />

      {staticLayout ? (
        <StaticWorkspace profileId={activeProfile.id} layout={staticLayout} />
      ) : (
        <Workspace profileId={activeProfile.id} />
      )}

      {/* Standalone-plugin runtime stays mounted app-wide (outside the workspace) so its
          iframes never reparent/reload; the dock is height-bounded by CSS. */}
      <div className="app-plugin-dock">
        <PluginHost profileId={activeProfile.id} />
      </div>

      {settings?.ui?.show_fps && <FpsOverlay />}
      {settings?.ui?.usage_meter?.enabled && <UsageOverlay profileId={activeProfile.id} />}

      <ToastStack />
    </>
  )
}
