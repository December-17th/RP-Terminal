import { describe, it, expect } from 'vitest'
import { cosine, utilityEmbed } from '../../src/main/services/embeddingService'

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1) // same direction, different magnitude
  })
  it('is 0 for empty or mismatched-length vectors', () => {
    expect(cosine([], [])).toBe(0)
    expect(cosine([1, 2], [1])).toBe(0)
  })
  it('handles a zero vector without NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})

describe('utilityEmbed', () => {
  it('returns null when no embedding preset is configured (vector stays disabled)', async () => {
    // getSettings (no-op DB stub) → default settings, embedding_api_preset_id ''. No fetch.
    expect(await utilityEmbed('p', ['hello'])).toBeNull()
  })
})
