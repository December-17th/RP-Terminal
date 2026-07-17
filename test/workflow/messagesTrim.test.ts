import { describe, it, expect } from 'vitest'

// messages.trim (context-epochs plan §5): fits a hand-built Messages array to a token budget via
// the shared fitToBudget. A hand-built array carries no explicit budget policy, so trimming uses
// fitToBudget's legacy fallback: keep the leading system prefix, drop oldest from the first
// non-system message. The Prompt-aware lane (issue 18c) is covered in the second describe block.

import { messagesTrim } from '../../src/main/services/nodes/builtin/messageNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { ChatMessage, BudgetClass } from '../../src/main/services/promptBuilder'
import { assembledArtifact } from '../../src/main/services/nodes/promptArtifact'
import { createRecordBuilder } from '../../src/main/services/generation/executionRecord'

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

// Issue 18c: the Prompt-aware lane — when a Prompt artifact is wired (no legacy `messages`), trim
// honors the EXPLICIT budget policy its contributions declare (budgetClass) and records the budget
// omission on the execution record, reusing the issue 07/08 omitted-by-budget concept.
describe('messages.trim — Prompt-aware (18c)', () => {
  const wire: ChatMessage[] = [
    { role: 'system', content: 'S'.repeat(40) }, // pinned — never dropped
    { role: 'user', content: 'u1' }, // history — oldest, droppable
    { role: 'assistant', content: 'a1' }, // history — droppable
    { role: 'user', content: 'u2' } // history — latest, always kept
  ]
  const classes: BudgetClass[] = ['pinned', 'history', 'history', 'history']
  // A 1:1 artifact (authored contributions ARE the messages) so artifactBudgetClasses reads the policy.
  const artifact = () =>
    assembledArtifact(wire, {} as never, createRecordBuilder().finish(wire, 0), {
      messages: wire,
      budgetClasses: classes
    })

  it('drops the oldest history under budget, keeps every pinned message + the last turn', () => {
    const r = messagesTrim.run(ctx, { gen: gen(), prompt: artifact() }, meta(messagesTrim, 'n1', {
      budget_tokens: 20
    }))
    const out = r.outputs as { messages: ChatMessage[]; prompt: { messages: ChatMessage[]; record: { entries: { stage: string }[] } } }
    expect(out.messages[0].role).toBe('system') // pinned survived
    expect(out.messages.some((m) => m.content === 'u1')).toBe(false) // oldest history evicted
    expect(out.messages[out.messages.length - 1].content).toBe('u2') // latest kept
    // The updated artifact carries the same trimmed wire + a `trim` omission entry on its record.
    expect(out.prompt.messages).toEqual(out.messages)
    expect(out.prompt.record.entries.some((e) => e.stage === 'trim')).toBe(true)
  })

  it('under budget: passes the artifact through unchanged, no trim omission recorded', () => {
    const a = artifact()
    const r = messagesTrim.run(ctx, { gen: gen(), prompt: a }, meta(messagesTrim, 'n1', {
      budget_tokens: 100000
    }))
    const out = r.outputs as { messages: ChatMessage[]; prompt: unknown }
    expect(out.messages).toBe(wire) // fitToBudget returns the same ref under budget
    expect(out.prompt).toBe(a) // same artifact object, no record mutation
  })

  it('legacy Messages input wins over a wired Prompt (pre-18c path, unchanged)', () => {
    const legacy: ChatMessage[] = [{ role: 'user', content: 'legacy' }]
    const r = messagesTrim.run(
      ctx,
      { gen: gen(), messages: legacy, prompt: artifact() },
      meta(messagesTrim, 'n1', { budget_tokens: 100000 })
    )
    const out = r.outputs as { messages: ChatMessage[]; prompt?: unknown }
    expect(out.messages).toBe(legacy) // legacy lane, artifact ignored
    expect(out.prompt).toBeUndefined() // no artifact emitted on the legacy lane
  })
})
