import { create } from 'zustand'

/** The control-center rail panes. 'workflows' hosts the relocated Workflows management surface;
 *  the Agents panes keep their own inner rail ids. A Memory pane (WP3.8) slots in here later —
 *  the rail list lives in components/workspace/controlCenterRail.ts (extensible seam). */
export type ControlCenterRail = 'overview' | 'installed' | 'workflows' | 'runs' | 'preview'

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  /** The full-window Agents & Workflows control-center overlay (owner directive WP3.7: the Agents
   *  view + the Workflows management surface no longer live in workspace panels — too much going on
   *  for a panel). App-level overlay like the workflow editor; opened from the title bar or a
   *  programmatic hand-off. */
  controlCenterOpen: boolean
  /** Which rail pane to open on. A hand-off (a launcher card, a quick link) can deep-link a pane;
   *  consumed once on open, then the overlay owns its own rail state. Null = the default (Overview). */
  controlCenterRail: ControlCenterRail | null
  /** Open the control center; pass `rail` to deep-link a specific pane (e.g. the Workflows launcher
   *  opens straight to 'workflows'). */
  openControlCenter: (opts?: { rail?: ControlCenterRail }) => void
  /** Called by the overlay once it has consumed the requested initial rail. */
  consumeControlCenterRail: () => void
  closeControlCenter: () => void
  /** The full-screen workflow editor overlay (the canvas needs the whole window, not a panel). */
  workflowEditorOpen: boolean
  /** When the editor is opened from the Agents "Open in Workflow Studio" hand-off (agent-packs plan
   *  WP3.2), this requests it start in Effective mode (the live composition for the active chat, where
   *  pack nodes are visible + editing forks). Consumed once by WorkflowEditorView, then cleared. Null =
   *  the normal open (Normal mode). */
  workflowEditorInitialMode: 'effective' | null
  /** Open the editor overlay; pass `initialMode:'effective'` for the Agents hand-off. */
  openWorkflowEditor: (opts?: { initialMode?: 'effective' | null }) => void
  /** Called by WorkflowEditorView once it has consumed the requested initial mode. */
  consumeWorkflowEditorInitialMode: () => void
  closeWorkflowEditor: () => void
  /** When set, the launcher opens directly to this world's session list (breadcrumb deep-link). */
  launcherWorldId: string | null
  setLauncherWorldId: (id: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  controlCenterOpen: false,
  controlCenterRail: null,
  openControlCenter: (opts) =>
    set({ controlCenterOpen: true, controlCenterRail: opts?.rail ?? null }),
  consumeControlCenterRail: () => set({ controlCenterRail: null }),
  closeControlCenter: () => set({ controlCenterOpen: false, controlCenterRail: null }),
  workflowEditorOpen: false,
  workflowEditorInitialMode: null,
  openWorkflowEditor: (opts) =>
    set({ workflowEditorOpen: true, workflowEditorInitialMode: opts?.initialMode ?? null }),
  consumeWorkflowEditorInitialMode: () => set({ workflowEditorInitialMode: null }),
  closeWorkflowEditor: () => set({ workflowEditorOpen: false, workflowEditorInitialMode: null }),
  launcherWorldId: null,
  setLauncherWorldId: (launcherWorldId) => set({ launcherWorldId })
}))
