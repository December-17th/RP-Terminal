import { describe, it, expect } from 'vitest'

// messages.trim (context-epochs plan §5): fits a hand-built Messages array to a token budget via
// the shared fitToBudget. A hand-built array carries no explicit budget policy, so trimming uses
// fitToBudget's legacy fallback: keep the leading system prefix, drop oldest from the first
// non-system message. The Prompt-aware lane (issue 18c) is covered in the second describe block.

import { messagesTrim } from '../../src/main/services/nodes/builtin/messageNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { ChatMessage, BudgetClass } from '../../src/main/services/promptBuilder'
import {
  assembledArtifact,
  artifactBudgetClasses
} from '../../src/main/services/nodes/promptArtifact'
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

// M5 / M3-review hardening: artifactBudgetClasses aligns the budget policy to messages by IDENTITY,
// not position/length. These pin the two root-fixes (reorder → finding 1; chained re-trim → finding 3)
// plus the preset→messages.trim lane under merge_consecutive_roles:false (finding 2).
describe('artifactBudgetClasses — identity alignment (M3-review findings 1 & 3)', () => {
  const authored: ChatMessage[] = [
    { role: 'system', content: 'MAIN' }, // pinned
    { role: 'user', content: 'h1' }, // history
    { role: 'user', content: 'h2' } // history
  ]
  const classes: BudgetClass[] = ['pinned', 'history', 'history']

  it('finding 1 — a REORDERED wire keeps each message its own class (not the positional one)', () => {
    // Provider shaping reordered the wire (same messages, different order). Positional alignment would
    // hand message i contribution i's class — misclassing the moved pinned system. Identity fixes it.
    const wire: ChatMessage[] = [
      { role: 'user', content: 'h2' },
      { role: 'system', content: 'MAIN' },
      { role: 'user', content: 'h1' }
    ]
    const a = assembledArtifact(wire, {} as never, undefined, { messages: authored, budgetClasses: classes })
    // Positional (pre-M5) would have returned ['pinned','history','history']; identity is correct:
    expect(artifactBudgetClasses(a)).toEqual(['history', 'pinned', 'history'])
  })

  it('finding 3 — a CHAINED re-trim (shorter wire than contributions) still yields a policy', () => {
    // After a first trim swapped in a shorter `messages`, length no longer equals `contributions`, so the
    // positional guard returned undefined and the second trim degraded to the position-based fallback.
    const trimmedWire: ChatMessage[] = [
      { role: 'system', content: 'MAIN' },
      { role: 'user', content: 'h2' } // h1 already dropped by a prior trim
    ]
    const a = assembledArtifact(trimmedWire, {} as never, undefined, {
      messages: authored,
      budgetClasses: classes
    })
    expect(artifactBudgetClasses(a)).toEqual(['pinned', 'history'])
  })

  it('a synthetic/undeclared-class contribution set yields no policy (unchanged)', () => {
    const wire: ChatMessage[] = [{ role: 'system', content: 'MAIN' }, { role: 'user', content: 'h1' }]
    // authored carries only ONE class (misaligned/partial) → not every contribution declares one → undefined.
    const a = assembledArtifact(wire, {} as never, undefined, {
      messages: wire,
      budgetClasses: ['pinned'] as BudgetClass[]
    })
    expect(artifactBudgetClasses(a)).toBeUndefined()
  })

  it('a coalesced wire message matching no single contribution yields no policy (positional fallback)', () => {
    // Simulates a shaped wire whose merged content matches no pre-shape contribution → undefined.
    const wire: ChatMessage[] = [{ role: 'system', content: 'MAIN\nEXTRA' }]
    const a = assembledArtifact(wire, {} as never, undefined, { messages: authored, budgetClasses: classes })
    expect(artifactBudgetClasses(a)).toBeUndefined()
  })
})

describe('messages.trim — preset lane under merge_consecutive_roles:false (M3-review finding 2)', () => {
  // A preset-assembled artifact under merge-off keeps discrete messages, so its contributions carry a
  // per-message budgetClass. Provider end-on-user shaping reordered the wire (a pinned system displaced
  // to the middle). Identity alignment keeps that pinned message unevictable while the oldest history is
  // trimmed — WITHOUT it, positional alignment would classify the displaced pinned system as history and
  // evict it. This pins the lane's history-awareness.
  const authored: ChatMessage[] = [
    { role: 'system', content: 'MAIN'.repeat(12) }, // pinned system prompt (large)
    { role: 'user', content: 'h1' }, // history — oldest
    { role: 'user', content: 'h2' }, // history
    { role: 'user', content: 'h3' } // history — latest
  ]
  const classes: BudgetClass[] = ['pinned', 'history', 'history', 'history']
  // Wire order after shaping: the pinned MAIN was displaced to index 1 (would be misclassed positionally).
  const wire: ChatMessage[] = [
    { role: 'user', content: 'h1' },
    { role: 'system', content: 'MAIN'.repeat(12) },
    { role: 'user', content: 'h2' },
    { role: 'user', content: 'h3' }
  ]

  it('trims the oldest history and NEVER evicts the (displaced) pinned system', () => {
    const a = assembledArtifact(wire, {} as never, createRecordBuilder().finish(wire, 0), {
      messages: authored,
      budgetClasses: classes
    })
    const r = messagesTrim.run(ctx, { gen: gen(), prompt: a }, meta(messagesTrim, 'n1', {
      budget_tokens: 25
    }))
    const out = r.outputs as { messages: ChatMessage[] }
    // The pinned system survived (identity-classed pinned) — positional alignment would have dropped it.
    expect(out.messages.some((m) => m.role === 'system')).toBe(true)
    // The oldest history turn was dropped, the latest kept.
    expect(out.messages.some((m) => m.content === 'h1')).toBe(false)
    expect(out.messages[out.messages.length - 1].content).toBe('h3')
  })
})
