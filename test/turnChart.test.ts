import { describe, it, expect } from 'vitest'
import { linePath } from '../src/renderer/src/components/TurnChart'

describe('linePath', () => {
  it('maps values to an SVG polyline path scaled to width/height', () => {
    const p = linePath([0, 50, 100], 100, 10, 0, 100)
    // 3 points → "M x,y L x,y L x,y"; first x=0, last x=100; y inverts (100 → 0, 0 → height)
    expect(p.startsWith('M0,10')).toBe(true) // first value 0 → bottom (y=height=10)
    expect(p).toContain('L100,0') // last value 100 → top (y=0)
    expect(p).toContain('L50,5') // middle value 50 → y=5
  })
  it('returns empty string for fewer than 2 points', () => {
    expect(linePath([5], 100, 10, 0, 100)).toBe('')
    expect(linePath([], 100, 10, 0, 100)).toBe('')
  })
})
