import { create } from 'zustand'

/**
 * Freeze-frame bitmaps for ducked WCVs (PM-A4). While a full-viewport DOM overlay (a TopStrip
 * dropdown, the workflow editor) is open, the native card panels are HIDDEN so the overlay can paint
 * above them — but a plain hide leaves a blank hole. Main captures each visible panel and pushes a
 * per-slot bitmap (data URL) here; the matching `WcvPanel` paints it into its DOM placeholder (which
 * sits behind the now-hidden native view), so the panels stay visually in place. Cleared on restore.
 *
 * Keyed by the SAME slot id the WcvPanel reports to main (`static:<id>`, `card-scripts:…`), so a
 * panel reads its own frame with `frames[slotId]`. Card-agnostic — a bitmap has no card knowledge.
 */
interface WcvFreezeState {
  frames: Record<string, string>
  showFreeze: (frames: Record<string, string>) => void
  clearFreeze: () => void
}

export const useWcvFreezeStore = create<WcvFreezeState>((set) => ({
  frames: {},
  showFreeze: (frames) => set({ frames }),
  clearFreeze: () => set({ frames: {} })
}))
