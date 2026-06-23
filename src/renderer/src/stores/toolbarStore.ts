import { create } from 'zustand'

/** Shell-toolbar buttons contributed by plugins via `rpt.ui.registerButton` (P3).
 * The button is host-rendered in the top nav; clicking it posts a `button:<id>`
 * event back to the owning plugin's sandboxed frame. */
export interface ToolbarButton {
  key: string
  label: string
  onClick: () => void
}

interface ToolbarState {
  buttons: ToolbarButton[]
  add: (b: ToolbarButton) => void
  remove: (key: string) => void
}

export const useToolbarStore = create<ToolbarState>((set) => ({
  buttons: [],
  add: (b) => set((s) => ({ buttons: [...s.buttons.filter((x) => x.key !== b.key), b] })),
  remove: (key) => set((s) => ({ buttons: s.buttons.filter((x) => x.key !== key) }))
}))
