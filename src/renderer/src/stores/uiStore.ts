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

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
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
  /** Import-time card-script TRUST consent (CardTrustPrompt). When a freshly imported world ships
   *  scripts, this carries the pending decision; the modal records trust/deny into the persisted
   *  grants (+ `decided`) so the run-time hosts never re-prompt. Null = no pending decision. */
  trustPrompt: { profileId: string; cardId: string; cardName: string } | null
  openTrustPrompt: (p: { profileId: string; cardId: string; cardName: string }) => void
  closeTrustPrompt: () => void
}

export const useUiStore = create<UiState>((set) => ({
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
  trustPrompt: null,
  openTrustPrompt: (trustPrompt) => set({ trustPrompt }),
  closeTrustPrompt: () => set({ trustPrompt: null })
}))
