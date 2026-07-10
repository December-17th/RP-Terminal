import { create } from 'zustand'

/**
 * Per-card script-runtime grants, shared between the Scripts manager (left panel — where the
 * toggles live) and the CardScriptHost runtime (right panel — game UI only). Backed by the
 * persisted per-card plugin grants. Keyed by card id.
 * - `enabledByCard`  — master on/off for the card's script runtime (`enabled` grant).
 * - `trustedByCard`  — "this world's scripts may load & run remote code" (`trusted` +
 *   `remoteScripts` grants, set together). Required for a card whose scripts `import` from a CDN.
 */
interface CardScriptsState {
  enabledByCard: Record<string, boolean>
  trustedByCard: Record<string, boolean>
  /**
   * Whether the user made an EXPLICIT trust decision for the card (`decided` grant). Tri-state:
   * a `cardId` missing from the map means "grants not yet resolved" — the trust-gated message
   * router treats that as undecided (fail-closed to WCV). Seeded alongside `trustedByCard`.
   */
  decidedByCard: Record<string, boolean>
  /** Seed from grants already read elsewhere, without another IPC round-trip. */
  seed: (cardId: string, enabled: boolean) => void
  seedTrust: (cardId: string, trusted: boolean) => void
  seedDecided: (cardId: string, decided: boolean) => void
  load: (profileId: string, cardId: string) => Promise<void>
  setEnabled: (profileId: string, cardId: string, enabled: boolean) => Promise<void>
  setTrusted: (profileId: string, cardId: string, trusted: boolean) => Promise<void>
}

export const useCardScriptsStore = create<CardScriptsState>((set) => ({
  enabledByCard: {},
  trustedByCard: {},
  decidedByCard: {},

  seed: (cardId, enabled) =>
    set((s) => ({ enabledByCard: { ...s.enabledByCard, [cardId]: enabled } })),

  seedTrust: (cardId, trusted) =>
    set((s) => ({ trustedByCard: { ...s.trustedByCard, [cardId]: trusted } })),

  seedDecided: (cardId, decided) =>
    set((s) => ({ decidedByCard: { ...s.decidedByCard, [cardId]: decided } })),

  load: async (profileId, cardId) => {
    const g = await window.api.pluginGetGrants(profileId, cardId)
    set((s) => ({
      enabledByCard: { ...s.enabledByCard, [cardId]: g?.enabled !== false },
      trustedByCard: { ...s.trustedByCard, [cardId]: g?.trusted === true },
      decidedByCard: { ...s.decidedByCard, [cardId]: g?.decided === true }
    }))
  },

  setEnabled: async (profileId, cardId, enabled) => {
    await window.api.pluginSetGrants(profileId, cardId, { enabled })
    set((s) => ({ enabledByCard: { ...s.enabledByCard, [cardId]: enabled } }))
  },

  // Grant (or revoke) full trust + remote loading for this world's scripts. Set together so a
  // single toggle reflects "may this world run its remote-loaded scripts".
  setTrusted: async (profileId, cardId, trusted) => {
    await window.api.pluginSetGrants(profileId, cardId, { trusted, remoteScripts: trusted })
    set((s) => ({ trustedByCard: { ...s.trustedByCard, [cardId]: trusted } }))
  }
}))
