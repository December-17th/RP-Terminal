import { describe, it, expect } from 'vitest'
import { capCardHeight, fitInlineCardHeight } from '../src/renderer/src/components/cardFrameHeight'

describe('capCardHeight', () => {
  it('returns the content height when it fits under the cap', () => {
    // cap = max(280, round(1000 * 0.7)) = 700; 200 < 700.
    expect(capCardHeight(200, 1000)).toBe(200)
  })

  it('clamps a full-viewport card to 70% of the viewport (breaks the inline feedback loop)', () => {
    expect(capCardHeight(5000, 1000)).toBe(700)
  })

  it('clamps an already-at-viewport height so a 100vh card cannot ratchet upward', () => {
    // The runaway case: scrollHeight ~= the iframe's own height. The cap must return < input.
    expect(capCardHeight(1000, 1000)).toBe(700)
  })

  it('never clamps below the 280px floor on a tiny viewport', () => {
    // 0.7 * 300 = 210 < 280, so the floor wins.
    expect(capCardHeight(5000, 300)).toBe(280)
  })

  it('returns a short card unchanged even on a tiny viewport', () => {
    expect(capCardHeight(120, 300)).toBe(120)
  })

  it('rounds the viewport fraction', () => {
    // 0.7 * 1001 = 700.7 -> 701
    expect(capCardHeight(5000, 1001)).toBe(701)
  })
})

describe('fitInlineCardHeight', () => {
  it('returns the natural content height unchanged (fits inline, no scrollbar)', () => {
    // ceiling = max(2000, 6000) = 6000; 1500 is well under it.
    expect(fitInlineCardHeight(1500, 1000)).toBe(1500)
  })

  it('returns a short card at its exact height — no lower floor', () => {
    expect(fitInlineCardHeight(80, 1000)).toBe(80)
  })

  it('bounds a runaway at the generous safety ceiling (6x viewport)', () => {
    expect(fitInlineCardHeight(100000, 1000)).toBe(6000)
  })

  it('keeps a minimum 2000px safety ceiling on a tiny viewport', () => {
    // 6 * 100 = 600 < 2000, so the 2000 floor on the ceiling wins.
    expect(fitInlineCardHeight(100000, 100)).toBe(2000)
  })

  it('is more permissive than the WCV cap (inline embeds, WCV windows)', () => {
    expect(fitInlineCardHeight(1500, 1000)).toBeGreaterThan(capCardHeight(1500, 1000))
  })
})
