import { describe, it, expect, vi, beforeEach } from 'vitest'

// Extractor + variable nodes (extractor-nodes plan §2): vars.get/vars.save (floor/session
// variable read-write), context.history/context.card/context.persona (turn-context slices),
// and memory.query (query-driven recall, keyword-ranking only in v1).

const floorSvc = vi.hoisted(() => ({
  getAllFloors: vi.fn(),
  saveFloor: vi.fn(),
  getFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => floorSvc)

const chatVarsSvc = vi.hoisted(() => ({
  getChatCardVars: vi.fn(),
  setChatCardVars: vi.fn()
}))
vi.mock('../../src/main/services/chatCardVarsService', () => chatVarsSvc)

const memoryStoreSvc = vi.hoisted(() => ({
  getEntries: vi.fn()
}))
vi.mock('../../src/main/services/memoryStore', () => memoryStoreSvc)

import { varsGet, varsSave } from '../../src/main/services/nodes/builtin/varsNodes'
import {
  contextHistory,
  contextCard,
  contextPersona
} from '../../src/main/services/nodes/builtin/contextNodes'
import { memoryQuery } from '../../src/main/services/nodes/builtin/memoryNodes'
import { NodeRunFailure, RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { MemoryEntry } from '../../src/main/services/memoryStore'

const ctx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

/** Mirrors the engine's node.config parsing: parse raw config through the impl's configSchema
 *  before handing it to run(), as NodeMeta (mvuNodes.test.ts pattern). */
const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown> = {}) => ({
  id,
  config: impl.configSchema ? (impl.configSchema.parse(rawConfig) as Record<string, unknown>) : {}
})

const makeEntry = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: 'm1',
  chatId: 'c1',
  collection: 'events',
  entityKey: null,
  summary: 'default summary',
  payload: null,
  keywords: [],
  entities: [],
  salience: 1,
  pinned: false,
  turnStart: null,
  turnEnd: null,
  supersededBy: null,
  embedModel: null,
  embedding: null,
  updatedAt: null,
  createdAt: null,
  ...over
})

// One enabled stream collection (keyword mode) shared by the memory.query fixture.
const streamCollection = {
  id: 'events',
  shape: 'stream' as const,
  enabled: true,
  write: { trigger: 'checkpoint' as const, prompt: '' },
  retrieval: { mode: 'keyword' as const, count: 5, tokenBudget: 600 },
  inject: { label: 'Relevant earlier events' }
}

const gen = {
  profileId: 'p1',
  chatId: 'c1',
  userName: 'Ash',
  workingVars: { fallback: true },
  settings: {
    persona: { description: 'A wandering trainer.' },
    memory: { collections: [streamCollection] }
  },
  card: {
    data: {
      name: 'Misty',
      description: 'A gym leader.',
      personality: 'Confident.',
      scenario: 'A rainy gym.',
      first_mes: 'Hello there.'
    }
  },
  floors: [
    {
      floor: 0,
      user_message: { content: 'Hi!' },
      response: { content: '<think>plan</think>Hello, trainer.' },
      variables: { custom: { note: 'floor0' }, stat_data: { hp: 5 } }
    },
    {
      floor: 1,
      user_message: { content: 'How are you?' },
      response: { content: 'I am well.' },
      variables: { custom: { note: 'floor1' }, stat_data: { hp: 8 } }
    }
  ]
}

beforeEach(() => {
  floorSvc.getAllFloors.mockReset()
  floorSvc.saveFloor.mockReset()
  floorSvc.getFloor.mockReset()
  chatVarsSvc.getChatCardVars.mockReset()
  chatVarsSvc.setChatCardVars.mockReset()
  memoryStoreSvc.getEntries.mockReset()
})

describe('vars.get', () => {
  it('case 1: floor scope reads latest-floor variables (custom key AND stat_data.hp)', () => {
    floorSvc.getAllFloors.mockReturnValue(gen.floors)
    const r1 = varsGet.run(ctx, { gen }, meta(varsGet, 'n1', { path: 'custom.note' }))
    expect(r1).toEqual({ outputs: { value: 'floor1', text: 'floor1' } })

    const r2 = varsGet.run(ctx, { gen }, meta(varsGet, 'n1', { path: 'stat_data.hp' }))
    expect(r2).toEqual({ outputs: { value: 8, text: '8' } })
  })

  it('case 2: session scope reads the chat KV', () => {
    chatVarsSvc.getChatCardVars.mockReturnValue({ world: { month: 3 } })
    const r = varsGet.run(
      ctx,
      { gen },
      meta(varsGet, 'n1', { scope: 'session', path: 'world.month' })
    )
    expect(r).toEqual({ outputs: { value: 3, text: '3' } })
    expect(chatVarsSvc.getChatCardVars).toHaveBeenCalledWith('p1', 'c1')
  })
})

