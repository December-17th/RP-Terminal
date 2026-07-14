import { create } from 'zustand'

/** The Settings popup's sections — the app's single config hub (the retired left-nav tabs +
 *  the world's editable pieces + the workflow entry all live here now). The TopStrip dropdowns
 *  deep-link into one of these via openSettings(section). */
export type SettingsSection =
  | 'app'
  | 'connection'
  | 'worlds'
  | 'preset'
  | 'lorebook'
  | 'persona'
  | 'assets'
  | 'regex'
  | 'scripts'
  | 'workflow'
  | 'memory'
  | 'variables'

/** The ephemeral runtime play-theme override (runtime-theme-api-design §3B). A card's running UI sets it
 *  via setPlayTheme/setMessageTheme; App.tsx layers these tokens OVER the static card theme on `.play-root`.
 *  Two independent slots so a `target:'shell'` reskin and a `target:'message'` restyle coexist (and clear
 *  independently): `shell` is a full derived token map, `message` a `--rpt-msg-*` patch — both already
 *  AA-checked. Session-scoped: held here only (lost on app restart / world switch); the 'chat'/'global'
 *  persist scopes ALSO write the raw override to their stores and re-hydrate this slot on load. */
export interface RuntimeTheme {
  shell: Record<string, string> | null
  message: Record<string, string> | null
}

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
  /** The runtime play-theme override (session scope). Null = no runtime layer (static card / user theme). */
  runtimeTheme: RuntimeTheme | null
  setRuntimeTheme: (theme: RuntimeTheme | null) => void
  /** A card's session-scoped light/dark override (WCV `rptHost.setColorScheme`). Null = follow the app
   *  theme's natural axis. The EFFECTIVE scheme = this ?? colorSchemeOf(app theme); it drives the app
   *  chrome tokens, the WCV `data-rpt-mode`/getColorScheme surface, and the OS window-control overlay
   *  (all in App.tsx). Ephemeral like runtimeTheme: reset on session/profile change (never persisted, so
   *  a card can't permanently change the user's app setting). */
  cardColorScheme: 'light' | 'dark' | null
  setCardColorScheme: (scheme: 'light' | 'dark' | null) => void
  settingsOpen: boolean
  /** Which Settings section to show when the popup opens (set by openSettings). */
  settingsSection: SettingsSection
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  /** The full-screen workflow editor overlay — the single surface for workflows + agents
   *  (one-canvas rebuild WP6.4b). Opened from the title bar, the launcher cards, or a programmatic
   *  hand-off. The retired control center used to sit alongside it; it no longer exists. */
  workflowEditorOpen: boolean
  /** When the editor is opened to EDIT A PACK FRAGMENT (agent-packs plan WP4.4 — "Edit fragment in
   *  Studio"), this carries the pack id. WorkflowEditorView consumes it once on mount: it loads the
   *  pack's fragment as an editable fragment session (full drag / connect / add-node editing, save →
   *  updateAgentPackFragment). Null = a normal editor open. */
  workflowEditorFragmentPackId: string | null
  /** Open the editor overlay; pass `fragmentPackId` to open a pack's fragment as an editable
   *  fragment session (WP4.4). */
  openWorkflowEditor: (opts?: { fragmentPackId?: string | null }) => void
  /** Called by WorkflowEditorView once it has consumed (loaded) the requested fragment pack id. */
  consumeWorkflowEditorFragmentPackId: () => void
  closeWorkflowEditor: () => void
  /** When set, the launcher opens directly to this world's session list (breadcrumb deep-link). */
  launcherWorldId: string | null
  setLauncherWorldId: (id: string | null) => void
  /** The interactive STS duel popup (DuelPopup). Hosted as a centered modal (not a resizable
   *  workspace panel — the pixel-positioned board scrambled when the panel was small). Auto-opened
   *  when a duel becomes active (chat mode → 'duel') and re-openable by button while one is active. */
  duelPopupOpen: boolean
  openDuelPopup: () => void
  closeDuelPopup: () => void
  /** The World Assets manager, hosted as a full-window centered popup (AssetsPopup) — mirrors the
   *  duel popup. It layers above BOTH the reconfigurable Workspace and a card's static panel_ui
   *  layout, so the Settings "Open Assets view" button reaches it even when a card owns the play
   *  area (where docking a workspace panel would surface nothing). */
  assetsPopupOpen: boolean
  openAssetsPopup: () => void
  closeAssetsPopup: () => void
  /** The full-window Memory Manager (MemoryManagerView) — the SQL-table memory feature's rich
   *  full-screen home (Data / Structure / Maintenance tabs over the active chat's tables). Hosted as a
   *  centered full-window popup like the Duel/Assets popups so it layers above BOTH the reconfigurable
   *  Workspace and a card's static panel_ui, and above the workflow editor overlay it's launched from.
   *  Opened from the editor's Memory side sheet; closed by ✕ / Esc / backdrop. */
  memoryManagerOpen: boolean
  openMemoryManager: () => void
  closeMemoryManager: () => void
  /** Import-time card-script TRUST consent (CardTrustPrompt). When a freshly imported world ships
   *  scripts, this carries the pending decision; the modal records trust/deny into the persisted
   *  grants (+ `decided`) so the run-time hosts never re-prompt. Null = no pending decision. */
  trustPrompt: { profileId: string; cardId: string; cardName: string } | null
  openTrustPrompt: (p: { profileId: string; cardId: string; cardName: string }) => void
  closeTrustPrompt: () => void
}

export const useUiStore = create<UiState>((set) => ({
  runtimeTheme: null,
  setRuntimeTheme: (runtimeTheme) => set({ runtimeTheme }),
  cardColorScheme: null,
  setCardColorScheme: (cardColorScheme) => set({ cardColorScheme }),
  settingsOpen: false,
  settingsSection: 'app',
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? 'app' }),
  closeSettings: () => set({ settingsOpen: false }),
  workflowEditorOpen: false,
  workflowEditorFragmentPackId: null,
  openWorkflowEditor: (opts) =>
    set({
      workflowEditorOpen: true,
      workflowEditorFragmentPackId: opts?.fragmentPackId ?? null
    }),
  consumeWorkflowEditorFragmentPackId: () => set({ workflowEditorFragmentPackId: null }),
  closeWorkflowEditor: () =>
    set({
      workflowEditorOpen: false,
      workflowEditorFragmentPackId: null
    }),
  launcherWorldId: null,
  setLauncherWorldId: (launcherWorldId) => set({ launcherWorldId }),
  duelPopupOpen: false,
  openDuelPopup: () => set({ duelPopupOpen: true }),
  closeDuelPopup: () => set({ duelPopupOpen: false }),
  assetsPopupOpen: false,
  openAssetsPopup: () => set({ assetsPopupOpen: true }),
  closeAssetsPopup: () => set({ assetsPopupOpen: false }),
  memoryManagerOpen: false,
  openMemoryManager: () => set({ memoryManagerOpen: true }),
  closeMemoryManager: () => set({ memoryManagerOpen: false }),
  trustPrompt: null,
  openTrustPrompt: (trustPrompt) => set({ trustPrompt }),
  closeTrustPrompt: () => set({ trustPrompt: null })
}))
