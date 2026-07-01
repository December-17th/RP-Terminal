import { describe, it, expect, vi } from 'vitest'
import { buildTurnContext } from '../../src/main/services/nodes/turnContext'

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

  it('getNodeState returns undefined and setNodeState/emitPanel are safe no-ops', () => {
    const ctx = buildTurnContext({
      profileId: 'p1',
      chatId: 'c1',
      userAction: 'hello',
      signal: new AbortController().signal,
      onDelta: () => {}
    })
    expect(ctx.getNodeState('n')).toBeUndefined()
    expect(() => ctx.setNodeState('n', 1)).not.toThrow()
    expect(() => ctx.emitPanel('n', 'x')).not.toThrow()
  })
})
