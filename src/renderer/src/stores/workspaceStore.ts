import { create } from 'zustand'
import {
  resizeSplit,
  setPanelView,
  togglePanelHidden,
  mergeWithDefault,
  type ModeLayouts,
  type NodePath,
  type WsNode
} from '../../../shared/workspaceLayout'
import { WORKSPACE_MODES, defaultLayoutForMode } from '../../../shared/layoutDefaults'
import { useSettingsStore } from './settingsStore'

/**
 * The reconfigurable panel workspace's state: one split-tree layout per FSM mode, so
 * resizing/rearranging while in `combat` doesn't disturb `explore`. The pure tree ops
 * live in `shared/workspaceLayout`; this store just holds the current layouts, applies
 * an op to the addressed mode, and debounce-persists the whole set into settings (the
 * renderer owns these — main only stores the blob). Mutations take the mode explicitly
 * (the caller passes the live `activeChatMode`) so the store needn't subscribe to chat.
 */

// Debounced settings write — a splitter drag fires many resizes; coalesce them.
let saveTimer: ReturnType<typeof setTimeout> | null = null
const schedulePersist = (profileId: string, layouts: ModeLayouts): void => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void useSettingsStore.getState().updateSettings(profileId, { workspace: { layouts } })
  }, 400)
}

interface WorkspaceState {
  profileId: string | null
  layouts: ModeLayouts
  /** Seed from the profile's saved layouts (merged over the built-in default per mode). */
  load: (profileId: string, saved?: ModeLayouts) => void
  resize: (mode: string, path: NodePath, index: number, deltaPct: number) => void
  setView: (mode: string, key: string, view: string) => void
  toggleHidden: (mode: string, key: string) => void
  resetMode: (mode: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  // Apply a pure tree op to one mode's layout, then persist the new set.
  const apply = (mode: string, makeRoot: (root: WsNode) => WsNode): void => {
    const spec = get().layouts[mode]
    if (!spec) return
    const layouts = { ...get().layouts, [mode]: { root: makeRoot(spec.root) } }
    set({ layouts })
    const { profileId } = get()
    if (profileId) schedulePersist(profileId, layouts)
  }

  return {
    profileId: null,
    layouts: {},

    load: (profileId, saved) => {
      const layouts: ModeLayouts = {}
      for (const mode of WORKSPACE_MODES) {
        layouts[mode] = mergeWithDefault(saved?.[mode], defaultLayoutForMode(mode))
      }
      set({ profileId, layouts })
    },

    resize: (mode, path, index, deltaPct) =>
      apply(mode, (root) => resizeSplit(root, path, index, deltaPct)),
    setView: (mode, key, view) => apply(mode, (root) => setPanelView(root, key, view)),
    toggleHidden: (mode, key) => apply(mode, (root) => togglePanelHidden(root, key)),
    resetMode: (mode) =>
      apply(mode, () => JSON.parse(JSON.stringify(defaultLayoutForMode(mode).root)))
  }
})
