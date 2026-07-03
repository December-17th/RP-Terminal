import { create } from 'zustand'

/**
 * The chat-input (action box) state, store-owned so any surface can drive it — the Composer edits
 * it, and card scripts reach it through two verbs:
 *  - `injectInput(text)` — replace the box content and focus it (`/setinput`, `/send`, the
 *    onboarding "set the starting prompt" flow). `focusTick` bumps so the Composer focuses the box.
 *  - `requestSubmit()` — "press the send button": `submitTick` bumps and the Composer runs its
 *    normal submit (slash handling, pending-message display, generation) over the CURRENT box
 *    content. This is what `/trigger` maps to — both writes are synchronous store updates, so a
 *    `/setinput x | /trigger` combo submits the just-injected text, and a player's manual edit of
 *    injected text is what actually gets sent.
 */
interface ComposerState {
  /** The action box's current content (single source of truth; the Composer subscribes). */
  text: string
  /** Bumped by injectInput so the Composer focuses the box after an injection. */
  focusTick: number
  /** Bumped by requestSubmit; the Composer consumes it by running its submit(). */
  submitTick: number
  setText: (text: string) => void
  injectInput: (text: string) => void
  requestSubmit: () => void
}

export const useComposerStore = create<ComposerState>((set) => ({
  text: '',
  focusTick: 0,
  submitTick: 0,
  setText: (text) => set({ text }),
  injectInput: (text) => set((s) => ({ text, focusTick: s.focusTick + 1 })),
  requestSubmit: () => set((s) => ({ submitTick: s.submitTick + 1 }))
}))
