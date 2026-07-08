import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMessage } from '../../src/main/services/promptBuilder'
import type { GenContext } from '../../src/main/services/generation/types'
import type { Lorebook } from '../../src/main/types/character'

// agent.llm lorebook resolution (agent-memory-ux WP-H; spec §7): wire > per-world picks > standard
// matching, and the {{lore}} / appended-system-row injection placement. The resolution core
// (resolveAgentLore) is tested directly; injection placement runs the node with the LLM call +
// interpolation mocked (capture what would be sent).

const mockPicks = vi.hoisted(() => ({
  getLorePicks: vi.fn<() => { book: string; comment: string }[]>(() => []),
  setLorePicks: vi.fn()
}))
vi.mock('../../src/main/services/workflowLorePicksStore', () => mockPicks)

const mockLorebookSvc = vi.hoisted(() => ({
  books: new Map<string, unknown>(),
  getLorebookById: vi.fn((_profileId: string, id: string) =>
    (mockLorebookSvc.books.get(id) as never) ?? null
  )
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: mockLorebookSvc.getLorebookById
}))

// genContext / providerShape / interpolate / runLlmCall — mocked for the run() injection tests.
const genFixture = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../src/main/services/generation/genContext', () => ({
  buildGenContext: vi.fn(() => genFixture.current)
}))
vi.mock('../../src/main/services/generation/providerShape', () => ({
  providerShape: (_settings: unknown, rows: unknown) => rows
}))
vi.mock('../../src/main/services/nodes/builtin/messageNodes', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  interpolate: (text: string) => text
}))
const mockLlm = vi.hoisted(() => ({
  calls: [] as ChatMessage[][],
  runLlmCall: vi.fn(async (_ctx: unknown, _gen: unknown, sendMessages: ChatMessage[]) => {
    mockLlm.calls.push(sendMessages)
    return { raw: 'ok', rawUsage: {} }
  })
}))
vi.mock('../../src/main/services/nodes/builtin/generationNodes', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runLlmCall: mockLlm.runLlmCall
}))

import { agentLlm, resolveAgentLore } from '../../src/main/services/nodes/builtin/agentNodes'
import type { RunContext } from '../../src/main/services/nodes/types'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const entry = (comment: string, content: string, extra: Record<string, unknown> = {}) => ({
  keys: [],
  secondary_keys: [],
  content,
  enabled: true,
  insertion_order: 100,
  insertion_depth: null,
  case_sensitive: false,
  constant: false,
  selective: false,
  probability: 100,
  exclude_recursion: false,
  prevent_recursion: false,
  comment,
  ...extra
})

const activeBook: Lorebook = {
  name: 'Active',
  entries: [
    entry('Always', 'CONSTANT LORE', { constant: true }),
    entry('Dragon', 'DRAGON LORE', { keys: ['dragon'] })
  ]
} as Lorebook

const gen = (over: Partial<GenContext> = {}): GenContext =>
  ({
    profileId: 'p',
    chatId: 'c',
    userAction: '',
    chat: { character_id: 'world-1' },
    settings: {},
    preset: { parameters: {} },
    lorebooks: [activeBook],
    scanText: 'narrator window text',
    maxRecursion: 0,
    floors: [],
    ...over
  }) as unknown as GenContext

const ids = { profileId: 'p', docId: 'doc-1', nodeId: 'agent-1' }

beforeEach(() => {
  mockPicks.getLorePicks.mockReset().mockReturnValue([])
  mockLorebookSvc.books.clear()
  mockLorebookSvc.getLorebookById.mockClear()
  mockLlm.calls.length = 0
  genFixture.current = gen()
})

