import { create } from 'zustand'

/** The control-center rail panes. WP6.4b retired the control center itself; this type is kept only
 *  so the retired-but-present files (controlCenterRail.ts / AgentsView) still compile until WP6.6
 *  deletes them. No runtime machinery references it anymore. */
export type ControlCenterRail =
  | 'overview'
  | 'installed'
  | 'workflows'
  | 'memory'
  | 'runs'
  | 'preview'

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
  settingsOpen: boolean
  openSettings: () => void
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
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
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
  setLauncherWorldId: (launcherWorldId) => set({ launcherWorldId })
}))
