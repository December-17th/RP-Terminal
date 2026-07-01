import { describe, it, expect } from 'vitest'
import { CombatBundleSchema } from '../../src/main/types/character'

describe('CombatBundleSchema.mode', () => {
  it('accepts mode "duel" and "grid"', () => {
    expect(CombatBundleSchema.parse({ mode: 'duel' }).mode).toBe('duel')
    expect(CombatBundleSchema.parse({ mode: 'grid' }).mode).toBe('grid')
  })
  it('leaves mode undefined when absent (default grid behavior)', () => {
    expect(CombatBundleSchema.parse({}).mode).toBeUndefined()
  })
  it('rejects an unknown mode', () => {
    expect(() => CombatBundleSchema.parse({ mode: 'chess' })).toThrow()
  })
})
