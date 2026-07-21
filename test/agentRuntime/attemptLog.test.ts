import { describe, expect, it } from 'vitest'

import { buildAttemptLog } from '../../src/main/services/agentRuntime/harness/attemptLog'
import {
  parseAgentDefinition,
  resolveInvocationOptions,
  type AgentDefinition,
  type PromptMessage
} from '../../src/shared/agentRuntime'

/**
 * Microscope-lite D1 + D3, the split's ONLY regression harness. Every existing buildAttemptLog test
 * flattens `[...immutablePrefix, ...attemptLog]` before asserting, so nothing pins WHICH array a
 * message lands in — exactly the classification this fix corrects. These assert DIRECTLY on array
 * membership so the reuse boundary and its coarse origins cannot regress unnoticed.
 */

const definition = (prompt: unknown): AgentDefinition => {
  const parsed = parseAgentDefinition({
    format: 'rpt-agent',
    formatVersion: 1,
    name: 'Split',
    prompt,
    result: { mode: 'text' },
    defaults: { retryDelayMs: 0 }
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

const text = (content: string): PromptMessage => ({
  role: 'system',
  content: [{ type: 'text', text: content }]
})

const withBinding = (label: string, path: string): PromptMessage => ({
  role: 'system',
  content: [
    { type: 'text', text: label },
    { type: 'binding', source: { type: 'variables', path } }
  ]
})

const build = (def: AgentDefinition, request: Parameters<typeof buildAttemptLog>[1]) => {
  const resolved = resolveInvocationOptions(def, undefined)
  if (!resolved.ok) throw new Error('invalid fixture options')
  const built = buildAttemptLog(def, request, resolved.value, 'POLICY')
  if (!built.ok) throw new Error(built.failure.code)
  return built
}

const contentsOf = (messages: Array<{ content: string }>): string[] =>
  messages.map((message) => message.content)

describe('buildAttemptLog volatility boundary (D1)', () => {
  it('marks templated text volatile ONLY when a renderer is active', () => {
    const def = definition([{ role: 'system', content: 'core={{world}}' }])

    const rendered = build(def, {
      definition: def,
      input: {},
      profileId: 'p',
      render: (value) => value
    })
    // (b): render present + `{{` in authored text → the message leaves the immutable prefix.
    expect(contentsOf(rendered.immutablePrefix)).toEqual(['POLICY'])
    expect(contentsOf(rendered.attemptLog)).toEqual(['core={{world}}', '{}'])

    const verbatim = build(def, { definition: def, input: {}, profileId: 'p' })
    // Same authored text, no renderer → used verbatim, so it is stable and stays in the prefix.
    expect(contentsOf(verbatim.immutablePrefix)).toEqual(['POLICY', 'core={{world}}'])
    expect(contentsOf(verbatim.attemptLog)).toEqual(['{}'])
  })

  it('marks EJS-templated text volatile under a renderer', () => {
    const def = definition([{ role: 'system', content: 'core=<%= 1 + 1 %>' }])
    const built = build(def, {
      definition: def,
      input: {},
      profileId: 'p',
      render: (value) => value.replace('<%= 1 + 1 %>', '2')
    })
    expect(contentsOf(built.immutablePrefix)).toEqual(['POLICY'])
    expect(built.attemptLog[0].content).toBe('core=2')
  })

  it('keeps the binding rule unchanged — a bound segment is always volatile', () => {
    const def = definition([withBinding('w=', 'variables.world')])
    const built = build(def, {
      definition: def,
      input: {},
      profileId: 'p',
      promptValues: { 'variables.world': 'harbor' }
    })
    // No renderer, no template syntax — yet the binding forces it out of the prefix.
    expect(contentsOf(built.immutablePrefix)).toEqual(['POLICY'])
    expect(built.attemptLog[0].content).toBe('w=harbor')
  })

  it('marks every substituted message volatile — only the policy stays in the prefix', () => {
    const def = definition([{ role: 'system', content: 'Authored.' }])
    const built = build(def, {
      definition: def,
      input: { a: 1 },
      profileId: 'p',
      // An assembled prompt embeds per-floor state; the renderer is ignored on this path.
      prompt: [text('ASSEMBLED CONTEXT'), text('Task instruction.')],
      render: () => 'SHOULD NOT RUN'
    })
    expect(contentsOf(built.immutablePrefix)).toEqual(['POLICY'])
    expect(contentsOf(built.attemptLog)).toEqual([
      'ASSEMBLED CONTEXT',
      'Task instruction.',
      '{"a":1}'
    ])
  })

  it('is sticky — an immutable-looking message after a volatile one stays in the log', () => {
    const def = definition([
      { role: 'system', content: 'first={{v}}' },
      { role: 'system', content: 'plain, no template' }
    ])
    const built = build(def, {
      definition: def,
      input: {},
      profileId: 'p',
      render: (value) => value
    })
    // The first message flips volatile; the second is plain but the clean-cut split keeps it in the log.
    expect(contentsOf(built.immutablePrefix)).toEqual(['POLICY'])
    expect(contentsOf(built.attemptLog)).toEqual(['first={{v}}', 'plain, no template', '{}'])
  })

  it('leaves the dispatched wire order byte-identical to a naive concatenation', () => {
    const def = definition([
      { role: 'system', content: 'stable authored' },
      { role: 'system', content: 'volatile={{v}}' }
    ])
    const built = build(def, {
      definition: def,
      input: { q: 'x' },
      profileId: 'p',
      render: (value) => value
    })
    // Only the split point moved; concatenation is unchanged.
    expect(contentsOf([...built.immutablePrefix, ...built.attemptLog])).toEqual([
      'POLICY',
      'stable authored',
      'volatile={{v}}',
      '{"q":"x"}'
    ])
  })
})

describe('buildAttemptLog origins (D3)', () => {
  it('aligns origins to the concatenated order on the messages path', () => {
    const def = definition([
      { role: 'system', content: 'stable authored' },
      { role: 'system', content: 'volatile={{v}}' }
    ])
    const built = build(def, {
      definition: def,
      input: {},
      profileId: 'p',
      render: (value) => value
    })
    expect(built.origins).toHaveLength(built.immutablePrefix.length + built.attemptLog.length)
    // policy, the stable authored prompt (still in prefix), the templated prompt, the input.
    expect(built.origins).toEqual(['harness-policy', 'agent-prompt', 'agent-prompt', 'input'])
  })

  it('tags every substituted message assembled-preset on the assembled path', () => {
    const def = definition([{ role: 'system', content: 'Authored.' }])
    const built = build(def, {
      definition: def,
      input: {},
      profileId: 'p',
      prompt: [text('CONTEXT'), text('Instruction.')]
    })
    expect(built.origins).toEqual([
      'harness-policy',
      'assembled-preset',
      'assembled-preset',
      'input'
    ])
  })

  it('tags an addendum after the input', () => {
    const def = definition([{ role: 'system', content: 'Authored.' }])
    const resolved = resolveInvocationOptions(def, { addendum: 'note' })
    if (!resolved.ok) throw new Error('invalid fixture options')
    const built = buildAttemptLog(
      def,
      { definition: def, input: {}, profileId: 'p' },
      resolved.value,
      'POLICY'
    )
    if (!built.ok) throw new Error(built.failure.code)
    expect(built.origins).toEqual(['harness-policy', 'agent-prompt', 'input', 'addendum'])
    expect(built.attemptLog.at(-1)?.content).toBe('note')
  })
})
