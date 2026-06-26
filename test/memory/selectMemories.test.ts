import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB-backed reader so we can drive selectMemories' cross-collection orchestration; keep the
// real cosine but mock utilityEmbed so vector tests don't hit the network.
vi.mock('../../src/main/services/memoryStore', () => ({ getEntries: vi.fn() }))
vi.mock('../../src/main/services/embeddingService', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/services/embeddingService')>()
  return { ...actual, utilityEmbed: vi.fn() }
})

import { selectMemories } from '../../src/main/services/retrievalService'
import { getEntries } from '../../src/main/services/memoryStore'
import { utilityEmbed } from '../../src/main/services/embeddingService'
import type { MemoryEntry } from '../../src/main/services/memoryStore'
import type { Settings } from '../../src/main/types/models'

const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: Math.random().toString(36).slice(2),
  chatId: 'c',
  collection: 'events',
  entityKey: null,
  summary: 'sum',
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

const coll = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'events',
  shape: 'stream',
  enabled: true,
  write: { trigger: 'checkpoint', prompt: '' },
  retrieval: { mode: 'keyword', count: 5, tokenBudget: 600 },
  inject: { label: 'Earlier events' },
  ...over
})

const settingsWith = (collections: unknown[]): Settings =>
  ({ memory: { enabled: true, collections, max_tokens: 600 } }) as unknown as Settings

beforeEach(() => {
  vi.mocked(getEntries).mockReset()
  vi.mocked(utilityEmbed).mockReset()
})

