// Regex placement × phase-flag CONFORMANCE GRID (WP-2.4 / issue 14 / ADR 0016).
//
// SYNTHESIZED FROM SOURCE: the expected column is computed from SillyTavern's own per-call test
// (public/scripts/extensions/regex/engine.js:348-374 getRegexedString) — a script fires iff its
// phase flags admit the call AND `script.placement.includes(placement)`. This is the frozen spec
// for every placement (1/2/3/5/6) crossed with every phase-flag combo (incl. both-false), asserted
// against RPT's `scriptRunsInPhase`. No ST prose is reproduced (clean-room; only the boolean law).

import { describe, it, expect } from 'vitest'
import { scriptRunsInPhase, REGEX_PLACEMENT } from '../../src/shared/regexTypes'

// The ST call sites that regex each placement (grounded in the ST source), with the exact flags each
// passes to getRegexedString. RPT reproduces these by folding the commit call into display/prompt for
// COMMITTED content, and applying the strict call for non-committed content (WI/slash).
//
//  placement 1 USER_INPUT   : commit(neither) script.js:5816 ; display{isMarkdown} 1809 ; prompt{isPrompt} 4447
//  placement 2 AI_OUTPUT    : commit(neither) script.js:6422 ; display{isMarkdown} 1809 ; prompt{isPrompt} 4447
//  placement 3 SLASH_COMMAND: neither ONLY (slash-commands.js:4715/5716/5943/6086)
//  placement 5 WORLD_INFO   : prompt ONLY {isMarkdown:false,isPrompt:true} (world-info.js:5086)
//  placement 6 REASONING    : commit(neither) reasoning.js:409 ; display ; prompt{isPrompt} script.js:4486
type Phase = { isMarkdown?: boolean; isPrompt?: boolean }
type FlagCombo = { markdownOnly: boolean; promptOnly: boolean }

const combos: Array<FlagCombo & { label: string }> = [
  { label: 'both-false', markdownOnly: false, promptOnly: false },
  { label: 'display-only', markdownOnly: true, promptOnly: false },
  { label: 'prompt-only', markdownOnly: false, promptOnly: true },
  { label: 'both-true', markdownOnly: true, promptOnly: true }
]

// ST's literal law (engine.js:348-355), used as the independent oracle.
const stFires = (r: FlagCombo, p: Phase): boolean =>
  (r.markdownOnly && !!p.isMarkdown) ||
  (r.promptOnly && !!p.isPrompt) ||
  (!r.markdownOnly && !r.promptOnly && !p.isMarkdown && !p.isPrompt)

// The distinct ST calls per placement (what flags fire where content is regexed for that placement).
const callsByPlacement: Record<number, Array<{ name: string; phase: Phase }>> = {
  [REGEX_PLACEMENT.USER_INPUT]: [
    { name: 'commit', phase: {} },
    { name: 'display', phase: { isMarkdown: true } },
    { name: 'prompt', phase: { isPrompt: true } }
  ],
  [REGEX_PLACEMENT.AI_OUTPUT]: [
    { name: 'commit', phase: {} },
    { name: 'display', phase: { isMarkdown: true } },
    { name: 'prompt', phase: { isPrompt: true } }
  ],
  [REGEX_PLACEMENT.SLASH_COMMAND]: [{ name: 'neither', phase: {} }],
  [REGEX_PLACEMENT.WORLD_INFO]: [{ name: 'prompt', phase: { isMarkdown: false, isPrompt: true } }],
  [REGEX_PLACEMENT.REASONING]: [
    { name: 'commit', phase: {} },
    { name: 'display', phase: { isMarkdown: true } },
    { name: 'prompt', phase: { isPrompt: true } }
  ]
}

describe('regex placement × phase-flag conformance grid (engine.js:348-374)', () => {
  for (const placement of Object.keys(callsByPlacement).map(Number)) {
    for (const combo of combos) {
      for (const call of callsByPlacement[placement]) {
        it(`placement ${placement} · ${combo.label} · ${call.name} call → RPT matches ST`, () => {
          expect(scriptRunsInPhase(combo, call.phase)).toBe(stFires(combo, call.phase))
        })
      }
    }
  }

  // Explicit callouts of the behaviors the corpus depends on (spelled out, not just derived):
  it('WORLD_INFO(5): a both-false rule NEVER fires (only prompt-only / both-true) — the divergence fix', () => {
    const p = { isMarkdown: false, isPrompt: true }
    expect(scriptRunsInPhase({ markdownOnly: false, promptOnly: false }, p)).toBe(false)
    expect(scriptRunsInPhase({ markdownOnly: false, promptOnly: true }, p)).toBe(true)
    expect(scriptRunsInPhase({ markdownOnly: true, promptOnly: true }, p)).toBe(true)
  })

  it('SLASH_COMMAND(3): only a both-false rule fires (the neither call)', () => {
    expect(scriptRunsInPhase({ markdownOnly: false, promptOnly: false }, {})).toBe(true)
    expect(scriptRunsInPhase({ markdownOnly: false, promptOnly: true }, {})).toBe(false)
    expect(scriptRunsInPhase({ markdownOnly: true, promptOnly: false }, {})).toBe(false)
  })

  it('USER_INPUT/AI_OUTPUT(1/2): a both-false rule fires on the COMMIT call (folded into display+prompt)', () => {
    expect(scriptRunsInPhase({ markdownOnly: false, promptOnly: false }, {})).toBe(true)
  })
})
