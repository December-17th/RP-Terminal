// test/cardScriptGate.test.ts
//
// Issue 19 / ADR 0017 — the trust-gate reconciliation. Per-preset high-trust and per-card trust are
// SEPARATE grants over separate code sources: a high-trusted preset's scripts run regardless of card
// trust (still in the isolated realm), while the card's OWN scripts keep waiting for the card decision.
// `resolveCardScriptGate` is the pure decision the WCV host renders from.
import { describe, it, expect } from 'vitest'
import { resolveCardScriptGate } from '../src/renderer/src/components/cardScriptGate'

const s = (name: string): { name: string; code: string } => ({ name, code: `/* ${name} */` })
const names = (arr: { name: string }[]): string[] => arr.map((x) => x.name)

describe('resolveCardScriptGate — per-preset high-trust vs per-card trust', () => {
  it('runs a granted high-trust preset’s scripts on an UNTRUSTED card (no consent needed)', () => {
    const preset = [s('remote-loader')]
    const r = resolveCardScriptGate({
      scripts: preset, // the preset scripts are the whole active set here
      presetHighTrustScripts: preset,
      cardTrusted: false,
      cardDecided: false
    })
    expect(names(r.runScripts)).toEqual(['remote-loader'])
    expect(r.needsConsent).toBe(false) // no card-trust-gated scripts → nothing to consent to
  })

  it('still gates the CARD’s own scripts behind card trust, running only the preset ones meanwhile', () => {
    const card = s('card-embedded')
    const preset = s('remote-loader')
    const r = resolveCardScriptGate({
      scripts: [card, preset],
      presetHighTrustScripts: [preset],
      cardTrusted: false,
      cardDecided: false
    })
    expect(names(r.runScripts)).toEqual(['remote-loader']) // preset runs; card script withheld
    expect(r.needsConsent).toBe(true) // the card script still needs the card decision
  })

  it('runs everything once the card is trusted', () => {
    const card = s('card-embedded')
    const preset = s('remote-loader')
    const r = resolveCardScriptGate({
      scripts: [card, preset],
      presetHighTrustScripts: [preset],
      cardTrusted: true,
      cardDecided: true
    })
    expect(names(r.runScripts)).toEqual(['card-embedded', 'remote-loader'])
    expect(r.needsConsent).toBe(false)
  })

  it('a DECLINED card (decided, untrusted) keeps card scripts off silently but still runs preset high-trust', () => {
    const card = s('card-embedded')
    const preset = s('remote-loader')
    const r = resolveCardScriptGate({
      scripts: [card, preset],
      presetHighTrustScripts: [preset],
      cardTrusted: false,
      cardDecided: true
    })
    expect(names(r.runScripts)).toEqual(['remote-loader'])
    expect(r.needsConsent).toBe(false) // decided → no prompt
  })

  it('untrusted card with only card scripts and no high-trust preset → nothing runs, consent required', () => {
    const r = resolveCardScriptGate({
      scripts: [s('card-embedded')],
      presetHighTrustScripts: [],
      cardTrusted: false,
      cardDecided: false
    })
    expect(r.runScripts).toEqual([])
    expect(r.needsConsent).toBe(true)
  })
})
