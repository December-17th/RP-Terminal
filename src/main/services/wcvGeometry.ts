/**
 * Pure geometry contract handed to a card's WCV page so it can align a full-viewport background to its
 * own slot (the seam-slicing primitive: each stage surface draws the SAME background offset by its own
 * `x`, so the slices line up into one image). Kept dependency-free so it's unit-testable under Node and
 * so the WCV page and the host agree on one shape. See docs/design/poem-play-area-redesign.md §4.4.
 */

export interface PanelGeometry {
  /** The panel's rect in window-content coords (same origin as the renderer's getBoundingClientRect). */
  x: number
  y: number
  width: number
  height: number
  /** The window content size — the full stage width the background is drawn across. */
  viewportWidth: number
  viewportHeight: number
}

/** Compose a page's geometry from its native view bounds + the window content size. */
export function makePanelGeometry(
  bounds: { x: number; y: number; width: number; height: number },
  contentSize: [number, number]
): PanelGeometry {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    viewportWidth: contentSize[0],
    viewportHeight: contentSize[1]
  }
}
