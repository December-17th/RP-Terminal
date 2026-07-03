import { create } from 'zustand'

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
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
  workflowEditorOpen: false,
  workflowEditorInitialMode: null,
  openWorkflowEditor: (opts) =>
    set({ workflowEditorOpen: true, workflowEditorInitialMode: opts?.initialMode ?? null }),
  consumeWorkflowEditorInitialMode: () => set({ workflowEditorInitialMode: null }),
  closeWorkflowEditor: () => set({ workflowEditorOpen: false, workflowEditorInitialMode: null }),
  launcherWorldId: null,
  setLauncherWorldId: (launcherWorldId) => set({ launcherWorldId })
}))
