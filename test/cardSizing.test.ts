import { describe, it, expect } from 'vitest'
import { resolveCardSizing, DEFAULT_CARD_SIZING } from '../src/shared/cardRenderMode'

describe('resolveCardSizing', () => {
  it('prefers the per-card override over the global default', () => {
    expect(resolveCardSizing('fill', 'fit')).toBe('fill')
    expect(resolveCardSizing('fit', 'fill')).toBe('fit')
  })

  it('falls back to the global default when there is no override', () => {
    expect(resolveCardSizing(undefined, 'fill')).toBe('fill')
    expect(resolveCardSizing(undefined, 'fit')).toBe('fit')
  })

  it('defaults to fit (content-fit — the embedded-card default)', () => {
    expect(DEFAULT_CARD_SIZING).toBe('fit')
  })
})
