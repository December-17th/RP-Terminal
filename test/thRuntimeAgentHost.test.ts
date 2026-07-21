import { describe, expect, it, vi } from 'vitest'

import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'

describe('Card Agent Host', () => {
  it('exposes direct JSON Agent input and floor subscriptions through rpt.agents', async () => {
    const input = { month: 3, properties: [{ id: 'inn', income: 12 }] }
    const runAgent = vi.fn(async () => ({
      invocationId: 'run-1',
      status: 'succeeded' as const,
      result: { ok: true },
      sourceRestarts: 0,
      required: true
    }))
    const onFloorCommitted = vi.fn(() => () => undefined)
    const host = {
      ...createNullHost({ profileId: 'profile', chatId: 'chat', characterId: 'card' }),
      runAgent,
      onFloorCommitted
    }

    const runtime = createThRuntime(host) as any
    const outcome = await runtime.rpt.agents.run('Monthly Property', { input, floor: 12 })
    const handler = vi.fn()
    const dispose = runtime.rpt.agents.onFloorCommitted(handler)

    expect(outcome).toMatchObject({ invocationId: 'run-1', status: 'succeeded' })
    expect(runAgent).toHaveBeenCalledWith('Monthly Property', { input, floor: 12 })
    expect(typeof runAgent.mock.calls[0][1].input).toBe('object')
    expect(runAgent.mock.calls[0][1].input).toEqual(input)
    expect(onFloorCommitted).toHaveBeenCalledWith(handler)
    expect(typeof dispose).toBe('function')
  })
})
