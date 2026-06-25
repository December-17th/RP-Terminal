import { create } from 'zustand'

/** A regex UI the user PROMOTED to a docked WCV panel (`renderMode:'panel'`), with the page URL it loads.
 *  These become selectable workspace views (id `regex-panel:<file>`) in any panel's view-picker. */
export interface PanelRegex {
  file: string
  scriptName: string
  url: string
}

interface PanelRegexState {
  panels: PanelRegex[]
  /** (Re)load the active card/chat's promoted regex panels. Called on session change + after a promote. */
  load: (
    profileId: string,
    ctx: { cardId?: string | null; chatId?: string | null }
  ) => Promise<void>
}

export const VIEW_PREFIX = 'regex-panel:'

export const usePanelRegexStore = create<PanelRegexState>((set) => ({
  panels: [],
  load: async (profileId, ctx) => {
    try {
      const panels = await window.api.listPanelRegex(profileId, ctx)
      set({ panels: Array.isArray(panels) ? panels : [] })
    } catch {
      set({ panels: [] })
    }
  }
}))
