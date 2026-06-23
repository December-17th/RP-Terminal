/**
 * Pure swipe (alternate-response) helpers for the floor model (TH-2). Kept apart from
 * floorService (which touches SQLite) so the index math is unit-testable in isolation.
 *
 * Invariant: a floor's active response (`response.content`) always equals
 * `swipes[swipe_id]`. A floor with no stored swipes is treated as a single swipe whose
 * sole entry is its current response (legacy floors round-trip unchanged).
 */

export interface SwipeState {
  swipes: string[]
  swipe_id: number
}

/** Normalize a (possibly absent) swipe array + active index to a clamped, non-empty pair. */
export const normalizeSwipes = (
  swipes: string[] | null | undefined,
  responseContent: string,
  swipeId: number | null | undefined
): SwipeState => {
  const arr = Array.isArray(swipes) && swipes.length > 0 ? swipes.slice() : [responseContent]
  let id = typeof swipeId === 'number' ? swipeId : 0
  if (id < 0) id = 0
  if (id >= arr.length) id = arr.length - 1
  return { swipes: arr, swipe_id: id }
}

/** Switch the active swipe to a clamped index; returns the new state + active content. */
export const selectSwipe = (
  state: SwipeState,
  swipeId: number
): { swipe_id: number; content: string } => {
  const id = Math.max(0, Math.min(swipeId, state.swipes.length - 1))
  return { swipe_id: id, content: state.swipes[id] }
}

/** Append a new alternate response and make it active. */
export const appendSwipe = (state: SwipeState, content: string): SwipeState => {
  const swipes = [...state.swipes, content]
  return { swipes, swipe_id: swipes.length - 1 }
}
