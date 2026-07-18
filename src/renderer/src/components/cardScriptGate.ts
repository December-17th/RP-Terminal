import type { RuntimeScript } from '../../../shared/scriptTypes'

/**
 * Pure reconciliation of the independent source authorizations that feed the isolated card-script
 * realm (ADR 0017). Kept React-free so it can be unit-tested directly.
 *
 * Ordinary installed/imported scripts are authorized by that install/import. Remote-code preset
 * scripts are authorized only by the preset's high-trust grant. Card-embedded and world-owned scripts
 * alone inherit the active card's trust decision.
 */
export type GateScript = RuntimeScript

export interface CardScriptGateInput {
  /** The full merged active script set, with main-process source authorization attached. */
  scripts: GateScript[]
  cardTrusted: boolean
  /** The user already made an explicit card-trust decision (grant or deny). */
  cardDecided: boolean
}

export interface CardScriptGateResult {
  runScripts: GateScript[]
  /** Show the card-trust consent prompt only when card-owned code awaits a decision. */
  needsConsent: boolean
}

export const resolveCardScriptGate = (input: CardScriptGateInput): CardScriptGateResult => {
  const { scripts, cardTrusted, cardDecided } = input
  const cardGatedScripts = scripts.filter((s) => s.authorization === 'card-trust')
  return {
    runScripts: cardTrusted ? scripts : scripts.filter((s) => s.authorization !== 'card-trust'),
    needsConsent: cardGatedScripts.length > 0 && !cardTrusted && !cardDecided
  }
}
