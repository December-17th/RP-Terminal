import { useEffect, useMemo, Suspense } from 'react'
import { lazyNamed } from './lib/lazyNamed'
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
import { TopStrip } from './components/TopStrip'
import { Workspace } from './components/workspace/Workspace'
import { StaticWorkspace } from './components/workspace/StaticWorkspace'
import { OverlayHost } from './components/workspace/OverlayHost'
import { YuzuCardSurface } from './components/yuzu/YuzuCardSurface'
import { CardScriptWcvHost } from './components/CardScriptWcvHost'
import { PluginHost } from './components/PluginHost'
import { useAgentActivityStore } from './stores/agentActivityStore'
import { useAgentRunStore } from './stores/agentRunStore'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useComposerStore } from './stores/composerStore'
import { useWcvFreezeStore } from './stores/wcvFreezeStore'
import { initSlash } from './plugin/slash'
import { initCardEventBridge } from './cardBridge/hostBroadcast'
import { applyThemeForScheme, colorSchemeOf } from './theme'
import { deriveCardTheme } from './cardTheme'
import { useUiStore } from './stores/uiStore'
import {
  applyRuntimeTheme,
  getEffectivePlayTheme,
  mergeRuntimeTokens,
  hydratePlayTheme
} from './cardBridge/playTheme'
import { useI18nStore } from './i18n'
import { Launcher } from './components/Launcher'
import { StDomCompat } from './components/StDomCompat'
// Modal/overlay surfaces are code-split: each renders null until opened, so lazy-loading them keeps
// their heavy trees (workflow canvas, duel board, memory grid, settings hub) out of the startup entry
// chunk. CRUCIAL: the dynamic import fires when React first RENDERS the lazy element, NOT when the
// component checks its own open-state — so each is gated with `{open && <Lazy… />}` below (its open flag
// hoisted into App via a narrow selector). Rendering them unconditionally would request every chunk at
// startup. Suspense fallback is null — nothing is visible until the user opens the surface anyway.
const SettingsModal = lazyNamed(() => import('./components/SettingsModal'), 'SettingsModal')
const DuelPopup = lazyNamed(() => import('./components/DuelPopup'), 'DuelPopup')
const AssetsPopup = lazyNamed(() => import('./components/AssetsPopup'), 'AssetsPopup')
const AgentWorkspace = lazyNamed(
  () => import('./components/agents/AgentWorkspace'),
  'AgentWorkspace'
)
const MemoryManagerView = lazyNamed(
  () => import('./components/memory/MemoryManagerView'),
  'MemoryManagerView'
)
const TableTemplateReminderModal = lazyNamed(
  () => import('./components/TableTemplateReminderModal'),
  'TableTemplateReminderModal'
)
import { CardTrustPrompt } from './components/CardTrustPrompt'
import { CharacterAgentRenameModal } from './components/CharacterAgentRenameModal'
import { refreshWcvHostState } from './cardBridge/hostReload'

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
  const presetRuntimeRevision = usePresetStore((s) => s.runtimeRevision)
  // The runtime play-theme override (session slot) — layered over the static card theme on `.play-root`.
  const runtimeTheme = useUiStore((s) => s.runtimeTheme)
  // A card's session-scoped light/dark override (WCV rptHost.setColorScheme); null = follow the app theme.
  const cardColorScheme = useUiStore((s) => s.cardColorScheme)

  // Open-state for the app-wide lazy overlays, hoisted here so each dynamic import fires only when its
  // surface first opens (see the lazyNamed block above) — NOT eagerly at startup. Each overlay keeps its
  // own null-when-closed guard too (harmless double-guard). DuelPopup is special: its auto-open logic
  // (mode → 'duel' opens the popup) lives INSIDE the component's effect, so it must be mounted whenever
  // the chat is in duel mode OR the popup is already open, else it could never observe the transition.
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const duelPopupOpen = useUiStore((s) => s.duelPopupOpen)
  const assetsPopupOpen = useUiStore((s) => s.assetsPopupOpen)
  const agentWorkspaceOpen = useUiStore((s) => s.agentWorkspaceOpen)
  const memoryManagerOpen = useUiStore((s) => s.memoryManagerOpen)
  const activeChatMode = useChatStore((s) => s.activeChatMode)
  const templateReminderOpen = useChatStore((s) => s.templateReminderOpen)

  useEffect(() => {
    loadProfiles()
    initSlash() // register built-in slash commands once
    // Live streaming text for the active chat's in-flight response.
    const unsubDelta = window.api.onGenerationDelta(({ chatId, delta }) => {
      // Card UIs get STREAM_TOKEN_RECEIVED from initCardEventBridge on the rAF buffer flush
      // (≤1 event/frame), not per raw delta — see hostBroadcast.
      if (chatId === useChatStore.getState().activeChatId) {
        useChatStore.getState().appendDelta(delta)
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
    // Card-side chat and regex writes share this signal; refresh both renderer caches.
    const unsubReload = window.api.onWcvHostReload(({ chatId }) => {
      void refreshWcvHostState(chatId)
    })
    // A WCV card called setPlayTheme (runtime-theme-api-design §5): the renderer is the theme authority,
    // so main relayed it here. Apply against the active session, then reply with the derive/AA verdict so
    // the card's invoke resolves. Scoped to the active chat (a card themes only its own play session).
    const unsubSetPlayTheme = window.api.onWcvSetPlayTheme(({ id, chatId, theme, opts }) => {
      const st = useChatStore.getState()
      const pid = useProfileStore.getState().activeProfile?.id
      let ok = false
      if (pid && chatId === st.activeChatId) {
        ok = applyRuntimeTheme(
          theme as Record<string, unknown> | null,
          opts as { target?: 'shell' | 'message'; persist?: 'session' | 'chat' | 'global' },
          {
            profileId: pid,
            chatId,
            characterId: useCharacterStore.getState().activeCharacter?.id ?? ''
          }
        )
      }
      window.api.wcvSetPlayThemeReply(id, ok)
    })
    // A WCV card called rptHost.setColorScheme (the app→card getColorScheme mirror, card→app direction):
    // main relayed it here. Set the session-scoped override for the ACTIVE session ('auto'/null reverts to
    // the app theme). The effective-scheme effect then repaints the chrome + re-pushes the effective axis
    // back to every WCV surface (data-rpt-mode / getColorScheme), keeping app→card reporting the effective.
    const unsubSetColorScheme = window.api.onWcvSetColorScheme(({ chatId, scheme }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useUiStore
          .getState()
          .setCardColorScheme(scheme === 'light' || scheme === 'dark' ? scheme : null)
      }
    })
    // Freeze-frame bitmaps while WCVs are ducked under a DOM overlay (PM-A4). Main pushes a per-slot
    // capture to paint behind the hidden native panels; each WcvPanel reads its own frame.
    const unsubFreeze = window.api.onWcvFreeze((p) => {
      if ('clear' in p) useWcvFreezeStore.getState().clearFreeze()
      else useWcvFreezeStore.getState().showFreeze(p.show)
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
    // Agent Runtime activity is keyed by Invocation ID, so overlapping calls in one chat remain
    // independently visible and stoppable. Notification policy never gates this activity edge. (M5c-2:
    // the legacy `workflow-activity`/`workflow-trace`/`workflow-panel` feeds were removed with the
    // workflow system — this agent-run feed is now the sole activity source ChatView reads.)
    const unsubAgentRuns = window.api.onAgentRunEvent((event) => {
      useAgentRunStore.getState().apply(event)
      if (event.type === 'started') {
        useAgentActivityStore
          .getState()
          .start(event.run.chatId, event.run.invocationId, event.run.agentName, 'post')
      } else if (event.type === 'deleted') {
        useAgentActivityStore.getState().end(event.chatId, event.invocationId)
      } else if (event.run.status !== 'running') {
        useAgentActivityStore.getState().end(event.run.chatId, event.run.invocationId)
      }
    })
    // A combat/duel service switched the chat's mode main-side → the workspace must follow without a
    // user click.
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
      unsubSetPlayTheme()
      unsubSetColorScheme()
      unsubFreeze()
      unsubFloors()
      unsubEvents()
      unsubAgentRuns()
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

  // The single EFFECTIVE light/dark axis for the whole shell: a card's session-scoped override
  // (rptHost.setColorScheme) if set, else the app theme's natural axis. It drives, uniformly:
  //  (1) the FULL app token set on <html> — including `--rpt-text-primary`, so generated/story text follows
  //      the axis (not just the chrome), plus the `--rpt-app-*` chrome tokens and the OS overlay, and
  //  (2) the WCV surface sync (setColorSchemeCache → main → `data-rpt-mode` / getColorScheme).
  // So the card's mode toggle and the app theme picker share ONE axis: each flips the app chrome, the app
  // body text, the card surfaces, and the native buttons together. (Runs on first settings load too.)
  const effectiveScheme = cardColorScheme ?? colorSchemeOf(settings?.ui?.theme)
  useEffect(() => {
    applyThemeForScheme(settings?.ui?.theme, effectiveScheme)
    try {
      // Push the EFFECTIVE axis (not the raw app theme) so WCV card surfaces follow it too.
      window.api.setColorSchemeCache(effectiveScheme)
    } catch {
      /* no api (test/SSR) */
    }
  }, [settings?.ui?.theme, effectiveScheme])

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

  // Hydrate persisted recent activity whenever a chat opens. Running rows are also projected into
  // the existing always-visible chat indicator, covering renderer reloads without discarding the
  // legacy workflow activity source during the cutover.
  useEffect(() => {
    const profileId = activeProfile?.id
    if (!profileId || !activeChatId) return
    let disposed = false
    const generation = useAgentRunStore.getState().beginHydrate(activeChatId)
    void window.api
      .listAgentRuns(profileId, activeChatId)
      .then((records) => {
        if (disposed) return
        if (!useAgentRunStore.getState().hydrate(activeChatId, records, generation)) return
        for (const run of Object.values(useAgentRunStore.getState().byChat[activeChatId] ?? {})) {
          if (run.status === 'running') {
            useAgentActivityStore
              .getState()
              .start(run.chatId, run.invocationId, run.agentName, 'post')
          }
        }
      })
      .catch(() => {
        if (!disposed) useAgentRunStore.getState().failHydrate(activeChatId, generation)
      })
    return () => {
      disposed = true
    }
  }, [activeProfile?.id, activeChatId])

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

  // Card-bundled theme (docs/ui-rehaul-design.md §6a): the active world may reskin PLAY MODE to its
  // own palette. We derive the effective token set (deriving readable text/on-* + enforcing AA), and
  // apply it to the play wrapper only — the launcher and settings stay on the user's theme. Gated by
  // settings.ui.allow_card_themes (default on); a failing/absent card theme yields null → user theme.
  const cardThemeRaw = activeCharacter?.card?.data?.extensions?.rp_terminal?.theme as
    | Record<string, unknown>
    | undefined
  const allowCardThemes =
    (settings?.ui as { allow_card_themes?: boolean } | undefined)?.allow_card_themes !== false
  const playTokens = useMemo(
    () => (allowCardThemes ? deriveCardTheme(cardThemeRaw, settings?.ui?.theme) : null),
    [allowCardThemes, cardThemeRaw, settings?.ui?.theme]
  )
  // Compose the runtime override (runtime-theme-api-design §3B) OVER the static card theme, then apply
  // the result on `.play-root`. The runtime layer is a session-scoped override a card set at runtime;
  // when it's null this is exactly `playTokens` (every existing card unchanged).
  const effectivePlayTokens = useMemo(
    () => mergeRuntimeTokens(playTokens, runtimeTheme),
    [playTokens, runtimeTheme]
  )

  // Push the resolved effective play theme to main so a WCV card's getPlayTheme() can read it
  // synchronously (main can't derive it — the base tokens live here). Re-run on any theme input change.
  useEffect(() => {
    try {
      window.api.setPlayThemeCache(getEffectivePlayTheme())
    } catch {
      /* no api (test/SSR) */
    }
  }, [effectivePlayTokens, allowCardThemes, cardThemeRaw, settings?.ui?.theme])

  // Re-hydrate the runtime override from the persisted stores on session/profile change (and clear the
  // ephemeral session slot so a runtime theme never leaks across chats). The card's light/dark override is
  // likewise ephemeral (never persisted), so reset it here — a card must not carry its scheme flip across
  // sessions or permanently change the user's app setting. Best-effort; session-scoped overrides reset here.
  useEffect(() => {
    if (activeProfile?.id) hydratePlayTheme(activeProfile.id, activeChatId ?? '')
    useUiStore.getState().setCardColorScheme(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, activeChatId])

  if (!activeProfile) return <ProfilePicker />

  // An RPT-native card can declare its own static, card-determined layout (rp_terminal.panel_ui); else the
  // resizable workspace. (ST-compat cards' UIs are inline regex by default, promotable to panels by the user.)
  const cardExt = activeCharacter?.card?.data?.extensions?.rp_terminal
  const cardPanelUi = cardExt?.panel_ui
  const staticLayout =
    cardPanelUi?.mode === 'static' && cardPanelUi.slots?.length ? cardPanelUi : null
  const yuzuSurface = cardExt?.yuzu?.surface

  return (
    <>
      {/* ST DOM-compat shim: hidden #send_textarea / #send_but stand-ins for message scripts
          that poke SillyTavern's DOM directly (see StDomCompat). */}
      <StDomCompat />
      {/* Entry funnel: no open session → the World→Session launcher; an open session → play. */}
      {!activeChatId ? (
        <Launcher profileId={activeProfile.id} />
      ) : (
        <div
          className="play-root"
          style={
            effectivePlayTokens
              ? (effectivePlayTokens as unknown as React.CSSProperties)
              : undefined
          }
        >
          <TopStrip profileId={activeProfile.id} profileName={activeProfile.name} />

          {/* Positioned wrapper so the full-play-area overlay host (PM-A7) can cover exactly the
              workspace region (below the TopStrip) — its inset:0 rect drives the overlay WCV bounds. */}
          <div
            className="ws-overlay-root"
            style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}
          >
            {yuzuSurface?.entry && activeChatId ? (
              <YuzuCardSurface
                profileId={activeProfile.id}
                chatId={activeChatId}
                entry={yuzuSurface.entry}
                enableVnMode={yuzuSurface.enable_vn_mode === true}
              />
            ) : staticLayout ? (
              <StaticWorkspace profileId={activeProfile.id} layout={staticLayout} />
            ) : (
              <Workspace profileId={activeProfile.id} />
            )}
            <OverlayHost />
          </div>

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
              activePresetId={activePresetId}
              presetRuntimeRevision={presetRuntimeRevision}
            />
          )}

          {/* Standalone-plugin runtime stays mounted app-wide (outside the workspace) so its
              iframes never reparent/reload; the dock is height-bounded by CSS. */}
          <div className="app-plugin-dock">
            <PluginHost profileId={activeProfile.id} />
          </div>

          {settings?.ui?.show_fps && <FpsOverlay />}
          {settings?.ui?.usage_meter?.enabled && <UsageOverlay profileId={activeProfile.id} />}
        </div>
      )}

      {/* App-wide overlays — render over BOTH the launcher and play. The workflow editor is now the
          single surface for workflows + agents (one-canvas rebuild WP6.4b); the control center is
          retired. */}
      <Suspense fallback={null}>
        {settingsOpen && <SettingsModal profileId={activeProfile.id} />}
        {(duelPopupOpen || activeChatMode === 'duel') && <DuelPopup profileId={activeProfile.id} />}
        {assetsPopupOpen && <AssetsPopup profileId={activeProfile.id} />}
        {agentWorkspaceOpen && <AgentWorkspace profileId={activeProfile.id} />}
        {memoryManagerOpen && <MemoryManagerView profileId={activeProfile.id} />}
        {templateReminderOpen && <TableTemplateReminderModal profileId={activeProfile.id} />}
      </Suspense>
      <CardTrustPrompt />
      <CharacterAgentRenameModal />
      <ToastStack />
    </>
  )
}
