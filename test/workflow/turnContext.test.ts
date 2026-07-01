import { describe, it, expect, vi } from 'vitest'
import { buildTurnContext } from '../../src/main/services/nodes/turnContext'
import { getNodeState, setNodeState } from '../../src/main/services/nodeStateService'

vi.mock('../../src/main/services/nodeStateService', () => ({
  getNodeState: vi.fn(() => ({ last: 'x' })),
  setNodeState: vi.fn()
}))

describe('buildTurnContext', () => {
  it('sets the turn seed fields', () => {
    const ctx = buildTurnContext({
      profileId: 'p1',
      chatId: 'c1',
      userAction: 'hello',
      signal: new AbortController().signal,
      onDelta: () => {}
    })
    expect(ctx.profileId).toBe('p1')
    expect(ctx.chatId).toBe('c1')
    expect(ctx.userAction).toBe('hello')
  })

  it('forwards streamMain deltas to the given onDelta', () => {
    const onDelta = vi.fn()
    const ctx = buildTurnContext({
      profileId: 'p1',
      chatId: 'c1',
      userAction: 'hello',
      signal: new AbortController().signal,
      onDelta
    })
    ctx.streamMain('hi')
    expect(onDelta).toHaveBeenCalledWith('hi')
  })

  it('wires getNodeState/setNodeState to nodeStateService keyed by this chat', () => {
    const ctx = buildTurnContext({
      profileId: 'p1',
      chatId: 'c1',
      userAction: 'hello',
      signal: new AbortController().signal,
      onDelta: () => {}
    })
    expect(ctx.getNodeState('n9')).toEqual({ last: 'x' })
    expect(getNodeState).toHaveBeenCalledWith('c1', 'n9')
    ctx.setNodeState('n9', { last: 'y' })
    expect(setNodeState).toHaveBeenCalledWith('c1', 'n9', { last: 'y' })
    expect(() => ctx.emitPanel('n', 'x')).not.toThrow()
  })
})
