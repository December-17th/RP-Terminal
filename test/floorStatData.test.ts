import { describe, it, expect } from 'vitest'
import { withStatData } from '../src/main/services/generationService'

describe('withStatData', () => {
  it('replaces stat_data, resets delta_data, preserves other floor fields, does not mutate input', () => {
    const floor: any = {
      floor: 3,
      chat_id: 'c1',
      variables: { stat_data: { a: 1 }, delta_data: [{ path: '/a' }], other: true },
      response: { content: 'hi' }
    }
    const next = withStatData(floor, { b: 2 })
    expect(next.variables.stat_data).toEqual({ b: 2 })
    expect(next.variables.delta_data).toEqual([])
    expect(next.variables.other).toBe(true) // untouched sibling
    expect(next.response).toEqual({ content: 'hi' }) // untouched top-level field
    expect(next.floor).toBe(3)
    // input untouched
    expect(floor.variables.stat_data).toEqual({ a: 1 })
  })
})
