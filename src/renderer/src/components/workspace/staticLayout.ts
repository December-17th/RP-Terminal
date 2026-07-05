/**
 * Shapes + pure layout helpers for the card-determined static workspace (`rp_terminal.panel_ui`).
 * Kept free of React / store imports so the decision logic is unit-testable under plain Node and so
 * StaticWorkspace and its tests share one source of truth.
 */

export interface StaticSlot {
  id: string
  view: string
  rect: [number, number, number, number] // [col, row, colSpan, rowSpan]
  entry?: string
  title?: string
  /** Per-slot chrome override; see `slotIsChromed`. */
  chrome?: boolean
}

export interface StaticLayout {
  grid: { cols: number; rows: number }
  slots: StaticSlot[]
  /** Seamless composition: drop inter-slot gap/padding + per-slot chrome so surfaces read as one. */
  seamless?: boolean
}

/**
 * Should this slot render with panel chrome (border, radius, title bar) and be separated by the grid
 * gap? Chromed is the default; a seamless layout flips the default to bare, and a slot's own `chrome`
 * flag overrides the layout default either way. This is the ONE place the seam decision is made so the
 * grid container (gap/padding) and each slot wrapper stay consistent.
 */
export function slotIsChromed(layout: Pick<StaticLayout, 'seamless'>, slot: StaticSlot): boolean {
  return slot.chrome ?? !layout.seamless
}
