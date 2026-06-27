import { describe, it, expect } from 'vitest'
import { recomputeMetricsForFloors } from '../src/main/services/usageMetricsService'
import { FloorFile } from '../src/main/types/chat'

const floor = (n: number, req: { role: string; content: string }[] | undefined): FloorFile => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: `u${n}`, timestamp: 't' },
  response: { content: `resp ${n}`, model: 'm', provider: 'anthropic' },
  events: [],
  variables: {},
  request: req
})

describe('recomputeMetricsForFloors', () => {
  it('recomputes proxy + cumulative across a request-bearing chain, usage stays null', () => {
    const floors = [
      floor(0, [
        { role: 'system', content: 'AAAA' },
        { role: 'user', content: 'hi' }
      ]),
      floor(1, [
        { role: 'system', content: 'AAAA' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'r' },
        { role: 'user', content: 'next' }
      ])
    ]
    const out = recomputeMetricsForFloors(floors)
    expect(out[0].metrics?.turn.proxyTokens).toBe(0) // first floor has no previous
    expect(out[0].metrics?.cumulative.turns).toBe(1)
    expect(out[1].metrics?.turn.proxyTokens).toBeGreaterThan(0)
    expect(out[1].metrics?.cumulative.turns).toBe(2)
    expect(out[1].metrics?.turn.usage).toBeNull()
    expect(out[1].metrics?.cumulative.usage).toBeNull()
  })

  it('leaves floors without a stored request untouched (no metrics)', () => {
    const out = recomputeMetricsForFloors([floor(0, undefined)])
    expect(out[0].metrics).toBeUndefined()
  })
})
