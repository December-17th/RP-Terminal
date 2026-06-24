import { create } from 'zustand'

/** Transient app-shell UI state (not persisted): the Settings popup, etc. */
interface UiState {
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  /** When set, the launcher opens directly to this world's session list (breadcrumb deep-link). */
  launcherWorldId: string | null
  setLauncherWorldId: (id: string | null) => void
  /** The per-world settings popup (regex + scripts for the active world). */
  worldSettingsOpen: boolean
  openWorldSettings: () => void
  closeWorldSettings: () => void
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  launcherWorldId: null,
  setLauncherWorldId: (launcherWorldId) => set({ launcherWorldId }),
  worldSettingsOpen: false,
  openWorldSettings: () => set({ worldSettingsOpen: true }),
  closeWorldSettings: () => set({ worldSettingsOpen: false })
}))