describe('vars.save', () => {
  it('case 3: floor scope writes a custom path and persists via saveFloor; stat_data sibling untouched', () => {
    const last = {
      floor: 1,
      user_message: { content: 'x' },
      response: { content: 'y' },
      variables: { custom: { note: 'old' }, stat_data: { hp: 8 } }
    }
    const originalVariables = last.variables
    floorSvc.getAllFloors.mockReturnValue([gen.floors[0], last])
    const r = varsSave.run(
      ctx,
      { gen, value: 'new note' },
      meta(varsSave, 'n1', { path: 'custom.note' })
    )
    expect(r).toEqual({ outputs: {} })
    expect(floorSvc.saveFloor).toHaveBeenCalledTimes(1)
    const [profileId, chatId, savedFloor] = floorSvc.saveFloor.mock.calls[0]
    expect(profileId).toBe('p1')
    expect(chatId).toBe('c1')
    expect(savedFloor.variables.custom.note).toBe('new note')
    expect(savedFloor.variables.stat_data).toEqual({ hp: 8 })
    // the `variables` object itself is a fresh copy (`{ ...last.variables }`, per plan §2.2) —
    // saveFloor gets a distinct object from the one `last` originally pointed to.
    expect(savedFloor.variables).not.toBe(originalVariables)
  })

  it('case 4: refuses stat_data.* -> NodeRunFailure kind B, code reserved-path, no save', () => {
    floorSvc.getAllFloors.mockReturnValue(gen.floors)
    let err: unknown
    try {
      varsSave.run(ctx, { gen, value: 99 }, meta(varsSave, 'n1', { path: 'stat_data.hp' }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).kind).toBe('B')
    expect((err as NodeRunFailure).code).toBe('reserved-path')
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
  })

  it('case 4b: refuses a bracket-index stat_data root (toParts, not a hand-rolled dot split)', () => {
    // A hand-rolled `.split('.')` would read the root of "stat_data[0].hp" as the literal
    // "stat_data[0]" (not "stat_data"), missing the guard — while setPath/getPath (which use
    // the SAME toParts dialect) would still resolve the write straight into stat_data. Using
    // toParts for the guard, as this node does, catches it.
    floorSvc.getAllFloors.mockReturnValue(gen.floors)
    let err: unknown
    try {
      varsSave.run(ctx, { gen, value: 99 }, meta(varsSave, 'n1', { path: 'stat_data[0].hp' }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect((err as NodeRunFailure).code).toBe('reserved-path')
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
  })

  it('case 5: session scope round-trips through get->setPath->set (whole-object write asserted)', () => {
    chatVarsSvc.getChatCardVars.mockReturnValue({ world: { month: 3 }, other: 'kept' })
    const r = varsSave.run(
      ctx,
      { gen, value: 4 },
      meta(varsSave, 'n1', { scope: 'session', path: 'world.month' })
    )
    expect(r).toEqual({ outputs: {} })
    expect(chatVarsSvc.setChatCardVars).toHaveBeenCalledWith('p1', 'c1', {
      world: { month: 4 },
      other: 'kept'
    })
  })

  it('case 6: value === undefined -> { outputs: {} }, no writes', () => {
    const r = varsSave.run(
      ctx,
      { gen, value: undefined },
      meta(varsSave, 'n1', { path: 'custom.note' })
    )
    expect(r).toEqual({ outputs: {} })
    expect(floorSvc.getAllFloors).not.toHaveBeenCalled()
    expect(floorSvc.saveFloor).not.toHaveBeenCalled()
    expect(chatVarsSvc.getChatCardVars).not.toHaveBeenCalled()
    expect(chatVarsSvc.setChatCardVars).not.toHaveBeenCalled()
  })
})

describe('context.history', () => {
  it('case 7: transcript + messages for last N floors, thinking stripped', () => {
    const r = contextHistory.run(ctx, { gen }, meta(contextHistory, 'n1', {}))
    const outputs = r.outputs as { transcript: string; messages: unknown[] }
    expect(outputs.transcript).toBe(
      'User: Hi!\nAssistant: Hello, trainer.\nUser: How are you?\nAssistant: I am well.'
    )
    expect(outputs.messages).toEqual([
      { role: 'user', content: 'Hi!' },
      { role: 'assistant', content: 'Hello, trainer.' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am well.' }
    ])
  })

  it('case 8: include: "user" narrows both outputs', () => {
    const r = contextHistory.run(ctx, { gen }, meta(contextHistory, 'n1', { include: 'user' }))
    const outputs = r.outputs as { transcript: string; messages: unknown[] }
    expect(outputs.transcript).toBe('User: Hi!\nUser: How are you?')
    expect(outputs.messages).toEqual([
      { role: 'user', content: 'Hi!' },
      { role: 'user', content: 'How are you?' }
    ])
  })
})

describe('context.card', () => {
  it('case 9: single field; all contains labelled blocks', () => {
    const r1 = contextCard.run(ctx, { gen }, meta(contextCard, 'n1', {}))
    expect(r1).toEqual({ outputs: { text: 'A gym leader.' } })

    const r2 = contextCard.run(ctx, { gen }, meta(contextCard, 'n1', { field: 'all' }))
    const text = (r2.outputs as { text: string }).text
    expect(text).toContain('[name]\nMisty')
    expect(text).toContain('[description]\nA gym leader.')
    expect(text).toContain('[personality]\nConfident.')
    expect(text).toContain('[scenario]\nA rainy gym.')
  })
})

describe('context.persona', () => {
  it('case 10: name + description', () => {
    const r = contextPersona.run(ctx, { gen }, meta(contextPersona, 'n1', {}))
    expect(r).toEqual({ outputs: { name: 'Ash', text: 'A wandering trainer.' } })
  })
})

describe('memory.query', () => {
  it('case 11a: count: 1 -> ONLY the matching entry returns', () => {
    const matching = makeEntry({ id: 'a', summary: 'Ash caught a Pikachu', keywords: ['pikachu'] })
    const other = makeEntry({ id: 'b', summary: 'Misty likes water types', keywords: ['water'] })
    memoryStoreSvc.getEntries.mockReturnValue([matching, other])
    const r = memoryQuery.run(ctx, { gen, query: 'pikachu' }, meta(memoryQuery, 'n1', { count: 1 }))
    const outputs = r.outputs as { block: string; rows: MemoryEntry[] }
    expect(outputs.rows).toHaveLength(1)
    expect(outputs.rows[0].id).toBe('a')
    expect(outputs.block).toContain('Ash caught a Pikachu')
    expect(outputs.block).not.toContain('Misty likes water types')
  })

  it('case 11b: default count -> BOTH entries return (backfill with unmatched recency entries)', () => {
    const matching = makeEntry({ id: 'a', summary: 'Ash caught a Pikachu', keywords: ['pikachu'] })
    const other = makeEntry({ id: 'b', summary: 'Misty likes water types', keywords: ['water'] })
    memoryStoreSvc.getEntries.mockReturnValue([matching, other])
    const r = memoryQuery.run(ctx, { gen, query: 'pikachu' }, meta(memoryQuery, 'n1', {}))
    const outputs = r.outputs as { block: string; rows: MemoryEntry[] }
    expect(outputs.rows).toHaveLength(2)
    expect(outputs.block).toContain('Ash caught a Pikachu')
    expect(outputs.block).toContain('Misty likes water types')
  })

  it('case 12: blank query -> empty outputs, getEntries never called', () => {
    const r = memoryQuery.run(ctx, { gen, query: '   ' }, meta(memoryQuery, 'n1', {}))
    expect(r).toEqual({ outputs: { block: '', rows: [] } })
    expect(memoryStoreSvc.getEntries).not.toHaveBeenCalled()
  })

  it('case 13: mode filter — llm collection skipped, vector stream downgraded to keyword', () => {
    const llmCollection = {
      id: 'plans',
      shape: 'stream' as const,
      enabled: true,
      write: { trigger: 'checkpoint' as const, prompt: '' },
      retrieval: { mode: 'llm' as const, count: 5, tokenBudget: 600 },
      inject: { label: 'Plans' }
    }
    const vectorCollection = {
      id: 'vec-events',
      shape: 'stream' as const,
      enabled: true,
      write: { trigger: 'checkpoint' as const, prompt: '' },
      retrieval: { mode: 'vector' as const, count: 5, tokenBudget: 600 },
      inject: { label: 'Vector events' }
    }
    const genWithBoth = {
      ...gen,
      settings: {
        ...gen.settings,
        memory: { collections: [llmCollection, vectorCollection] }
      }
    }
    const matching = makeEntry({
      id: 'v1',
      summary: 'A vector-tagged pikachu sighting',
      keywords: ['pikachu']
    })
    memoryStoreSvc.getEntries.mockReturnValue([matching])

    const r = memoryQuery.run(
      ctx,
      { gen: genWithBoth, query: 'pikachu' },
      meta(memoryQuery, 'n1', {})
    )
    const outputs = r.outputs as { block: string; rows: MemoryEntry[] }
    // getEntries called only once — for the vector collection, never for the llm one.
    expect(memoryStoreSvc.getEntries).toHaveBeenCalledTimes(1)
    expect(memoryStoreSvc.getEntries).toHaveBeenCalledWith('p1', 'c1', 'vec-events')
    expect(outputs.rows).toHaveLength(1)
    expect(outputs.block).toContain('A vector-tagged pikachu sighting')
  })
})
