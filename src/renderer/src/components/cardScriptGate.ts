/**
 * Pure reconciliation of the TWO INDEPENDENT trust grants that feed the isolated card-script realm
 * (ADR 0017 / issue 19). Kept React-free so it can be unit-tested directly.
 *
 * - **Per-preset high-trust** authorizes the PRESET's remote-code scripts. Granting it is a deliberate,
 *   preset-scoped act; those scripts then run whenever their preset is active — regardless of card trust.
 * - **Per-card trust** authorizes the CARD's own scripts (card-embedded + world-scoped).
 *
 * They are separate code sources with separate grants, so a high-trusted preset's scripts must run even
 * on an untrusted card (still inside the isolated WCV realm), while the card's own scripts keep waiting
 * for the card decision. `presetHighTrustScripts` is a strict subset of `scripts` (both resolved for the
 * isolated realm main-side), so the remainder is exactly the card-trust-gated set.
 */
export interface GateScript {
  name: string
  code: string
}

export interface CardScriptGateInput {
  /** The full merged active script set for the isolated realm (card-embedded + active store scopes). */
  scripts: GateScript[]
  /** The subset authorized by the active preset's high-trust grant — runs regardless of card trust. */
  presetHighTrustScripts: GateScript[]
  /** The card itself is trusted to run its (and other card-trust-gated) scripts. */
  cardTrusted: boolean
  /** The user already made an explicit card-trust decision (grant OR deny) — suppresses the prompt. */
  cardDecided: boolean
}

export interface CardScriptGateResult {
  /** What the WCV doc should actually run this turn. */
  runScripts: GateScript[]
  /** Show the card-trust consent prompt (card-trust-gated scripts exist and await a decision). */
  needsConsent: boolean
}

export const resolveCardScriptGate = (input: CardScriptGateInput): CardScriptGateResult => {
  const { scripts, presetHighTrustScripts, cardTrusted, cardDecided } = input
  // presetHighTrustScripts ⊆ scripts, so the difference is the count of card-trust-gated scripts.
  const cardGatedCount = Math.max(0, scripts.length - presetHighTrustScripts.length)
  return {
    // Trusted card → everything runs; untrusted → only the preset-authorized scripts run.
    runScripts: cardTrusted ? scripts : presetHighTrustScripts,
    needsConsent: cardGatedCount > 0 && !cardTrusted && !cardDecided
  }
}
