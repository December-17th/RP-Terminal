import { describe, it, expect } from 'vitest'
import { buildFloorMetrics } from '../src/main/services/promptCacheMetrics'
import { ChatMessage } from '../src/main/services/promptBuilder'

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })
const base = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  cacheLevel: 1 as number,
  l1Mode: 'diff' as const,
  ts: '2026-06-22T00:00:00Z',
  responseText: 'hello there'
}

describe('buildFloorMetrics', () => {
  it('first turn: proxy 0, cumulative turns 1, averages = this turn', () => {
    const r = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'hi')],
      prevMessages: null,
      usage: null,
      prevCumulative: null
    })
    expect(r.turn.proxyTokens).toBe(0)
    expect(r.turn.proxyPct).toBe(0)
    expect(r.cumulative.turns).toBe(1)
    expect(r.cumulative.usageTurns).toBe(0)
    expect(r.cumulative.avgProxyPct).toBe(0)
    // no provider usage → output estimated from responseText
    expect(r.turn.outputTokens).toBeGreaterThan(0)
  })

  it('second turn with a stable prefix raises proxy + aggregates cumulative', () => {
    const t1 = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'hi')],
      prevMessages: null,
      usage: { cacheRead: 0, cacheWrite: 10, input: 5, output: 3 },
      prevCumulative: null
    })
    const t2 = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'hi'), m('assistant', 'r'), m('user', 'next')],
      prevMessages: [m('system', 'AAAA'), m('user', 'hi')],
      usage: { cacheRead: 8, cacheWrite: 0, input: 2, output: 4 },
      prevCumulative: t1.cumulative
    })
    expect(t2.turn.proxyTokens).toBeGreaterThan(0)
    expect(t2.cumulative.turns).toBe(2)
    expect(t2.cumulative.usageTurns).toBe(2)
    expect(t2.cumulative.usage?.cacheRead).toBe(8)
    // avgCacheHitPct only averages over usage turns; t2 hit = 8/(8+0+2) = 80%
    expect(t2.cumulative.avgCacheHitPct).toBeGreaterThan(0)
    expect(t2.cumulative.avgPromptTokens).toBeCloseTo(t2.cumulative.totalPromptTokens / 2, 5)
  })

  it('a usage-less turn does not move usageTurns or avgCacheHitPct', () => {
    const withUsage = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA')],
      prevMessages: null,
      usage: { cacheRead: 9, cacheWrite: 0, input: 1, output: 1 },
      prevCumulative: null
    })
    const noUsage = buildFloorMetrics({
      ...base,
      messages: [m('system', 'AAAA'), m('user', 'x')],
      prevMessages: [m('system', 'AAAA')],
      usage: null,
      prevCumulative: withUsage.cumulative
    })
    expect(noUsage.cumulative.usageTurns).toBe(1)
    expect(noUsage.cumulative.avgCacheHitPct).toBe(withUsage.cumulative.avgCacheHitPct)
    // output falls back to an estimate when usage is null
    expect(noUsage.turn.usage).toBeNull()
    expect(noUsage.turn.outputTokens).toBeGreaterThan(0)
  })
})