describe('selectMemories (orchestration)', () => {
  it('recalls from an enabled keyword stream collection', async () => {
    vi.mocked(getEntries).mockReturnValue([
      entry({ id: 'a', summary: 'the duel happened', keywords: ['duel'] })
    ])
    const r = await selectMemories('p', 'c', 'tell me about the duel', settingsWith([coll()]))
    expect(r.block).toBe('[Earlier events]\n- the duel happened')
    expect(r.rows.map((x) => x.id)).toEqual(['a'])
  })

  it('skips disabled, entity-shaped-without-always, and llm collections (no reads)', async () => {
    const collections = [
      coll({ id: 'events', enabled: false }), // disabled
      coll({ id: 'characters', shape: 'entity' }), // entity but mode keyword (not 'always')
      coll({ id: 'llm', retrieval: { mode: 'llm', count: 5, tokenBudget: 600 } }) // deferred mode
    ]
    const r = await selectMemories('p', 'c', 'x', settingsWith(collections))
    expect(r).toEqual({ block: '', rows: [] })
    expect(getEntries).not.toHaveBeenCalled()
  })

  it('concatenates blocks and aggregates rows across multiple stream collections', async () => {
    vi.mocked(getEntries).mockImplementation((_p, _c, id) =>
      id === 'events'
        ? [entry({ id: 'e1', summary: 'event one' })]
        : id === 'facts'
          ? [entry({ id: 'f1', summary: 'fact one', collection: 'facts' })]
          : []
    )
    const collections = [
      coll({ id: 'events', inject: { label: 'Events' } }),
      coll({ id: 'facts', inject: { label: 'Facts' } })
    ]
    const r = await selectMemories('p', 'c', 'scan', settingsWith(collections))
    expect(r.block).toBe('[Events]\n- event one\n\n[Facts]\n- fact one')
    expect(r.rows.map((x) => x.id).sort()).toEqual(['e1', 'f1'])
  })

  it('caps the total tail at memory.max_tokens, dropping later collections', async () => {
    vi.mocked(getEntries).mockImplementation((_p, _c, id) =>
      id === 'events'
        ? [entry({ id: 'e1', summary: 'x'.repeat(200) })]
        : id === 'facts'
          ? [entry({ id: 'f1', collection: 'facts', summary: 'y'.repeat(200) })]
          : []
    )
    const settings = settingsWith([
      coll({ id: 'events', inject: { label: 'Events' } }),
      coll({ id: 'facts', inject: { label: 'Facts' } })
    ])
    settings.memory.max_tokens = 30 // ~one ~52-token block fits; the second is dropped
    const r = await selectMemories('p', 'c', 'scan', settings)
    expect(r.rows.map((x) => x.id)).toEqual(['e1']) // first block kept, second over budget
  })

  it('bounds even the first collection by max_tokens, despite tokenBudget:0', async () => {
    // Two regressions at once: the first block used to be exempt from the global cap, and a
    // collection with tokenBudget:0 used to bypass per-collection trimming entirely. With a tiny
    // max_tokens and huge summaries, only the top line should survive.
    const huge = 'word '.repeat(100)
    vi.mocked(getEntries).mockReturnValue([
      entry({ id: 'a', summary: huge }),
      entry({ id: 'b', summary: huge })
    ])
    const settings = settingsWith([
      coll({ retrieval: { mode: 'keyword', count: 5, tokenBudget: 0 } })
    ])
    settings.memory.max_tokens = 10
    const r = await selectMemories('p', 'c', 'scan', settings)
    expect(r.rows.map((x) => x.id)).toEqual(['a']) // first kept, second over the global cap
  })

  it('is a no-op when memory is disabled', async () => {
    const r = await selectMemories('p', 'c', 'scan', {
      memory: { enabled: false }
    } as unknown as Settings)
    expect(r).toEqual({ block: '', rows: [] })
    expect(getEntries).not.toHaveBeenCalled()
  })

  it('always-includes in-scope entity sheets from an entity collection', async () => {
    vi.mocked(getEntries).mockReturnValue([
      entry({
        id: 'ay',
        collection: 'characters',
        entityKey: 'Ayaka',
        entities: ['the maiden'],
        summary: 'role: guard'
      })
    ])
    const collections = [
      coll({
        id: 'characters',
        shape: 'entity',
        retrieval: { mode: 'always', count: 6, tokenBudget: 800 },
        inject: { label: 'Characters' }
      })
    ]
    const r = await selectMemories('p', 'c', 'Ayaka greets you warmly', settingsWith(collections))
    expect(r.block).toBe('[Characters]\n- Ayaka: role: guard')
    expect(r.rows.map((x) => x.id)).toEqual(['ay'])
  })

  it('skips entity sheets whose entity is not in scope this turn', async () => {
    vi.mocked(getEntries).mockReturnValue([
      entry({ id: 'ay', collection: 'characters', entityKey: 'Ayaka', summary: 'role: guard' })
    ])
    const collections = [
      coll({
        id: 'characters',
        shape: 'entity',
        retrieval: { mode: 'always', count: 6, tokenBudget: 800 },
        inject: { label: 'Characters' }
      })
    ]
    const r = await selectMemories('p', 'c', 'nobody is here', settingsWith(collections))
    expect(r).toEqual({ block: '', rows: [] })
  })

  it('vector mode ranks by cosine over embeddings (embeds the scan text once)', async () => {
    vi.mocked(getEntries).mockReturnValue([
      entry({ id: 'r1' }),
      entry({ id: 'r2' }),
      entry({ id: 'near', summary: 'aligned', embedding: [1, 0, 0] }),
      entry({ id: 'far', summary: 'orthogonal', embedding: [0, 1, 0] })
    ])
    vi.mocked(utilityEmbed).mockResolvedValue({ model: 'm', vectors: [[1, 0, 0]] })
    const settings = {
      memory: {
        enabled: true,
        embedding_api_preset_id: 'emb',
        max_tokens: 600,
        collections: [coll({ retrieval: { mode: 'vector', count: 5, tokenBudget: 600 } })]
      }
    } as unknown as Settings
    const r = await selectMemories('p', 'c', 'q', settings)
    expect(utilityEmbed).toHaveBeenCalledTimes(1)
    expect(r.rows.map((x) => x.id)).toContain('near') // cosine 1 surfaces it beyond the recent slots
    expect(r.rows.map((x) => x.id)).not.toContain('far') // cosine 0 → filtered out
  })

  it('falls back to keyword when a vector collection has no embedding connection', async () => {
    vi.mocked(getEntries).mockReturnValue([
      entry({ id: 'kw', summary: 'the duel', keywords: ['duel'] })
    ])
    const settings = {
      memory: {
        enabled: true,
        max_tokens: 600, // no embedding_api_preset_id
        collections: [coll({ retrieval: { mode: 'vector', count: 5, tokenBudget: 600 } })]
      }
    } as unknown as Settings
    const r = await selectMemories('p', 'c', 'about the duel', settings)
    expect(utilityEmbed).not.toHaveBeenCalled()
    expect(r.rows.map((x) => x.id)).toContain('kw')
  })
})
