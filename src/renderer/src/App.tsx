import { useEffect } from 'react'
import { useProfileStore } from './stores/profileStore'
import { useCharacterStore } from './stores/characterStore'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { usePresetStore } from './stores/presetStore'
import { useLorebookStore } from './stores/lorebookStore'
import { usePanelRegexStore, VIEW_PREFIX } from './stores/panelRegexStore'
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
import { CardScriptWcvHost } from './components/CardScriptWcvHost'
import { PluginHost } from './components/PluginHost'
import { useNavStore } from './stores/navStore'
import { useWorkflowTraceStore } from './stores/workflowTraceStore'
import { useWorkflowPanelStore } from './stores/workflowPanelStore'
import type { WorkflowRunTrace } from '../../shared/workflow/trace'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useComposerStore } from './stores/composerStore'
import { initSlash } from './plugin/slash'
import { broadcastHostEvent, initCardEventBridge } from './cardBridge/hostBroadcast'
import { applyTheme } from './theme'
import { useI18nStore } from './i18n'
import { Launcher } from './components/Launcher'
import { StDomCompat } from './components/StDomCompat'
import { SettingsModal } from './components/SettingsModal'
import { WorkflowEditorOverlay } from './components/workflow/WorkflowEditorOverlay'
import { ControlCenterOverlay } from './components/workspace/ControlCenterOverlay'

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
  const activePresetId = usePresetStore((s) => s.activeId)

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
        broadcastHostEvent(chatId, 'stream_token_received', streamingText)
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
    // A card panel asked to "press the send button" (/trigger): the Composer submits the current
    // box content through its normal path. Refused mid-turn like ST.
    const unsubSubmit = window.api.onWcvHostSubmit(({ chatId }) => {
      const st = useChatStore.getState()
      if (chatId === st.activeChatId && !st.isGenerating) {
        useComposerStore.getState().requestSubmit()
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
      // Forward the change origin so a card panel's own write echoed back here doesn't re-fire its MVU
      // events and loop (the WS-3 fix — see chatStore.lastVarsOrigin / shared/thRuntime VarsOrigin).
      if (sd) window.api.wcvBroadcastVars(state.activeChatId, sd, state.lastVarsOrigin)
    })
    // Broadcast TavernHelper lifecycle/mutation events to BOTH transports — the compute+fan-out logic
    // lives in initCardEventBridge (cardBridge/hostBroadcast), so the two paths can't drift (WS-7).
    const unsubEvents = initCardEventBridge()
    // Per-turn workflow run trace → keep the latest per chat for the Workflows trace panel.
    const unsubTrace = window.api.onWorkflowTrace((trace: unknown) =>
      useWorkflowTraceStore.getState().put(trace as WorkflowRunTrace)
    )
    // Opt-in node output panels (spec D4): append deltas; a chat's panels belong to its latest
    // turn, so clear them on the turn's rising edge (isGenerating false→true).
    const unsubPanel = window.api.onWorkflowPanel((p) =>
      useWorkflowPanelStore.getState().append(p)
    )
    const unsubPanelClear = useChatStore.subscribe((state, prev) => {
      if (state.isGenerating && !prev.isGenerating && state.activeChatId) {
        useWorkflowPanelStore.getState().clear(state.activeChatId)
      }
    })
    // A workflow tool node switched the chat's mode main-side (started combat/duel) → the
    // workspace must follow without a user click.
    const unsubModeChanged = window.api.onChatModeChanged(({ chatId, mode }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useChatStore.setState({ activeChatMode: mode })
      }
    })
    return () => {
      unsubDelta()
      unsubLog()
      unsubWcv()
      unsubInput()
      unsubSubmit()
      unsubReload()
      unsubFloors()
      unsubEvents()
      unsubTrace()
      unsubPanel()
      unsubPanelClear()
      unsubModeChanged()
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

  // Resolve display regex for the active scope (global ⊕ world(card) ⊕ session(chat) ⊕
  // preset(active preset)) so bundled regex only fires when its owner is loaded. The active
  // preset id is injected main-side; re-run on preset switch so its display regex refreshes.
  useEffect(() => {
    if (activeProfile) {
      useRegexStore.getState().load(activeProfile.id, {
        cardId: activeCharacterId,
        chatId: activeChatId ?? null
      })
    }
  }, [activeProfile, activeCharacterId, activeChatId, activePresetId])

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

  // Sync the UI language from settings (the i18n store re-renders subscribers on change).
  useEffect(() => {
    useI18nStore.getState().setLocale(settings?.ui?.locale ?? 'en')
  }, [settings?.ui?.locale])

  // Load the active card's promoted regex panels (renderMode:'panel') so they appear in the view-pickers.
  // activePresetId is a dep because list-panel-regex resolves preset-scoped rules against the active preset.
  useEffect(() => {
    const pid = activeProfile?.id
    if (!pid) return
    void usePanelRegexStore
      .getState()
      .load(pid, { cardId: activeCharacter?.id, chatId: activeChatId })
  }, [activeProfile?.id, activeCharacter?.id, activeChatId, activePresetId])

  // If the active card declares a left_panel, find its promoted panel by scriptName and auto-dock it.
  const leftPanelName = activeCharacter?.card?.data?.extensions?.rp_terminal?.left_panel?.name
  const panelRegexes = usePanelRegexStore((s) => s.panels)
  useEffect(() => {
    if (!leftPanelName) return
    const match = panelRegexes.find((p) => p.scriptName === leftPanelName)
    if (match) useWorkspaceStore.getState().ensureLeftPanel(`${VIEW_PREFIX}${match.file}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftPanelName, panelRegexes.map((p) => p.file).join(',')])

  // A card script (e.g. the 创意工坊 workshop) wrote a worldbook in its WCV → refresh the lorebook editor
  // so it doesn't show a stale view (reload the open book only if the user has no unsaved edits).
  useEffect(() => {
    const pid = activeProfile?.id
    if (!pid) return
    return window.api.onWcvLorebookChanged(({ id }) => {
      const lb = useLorebookStore.getState()
      void lb.loadLibrary(pid)
      if (lb.currentId === id && !lb.dirty) void lb.open(pid, id)
    })
  }, [activeProfile?.id])

  if (!activeProfile) return <ProfilePicker />

  // An RPT-native card can declare its own static, card-determined layout (rp_terminal.panel_ui); else the
  // resizable workspace. (ST-compat cards' UIs are inline regex by default, promotable to panels by the user.)
  const cardPanelUi = activeCharacter?.card?.data?.extensions?.rp_terminal?.panel_ui
  const staticLayout =
    cardPanelUi?.mode === 'static' && cardPanelUi.slots?.length ? cardPanelUi : null

  return (
    <>
      {/* ST DOM-compat shim: hidden #send_textarea / #send_but stand-ins for message scripts
          that poke SillyTavern's DOM directly (see StDomCompat). */}
      <StDomCompat />
      {/* Entry funnel: no open session → the World→Session launcher; an open session → play. */}
      {!activeChatId ? (
        <Launcher profileId={activeProfile.id} />
      ) : (
        <>
          <TopNav panel={panel} profileName={activeProfile.name} onSelectPanel={setPanel} />

          {staticLayout ? (
            <StaticWorkspace profileId={activeProfile.id} layout={staticLayout} />
          ) : (
            <Workspace profileId={activeProfile.id} />
          )}

          {/* The invisible card-script engine: runs the active card's scripts (the 创意工坊 workshop +
              background MVU/automation) in a hidden, off-screen WCV — app-wide and independent of the panel
              layout, so the workshop button works in the resizable workspace AND a static panel_ui layout. */}
          {activeCharacter && (
            <CardScriptWcvHost
              key={`${activeCharacter.id}:${activeChatId}`}
              profileId={activeProfile.id}
              chatId={activeChatId}
              cardId={activeCharacter.id}
              cardName={activeCharacter.card.data.name}
            />
          )}

          {/* Standalone-plugin runtime stays mounted app-wide (outside the workspace) so its
              iframes never reparent/reload; the dock is height-bounded by CSS. */}
          <div className="app-plugin-dock">
            <PluginHost profileId={activeProfile.id} />
          </div>

          {settings?.ui?.show_fps && <FpsOverlay />}
          {settings?.ui?.usage_meter?.enabled && <UsageOverlay profileId={activeProfile.id} />}
        </>
      )}

      {/* App-wide overlays — render over BOTH the launcher and play. The control center (Agents &
          Workflows) and the workflow editor coexist; the editor mounts after (paints above) so a
          Studio hand-off from the control center leaves it underneath and returns on close. */}
      <SettingsModal profileId={activeProfile.id} />
      <ControlCenterOverlay profileId={activeProfile.id} />
      <WorkflowEditorOverlay profileId={activeProfile.id} />
      <ToastStack />
    </>
  )
}
