import { describe, it, expect } from 'vitest'

// messages.trim (context-epochs plan §5): fits a hand-built Messages array to a token budget via
// the shared fitToBudget. Hand-built arrays lack the HISTORY_TAG, so trimming uses fitToBudget's
// legacy fallback: keep the leading system prefix, drop oldest from the first non-system message.

import { messagesTrim } from '../../src/main/services/nodes/builtin/messageNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { ChatMessage } from '../../src/main/services/promptBuilder'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

const gen = (maxCtx?: number) =>
  ({ settings: { generation: maxCtx ? { max_context_tokens: maxCtx } : {} } }) as any

describe('messages.trim', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'S'.repeat(40) },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }
  ]

  it('over-budget: drops oldest non-system first, keeps system prefix + last turn', () => {
    const r = messagesTrim.run(ctx, { gen: gen(), messages: msgs }, meta(messagesTrim, 'n1', {
      budget_tokens: 20
    }))
    const out = (r.outputs as { messages: ChatMessage[] }).messages
    expect(out[0].role).toBe('system')
    expect(out[out.length - 1].content).toBe('u2')
    // u1 (oldest non-system) evicted
    expect(out.some((m) => m.content === 'u1')).toBe(false)
  })

  it('under-budget: passes through unchanged (same reference)', () => {
    const r = messagesTrim.run(ctx, { gen: gen(), messages: msgs }, meta(messagesTrim, 'n1', {
      budget_tokens: 100000
    }))
    expect((r.outputs as { messages: ChatMessage[] }).messages).toBe(msgs)
  })

  it('unset budget falls back to gen.settings.generation.max_context_tokens', () => {
    // A tiny configured max_context_tokens forces a trim even with no config budget.
    const r = messagesTrim.run(ctx, { gen: gen(20), messages: msgs }, meta(messagesTrim, 'n1', {}))
    const out = (r.outputs as { messages: ChatMessage[] }).messages
    expect(out.some((m) => m.content === 'u1')).toBe(false)
    expect(out[out.length - 1].content).toBe('u2')
  })

  it('unwired messages -> empty array out', () => {
    const r = messagesTrim.run(ctx, { gen: gen() }, meta(messagesTrim, 'n1', {}))
    expect((r.outputs as { messages: ChatMessage[] }).messages).toEqual([])
  })
})
