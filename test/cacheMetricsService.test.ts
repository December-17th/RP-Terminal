import { describe, it, expect, beforeEach } from 'vitest'
import { recordTurn, getReport, resetChat } from '../src/main/services/cacheMetricsService'
import { ChatMessage } from '../src/main/services/promptBuilder'

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

describe('cacheMetricsService', () => {
  beforeEach(() => resetChat('c1'))

  it('first turn has a 0 stable prefix (no previous prompt)', () => {
    const t = recordTurn('c1', [m('system', 'AAAA'), m('user', 'hi')], null)
    expect(t.stablePrefixMsgs).toBe(0)
    expect(t.msgs).toBe(2)
  })

  it('a stable frontier yields a growing stable prefix on later turns', () => {
    recordTurn('c1', [m('system', 'AAAA'), m('user', 'hi')], null)
    const t2 = recordTurn(
      'c1',
      [m('system', 'AAAA'), m('user', 'hi'), m('assistant', 'reply'), m('user', 'next')],
      { cacheRead: 4, cacheWrite: 0, input: 2, output: 1 }
    )
    expect(t2.stablePrefixMsgs).toBe(2) // system + first user identical
    const r = getReport('c1')
    expect(r.turns).toBe(2)
    expect(r.usage?.cacheRead).toBe(4)
  })

  it('resetChat clears prior turns and the previous-prompt anchor', () => {
    recordTurn('c1', [m('system', 'AAAA')], null)
    resetChat('c1')
    expect(getReport('c1').turns).toBe(0)
    const t = recordTurn('c1', [m('system', 'AAAA')], null)
    expect(t.stablePrefixMsgs).toBe(0) // anchor was cleared
  })
})
