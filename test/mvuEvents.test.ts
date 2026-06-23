import { describe, it, expect } from 'vitest'
import { buildMvuEvents } from '../src/renderer/src/plugin/mvuEvents'

describe('buildMvuEvents', () => {
  it('emits started → per-delta updated → ended for a floor with delta_data', () => {
    const vars = {
      stat_data: { hp: 80 },
      delta_data: [
        { path: 'hp', old: 100, new: 80, reason: 'hit' },
        { path: 'gold', old: 0, new: 5 }
      ]
    }
    const events = buildMvuEvents(vars)
    expect(events.map((e) => e.name)).toEqual([
      'mag_variable_update_started',
      'mag_variable_updated',
      'mag_variable_updated',
      'mag_variable_update_ended'
    ])
    expect(events[1].payload).toMatchObject({
      path: 'hp',
      oldValue: 100,
      newValue: 80,
      reason: 'hit',
      stat_data: { hp: 80 }
    })
    expect(events[3].payload).toMatchObject({ stat_data: { hp: 80 } })
  })

  it('emits nothing when there are no deltas', () => {
    expect(buildMvuEvents({ stat_data: { hp: 1 }, delta_data: [] })).toEqual([])
    expect(buildMvuEvents({ stat_data: { hp: 1 } })).toEqual([])
    expect(buildMvuEvents(undefined)).toEqual([])
  })
})
