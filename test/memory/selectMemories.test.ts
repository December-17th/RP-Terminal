import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB-backed reader so we can drive selectMemories' cross-collection orchestration
// (the real getEntries hits the no-op better-sqlite3 stub and always returns []).
vi.mock('../../src/main/services/memoryStore', () => ({ getEntries: vi.fn() }))

import { selectMemories } from '../../src/main/services/retrievalService'
import { getEntries } from '../../src/main/services/memoryStore'
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

beforeEach(() => vi.mocked(getEntries).mockReset())

describe('selectMemories (orchestration)', () => {
  it('recalls from an enabled keyword stream collection', () => {
    vi.mocked(getEntries).mockReturnValue([
      entry({ id: 'a', summary: 'the duel happened', keywords: ['duel'] })
    ])
    const r = selectMemories('p', 'c', 'tell me about the duel', settingsWith([coll()]))
    expect(r.block).toBe('[Earlier events]\n- the duel happened')
    expect(r.rows.map((x) => x.id)).toEqual(['a'])
  })

  it('skips disabled, entity-shaped, and non-keyword collections (no reads)', () => {
    const collections = [
      coll({ id: 'events', enabled: false }), // disabled
      coll({ id: 'characters', shape: 'entity' }), // entity (deferred)
      coll({ id: 'vec', retrieval: { mode: 'vector', count: 5, tokenBudget: 600 } }) // non-keyword
    ]
    const r = selectMemories('p', 'c', 'x', settingsWith(collections))
    expect(r).toEqual({ block: '', rows: [] })
    expect(getEntries).not.toHaveBeenCalled()
  })

  it('concatenates blocks and aggregates rows across multiple stream collections', () => {
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
    const r = selectMemories('p', 'c', 'scan', settingsWith(collections))
    expect(r.block).toBe('[Events]\n- event one\n\n[Facts]\n- fact one')
    expect(r.rows.map((x) => x.id).sort()).toEqual(['e1', 'f1'])
  })

  it('caps the total tail at memory.max_tokens, dropping later collections', () => {
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
    const r = selectMemories('p', 'c', 'scan', settings)
    expect(r.rows.map((x) => x.id)).toEqual(['e1']) // first block kept, second over budget
  })

  it('is a no-op when memory is disabled', () => {
    const r = selectMemories('p', 'c', 'scan', {
      memory: { enabled: false }
    } as unknown as Settings)
    expect(r).toEqual({ block: '', rows: [] })
    expect(getEntries).not.toHaveBeenCalled()
  })

  it('always-includes in-scope entity sheets from an entity collection', () => {
    vi.mocked(getEntries).mockImplementation((_p, _c, id) =>
      id === 'characters'
        ? [
            entry({
              id: 'ay',
              collection: 'characters',
              entityKey: 'Ayaka',
              entities: ['the maiden'],
              summary: 'role: guard'
            })
          ]
        : []
    )
    const collections = [
      coll({
        id: 'characters',
        shape: 'entity',
        retrieval: { mode: 'always', count: 6, tokenBudget: 800 },
        inject: { label: 'Characters' }
      })
    ]
    const r = selectMemories('p', 'c', 'Ayaka greets you warmly', settingsWith(collections))
    expect(r.block).toBe('[Characters]\n- Ayaka: role: guard')
    expect(r.rows.map((x) => x.id)).toEqual(['ay'])
  })

  it('skips entity sheets whose entity is not in scope this turn', () => {
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
    expect(selectMemories('p', 'c', 'nobody is here', settingsWith(collections))).toEqual({
      block: '',
      rows: []
    })
  })
})
