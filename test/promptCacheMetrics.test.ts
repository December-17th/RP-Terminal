import { describe, it, expect } from 'vitest'
import {
  stablePrefixTokens,
  normalizeUsage,
  summarize,
  TurnStat
} from '../src/main/services/promptCacheMetrics'
import { ChatMessage } from '../src/main/services/promptBuilder'

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

describe('stablePrefixTokens', () => {
  it('counts the leading byte-identical messages and their tokens', () => {
    const prev = [m('system', 'AAAA'), m('user', 'hello'), m('assistant', 'old')]
    const curr = [m('system', 'AAAA'), m('user', 'hello'), m('assistant', 'NEW different')]
    const r = stablePrefixTokens(prev, curr)
    expect(r.messages).toBe(2) // system + user identical; assistant differs
    expect(r.tokens).toBeGreaterThan(0)
  })

  it('stops at the first differing message (role or content)', () => {
    const prev = [m('system', 'AAAA'), m('user', 'x')]
    const curr = [m('system', 'BBBB'), m('user', 'x')]
    expect(stablePrefixTokens(prev, curr).messages).toBe(0)
  })

  it('is 0 against an empty previous prompt', () => {
    expect(stablePrefixTokens([], [m('system', 'AAAA')]).messages).toBe(0)
  })
})

describe('normalizeUsage', () => {
  it('maps Anthropic usage', () => {
    const u = normalizeUsage('anthropic', {
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      input_tokens: 5,
      output_tokens: 50
    })
    expect(u).toEqual({ cacheRead: 100, cacheWrite: 20, input: 5, output: 50 })
  })

  it('maps Gemini usage (cached is a subset of prompt tokens)', () => {
    const u = normalizeUsage('google', {
      promptTokenCount: 120,
      candidatesTokenCount: 30,
      cachedContentTokenCount: 100
    })
    expect(u).toEqual({ cacheRead: 100, cacheWrite: 0, input: 20, output: 30 })
  })

  it('maps OpenAI usage', () => {
    const u = normalizeUsage('openai', {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 100 }
    })
    expect(u).toEqual({ cacheRead: 100, cacheWrite: 0, input: 20, output: 30 })
  })

  it('returns null for missing/garbage usage', () => {
    expect(normalizeUsage('anthropic', null)).toBeNull()
    expect(normalizeUsage('openai', undefined)).toBeNull()
  })
})

describe('summarize', () => {
  it('averages stable-prefix percent and sums usage when present', () => {
    const turns: TurnStat[] = [
      { msgs: 4, promptTokens: 100, stablePrefixMsgs: 0, stablePrefixTokens: 0, usage: null },
      {
        msgs: 5,
        promptTokens: 200,
        stablePrefixMsgs: 4,
        stablePrefixTokens: 150,
        usage: { cacheRead: 150, cacheWrite: 50, input: 50, output: 20 }
      }
    ]
    const r = summarize(turns)
    expect(r.turns).toBe(2)
    // turn1: 0/100 = 0%, turn2: 150/200 = 75% -> avg 37.5
    expect(r.avgStablePrefixPct).toBeCloseTo(37.5, 1)
    expect(r.totalPromptTokens).toBe(300)
    expect(r.usage).toEqual({ cacheRead: 150, cacheWrite: 50, input: 50, output: 20 })
  })

  it('reports null usage when no turn had usage', () => {
    const turns: TurnStat[] = [
      { msgs: 1, promptTokens: 10, stablePrefixMsgs: 0, stablePrefixTokens: 0, usage: null }
    ]
    expect(summarize(turns).usage).toBeNull()
  })
})
