import { describe, it, expect } from 'vitest'
import {
  resolveCardMode,
  DEFAULT_CARD_RENDER_MODE
} from '../src/shared/cardRenderMode'

describe('resolveCardMode', () => {
  it('uses the override when present', () => {
    expect(resolveCardMode('isolated', 'inline')).toBe('isolated')
    expect(resolveCardMode('inline', 'isolated')).toBe('inline')
  })
  it('falls back to the global default when no override', () => {
    expect(resolveCardMode(undefined, 'isolated')).toBe('isolated')
    expect(resolveCardMode(undefined, 'inline')).toBe('inline')
  })
  it('defaults to inline', () => {
    expect(DEFAULT_CARD_RENDER_MODE).toBe('inline')
  })
})
