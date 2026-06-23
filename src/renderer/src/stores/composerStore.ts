import { create } from 'zustand'

/**
 * One-shot chat-input injection: a card UI (e.g. the onboarding creation flow's "set the starting
 * prompt") sets `pendingInput`; the Composer consumes it on the next render, filling the action box
 * for the player to send. Decoupled from the Composer's local state so any surface can inject.
 */
interface ComposerState {
  pendingInput: string | null
  injectInput: (text: string) => void
  consumeInput: () => void
}

export const useComposerStore = create<ComposerState>((set) => ({
  pendingInput: null,
  injectInput: (text) => set({ pendingInput: text }),
  consumeInput: () => set({ pendingInput: null })
}))
