import { create } from 'zustand'
import type { PanelTab } from '../components/panelTabs'

/**
 * The left-nav tab selection, lifted out of App's local state so both TopNav and the
 * `navigator` workspace view can drive/read it once the left column is a movable panel.
 */
interface NavState {
  panel: PanelTab
  setPanel: (panel: PanelTab) => void
}

export const useNavStore = create<NavState>((set) => ({
  panel: 'world',
  setPanel: (panel) => set({ panel })
}))
