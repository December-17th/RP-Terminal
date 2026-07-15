/**
 * Clamp a card frame's height to a fraction of the viewport so a full-viewport card (min-height:100vh,
 * e.g. the character viewer) becomes a contained, scrollable widget instead of filling the message
 * column and pushing the rest of the message off-screen.
 *
 * Used by BOTH render paths so inline and isolated size cards identically (a parity invariant — see
 * the dual-mode rendering notes):
 *   - InlineCardFrame measures its srcdoc `body.scrollHeight` (+ body margins). For a 100vh card that
 *     value is COUPLED to the iframe's own height (taller iframe -> taller 100vh -> taller scrollHeight),
 *     so an UNCAPPED measure feeds back through the ResizeObserver and the iframe grows without bound.
 *     Clamping breaks the loop: once the height is clamped, the body stops resizing.
 *   - WcvMessageFrame caps the height the card reports over IPC (its native overlay clips anyway).
 *
 * The 280px floor keeps a genuinely short card from being clamped to almost nothing on a tiny window.
 */
export function capCardHeight(contentPx: number, viewportPx: number): number {
  const cap = Math.max(280, Math.round(viewportPx * 0.7))
  return Math.min(contentPx, cap)
}

/**
 * Inline-mode height: size the frame to the card's NATURAL content height so it fits with NO inner
 * scrollbar — the card looks embedded as part of the message rather than windowed.
 *
 * Unlike `capCardHeight` (WCV's windowed widget), this does NOT clamp to a fraction of the viewport.
 * `InlineCardFrame` first neutralizes the card's root viewport-height (html/body 100vh -> auto), which
 * decouples its content height from the frame height, so `contentPx` is the card's true height and is
 * returned as-is. The only clamp is a generous SAFETY ceiling: a bound (never a UX cap) for the rare
 * card that still ties height to the viewport via inner `vh` units — it stops a runaway from growing
 * forever, and realistic card content stays well under it. No lower floor: a short card gets its exact
 * height.
 */
export function fitInlineCardHeight(contentPx: number, viewportPx: number): number {
  const safetyCeiling = Math.max(2000, Math.round(viewportPx * 6))
  return Math.min(contentPx, safetyCeiling)
}