// ── resolveAgentLore: precedence ────────────────────────────────────────────────────────────────
describe('resolveAgentLore', () => {
  it('a WIRED lore input wins over config: flattens enabled entries, no keyword scan', () => {
    const wiredBooks = [
      {
        name: 'W',
        entries: [entry('a', 'WIRED A'), entry('b', 'WIRED B', { enabled: false })]
      }
    ] as Lorebook[]
    const block = resolveAgentLore(
      gen(),
      { lorebook: 'custom' }, // config would say custom — the wire beats it
      [],
      { wired: true, books: wiredBooks },
      ids
    )
    expect(block).toBe('WIRED A')
    expect(mockPicks.getLorePicks).not.toHaveBeenCalled()
  })

  it('a wired-but-dead lore edge yields an EMPTY block (no silent fallback to matching)', () => {
    const block = resolveAgentLore(gen(), {}, [], { wired: true, books: [] }, ids)
    expect(block).toBe('')
  })

  it('custom picks inject EXACTLY the picked entries by (book, comment); missing skipped fail-soft', () => {
    mockPicks.getLorePicks.mockReturnValue([
      { book: 'b1', comment: 'Keep' },
      { book: 'b1', comment: 'Gone' }, // comment no longer exists → skipped
      { book: 'ghost', comment: 'x' } // book no longer exists → skipped
    ])
    mockLorebookSvc.books.set('b1', {
      name: 'B1',
      entries: [
        entry('Keep', 'PICKED CONTENT'),
        entry('Other', 'NOT PICKED'),
        entry('Keep', 'PICKED TWIN') // duplicate comment resolves together (documented)
      ]
    })
    const block = resolveAgentLore(gen(), { lorebook: 'custom' }, [], { wired: false, books: [] }, ids)
    expect(block).toBe('PICKED CONTENT\n\nPICKED TWIN')
    expect(mockPicks.getLorePicks).toHaveBeenCalledWith('p', 'world-1', 'doc-1', 'agent-1')
  })

  it('custom with NO picks falls back to standard matching (spec §7.2)', () => {
    const block = resolveAgentLore(
      gen(),
      { lorebook: 'custom' },
      [{ role: 'user', content: 'no keywords here' }],
      { wired: false, books: [] },
      ids
    )
    // Only the constant entry fires (no keyword hit).
    expect(block).toBe('CONSTANT LORE')
  })

  it('main scans over the agent HISTORY input (keyword hit pulls the entry)', () => {
    const block = resolveAgentLore(
      gen(),
      {},
      [{ role: 'user', content: 'a dragon appears' }],
      { wired: false, books: [] },
      ids
    )
    expect(block).toContain('CONSTANT LORE')
    expect(block).toContain('DRAGON LORE')
  })

  it('main falls back to gen.scanText when no history is wired/live', () => {
    const g = gen({ scanText: 'the dragon roars' })
    const block = resolveAgentLore(g, {}, [], { wired: false, books: [] }, ids)
    expect(block).toContain('DRAGON LORE')
  })
})

// ── injection placement (spec §7.3) — through agent.llm's run() ─────────────────────────────────
describe('agent.llm lore injection', () => {
  const ctx: RunContext = {
    signal: new AbortController().signal,
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: () => undefined,
    setNodeState: () => {},
    profileId: 'p',
    chatId: 'c',
    workflowId: 'doc-1'
  }
  const run = async (
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    wiredInputs: string[] = ['when']
  ): Promise<ChatMessage[]> => {
    await agentLlm.run(ctx, { when: undefined }, { id: 'agent-1', config: { messages }, wiredInputs })
    return mockLlm.calls[mockLlm.calls.length - 1]
  }

  it('a {{lore}} placeholder row is substituted in place (no appended row)', async () => {
    const sent = await run([
      { role: 'system', content: 'World info:\n{{lore}}\nEnd.' },
      { role: 'user', content: 'go' }
    ])
    expect(sent).toHaveLength(2)
    expect(sent[0].content).toBe('World info:\nCONSTANT LORE\nEnd.')
  })

  it('no placeholder + non-empty block appends a trailing system row', async () => {
    const sent = await run([{ role: 'user', content: 'go' }])
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ role: 'system', content: 'CONSTANT LORE' })
  })

  it('no placeholder + EMPTY block appends nothing (fail-soft)', async () => {
    genFixture.current = gen({ lorebooks: [] })
    const sent = await run([{ role: 'user', content: 'go' }])
    expect(sent).toHaveLength(1)
  })

  it('empty block substitutes {{lore}} as empty string', async () => {
    genFixture.current = gen({ lorebooks: [] })
    const sent = await run([{ role: 'system', content: 'A{{lore}}B' }])
    expect(sent[0].content).toBe('AB')
  })
})
