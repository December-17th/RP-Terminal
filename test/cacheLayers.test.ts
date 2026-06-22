import { describe, it, expect } from 'vitest'
import {
  frozenVarsFor,
  buildStateBlock,
  STATE_PLACEHOLDER
} from '../src/main/services/cacheLayers'

describe('frozenVarsFor', () => {
  const floor0 = { config: { hard: true }, stat_data: { 主角: { 等级: 1, hp: 100 } } }

  it("'diff' returns a deep clone of the floor-0 vars (real seed values)", () => {
    const f = frozenVarsFor('diff', floor0)
    expect(f.stat_data.主角.等级).toBe(1)
    f.stat_data.主角.等级 = 999 // mutating the clone must not touch the source
    expect(floor0.stat_data.主角.等级).toBe(1)
  })

  it("'partition' replaces every stat_data leaf with a placeholder, keeping shape", () => {
    const f = frozenVarsFor('partition', floor0)
    expect(f.stat_data.主角.等级).toBe(STATE_PLACEHOLDER)
    expect(f.stat_data.主角.hp).toBe(STATE_PLACEHOLDER)
    expect(f.config.hard).toBe(true) // non-state vars untouched
  })

  it('handles missing / non-object stat_data without throwing', () => {
    expect(frozenVarsFor('partition', {}).stat_data).toBeUndefined()
    expect(frozenVarsFor('partition', { stat_data: 5 } as any).stat_data).toBe(5)
  })
})

describe('buildStateBlock', () => {
  it('serializes stat_data into a labelled block', () => {
    const b = buildStateBlock({ stat_data: { hp: 30 } })
    expect(b).toBe('[Current State]\n{"hp":30}')
  })

  it('returns null when there is no stat_data', () => {
    expect(buildStateBlock({})).toBeNull()
    expect(buildStateBlock(undefined)).toBeNull()
  })
})
