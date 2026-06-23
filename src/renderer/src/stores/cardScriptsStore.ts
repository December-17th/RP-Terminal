import { create } from 'zustand'

/**
 * Master on/off for a card's script runtime, shared between the Scripts manager (left
 * panel — where the toggle now lives) and the CardScriptHost runtime (right panel — game
 * UI only). Backed by the per-card `enabled` plugin grant so it persists. Keyed by card id.
 */
interface CardScriptsState {
  enabledByCard: Record<string, boolean>
  /** Seed from grants already read elsewhere, without another IPC round-trip. */
  seed: (cardId: string, enabled: boolean) => void
  load: (profileId: string, cardId: string) => Promise<void>
  setEnabled: (profileId: string, cardId: string, enabled: boolean) => Promise<void>
}

export const useCardScriptsStore = create<CardScriptsState>((set) => ({
  enabledByCard: {},

  seed: (cardId, enabled) =>
    set((s) => ({ enabledByCard: { ...s.enabledByCard, [cardId]: enabled } })),

  load: async (profileId, cardId) => {
    const g = await window.api.pluginGetGrants(profileId, cardId)
    set((s) => ({ enabledByCard: { ...s.enabledByCard, [cardId]: g?.enabled !== false } }))
  },

  setEnabled: async (profileId, cardId, enabled) => {
    await window.api.pluginSetGrants(profileId, cardId, { enabled })
    set((s) => ({ enabledByCard: { ...s.enabledByCard, [cardId]: enabled } }))
  }
}))
