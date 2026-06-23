import { describe, it, expect } from 'vitest'
import { costFor, cacheHitPct } from '../src/shared/usageCost'

describe('cacheHitPct', () => {
  it('is cacheRead over total input (read+write+fresh)', () => {
    expect(cacheHitPct({ cacheRead: 90, cacheWrite: 0, input: 10, output: 5 })).toBeCloseTo(90, 5)
  })
  it('is 0 when there is no input', () => {
    expect(cacheHitPct({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 })).toBe(0)
  })
})

describe('costFor', () => {
  const rates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
  it('weights each token class by its per-million rate', () => {
    const c = costFor({ cacheRead: 1_000_000, cacheWrite: 0, input: 0, output: 0 }, rates)
    expect(c).toBeCloseTo(0.5, 6)
    const c2 = costFor({ cacheRead: 0, cacheWrite: 0, input: 1_000_000, output: 1_000_000 }, rates)
    expect(c2).toBeCloseTo(30, 6)
  })
  it('returns null when usage or rates are missing', () => {
    expect(costFor(null, rates)).toBeNull()
    expect(costFor({ cacheRead: 1, cacheWrite: 0, input: 0, output: 0 }, undefined)).toBeNull()
  })
})
