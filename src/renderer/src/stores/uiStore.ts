import { create } from 'zustand'

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  /** The full-screen workflow editor overlay (the canvas needs the whole window, not a panel). */
  workflowEditorOpen: boolean
  openWorkflowEditor: () => void
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
  openWorkflowEditor: () => set({ workflowEditorOpen: true }),
  closeWorkflowEditor: () => set({ workflowEditorOpen: false }),
  launcherWorldId: null,
  setLauncherWorldId: (launcherWorldId) => set({ launcherWorldId })
}))
