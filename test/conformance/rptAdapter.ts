// RPT assembly adapter seam for the conformance runner.
//
// Deep comparison of RPT's assembled prompt against oracle fixtures lands with the
// Phase-2 wiring issues (11-15), each behind `assemblePrompt`. Until then this
// adapter is intentionally UNWIRED: it returns null, and the runner treats
// null-adapter scenarios as "structural-only" (it validates the fixture and its
// declared invariants, but does not yet diff against RPT output).
//
// It already takes the fixture's machine-readable `input` (FixtureInput) — the
// preset, character card, chat messages, generation type, pre-activated World Info,
// and token budget the oracle fed ST. When wiring lands, replace the body with a
// call into the RPT assembly path over exactly that input, returning the produced
// chat array. The signature stays stable so the runner needs no change.

import type { FixtureInput, FixtureMessage } from './fixtureSchema'

export interface RptAssemblyResult {
  chat: FixtureMessage[]
}

/**
 * Produce RPT's assembled prompt from a fixture's machine-readable input.
 * Returns null while unwired (Phase-2 issues 11-15 wire this in).
 */
export function assembleForFixture(_input: FixtureInput): RptAssemblyResult | null {
  // Not yet wired — see module header. Deliberately null so the harness reports
  // these scenarios as structural-only rather than green-by-accident.
  return null
}
