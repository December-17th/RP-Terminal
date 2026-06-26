import { describe, it, expect } from 'vitest'
import {
  keywordScore,
  selectFromEntries,
  formatBlock,
  entityInScope,
  selectEntitiesInScope,
  formatEntityBlock,
  selectMemories
} from '../../src/main/services/retrievalService'
import type { MemoryEntry } from '../../src/main/services/memoryStore'
import type { Settings } from '../../src/main/types/models'

const E = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: Math.random().toString(36).slice(2),
  chatId: 'c',
  collection: 'events',
  entityKey: null,
  summary: 'summary',
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

describe('keywordScore', () => {
  it('is 0 with no keywords', () => {
    expect(keywordScore(E({ keywords: [] }), 'the dragon')).toBe(0)
  })
  it('counts case-insensitive substring hits', () => {
    expect(
      keywordScore(E({ keywords: ['Dragon', 'Castle', 'ship'] }), 'the DRAGON near a castle')
    ).toBe(2)
  })
})

describe('selectFromEntries', () => {
  it('reserves the most-recent slots regardless of keyword match', () => {
    const entries = [E({ id: 'r1' }), E({ id: 'r2' }), E({ id: 'old', keywords: ['zzz'] })]
    const chosen = selectFromEntries(entries, 'nothing relevant', 5, 0)
    expect(chosen.map((e) => e.id)).toEqual(['r1', 'r2'])
  })

  it('always includes pinned entries even when old', () => {
    const entries = [E({ id: 'r1' }), E({ id: 'r2' }), E({ id: 'p', pinned: true })]
    const chosen = selectFromEntries(entries, 'x', 5, 0)
    expect(chosen.map((e) => e.id)).toContain('p')
  })

  it('fills remaining slots by keyword score then salience', () => {
    const entries = [
      E({ id: 'r1' }),
      E({ id: 'r2' }),
      E({ id: 'k2', keywords: ['dragon'], salience: 0.5 }),
      E({ id: 'k1', keywords: ['dragon', 'castle'], salience: 0.1 })
    ]
    const chosen = selectFromEntries(entries, 'the dragon attacks the castle', 5, 0)
    expect(chosen.map((e) => e.id)).toEqual(['r1', 'r2', 'k1', 'k2'])
  })

  it('caps the result at count', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' }), E({ id: 'd' })]
    expect(selectFromEntries(entries, 'x', 2, 0).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('dedupes an entry that is both recent and keyword-matched', () => {
    const entries = [E({ id: 'r1', keywords: ['hit'] }), E({ id: 'r2' })]
    const chosen = selectFromEntries(entries, 'a hit lands', 5, 0)
    expect(chosen.filter((e) => e.id === 'r1')).toHaveLength(1)
  })

  it('trims to the token budget but keeps at least the first', () => {
    const long = 'x '.repeat(1000)
    const entries = [E({ id: 'a', summary: long }), E({ id: 'b', summary: long })]
    const chosen = selectFromEntries(entries, 'x', 5, 10)
    expect(chosen.map((e) => e.id)).toEqual(['a'])
  })
})

describe('formatBlock', () => {
  it('returns empty string for no entries', () => {
    expect(formatBlock('Earlier', [])).toBe('')
  })
  it('formats a labelled bullet list', () => {
    expect(formatBlock('Earlier events', [E({ summary: 'a' }), E({ summary: 'b' })])).toBe(
      '[Earlier events]\n- a\n- b'
    )
  })
})

describe('entityInScope', () => {
  it('matches the entity key or an alias in the scan text (case-insensitive)', () => {
    const e = E({ entityKey: 'Ayaka', entities: ['the swordmaiden'] })
    expect(entityInScope(e, 'we meet AYAKA at dawn')).toBe(true)
    expect(entityInScope(e, 'the Swordmaiden draws her blade')).toBe(true)
    expect(entityInScope(e, 'nothing relevant here')).toBe(false)
  })
  it('ignores 1-char names to avoid false matches', () => {
    expect(entityInScope(E({ entityKey: 'X', entities: [] }), 'the box')).toBe(false)
  })
})

describe('selectEntitiesInScope', () => {
  it('returns only in-scope entities, capped at count', () => {
    const a = E({ id: 'a', entityKey: 'Ayaka', summary: 'guard' })
    const b = E({ id: 'b', entityKey: 'Borin', summary: 'smith' })
    const chosen = selectEntitiesInScope([a, b], 'Ayaka and Borin talk', 1, 0)
    expect(chosen).toHaveLength(1)
    expect(chosen[0].id).toBe('a')
  })
  it('excludes entities not mentioned this turn', () => {
    expect(
      selectEntitiesInScope([E({ entityKey: 'Ayaka' })], 'someone else entirely', 5, 0)
    ).toEqual([])
  })
})

describe('formatEntityBlock', () => {
  it('renders "name: summary" lines', () => {
    expect(
      formatEntityBlock('Characters', [E({ entityKey: 'Ayaka', summary: 'role: guard' })])
    ).toBe('[Characters]\n- Ayaka: role: guard')
  })
  it('is empty for no entries', () => {
    expect(formatEntityBlock('Characters', [])).toBe('')
  })
})

describe('selectMemories', () => {
  it('is a no-op when memory is disabled (never touches the DB)', () => {
    const settings = { memory: { enabled: false } } as unknown as Settings
    expect(selectMemories('p', 'c', 'scan', settings)).toEqual({ block: '', rows: [] })
  })

  it('returns an empty block when a collection has no stored rows', () => {
    // getEntries hits the no-op DB stub → [] → empty block, exercising the loop path.
    const settings = {
      memory: {
        enabled: true,
        collections: [
          {
            id: 'events',
            shape: 'stream',
            enabled: true,
            write: { trigger: 'checkpoint', prompt: '' },
            retrieval: { mode: 'keyword', count: 5, tokenBudget: 600 },
            inject: { label: 'Earlier' }
          }
        ]
      }
    } as unknown as Settings
    expect(selectMemories('p', 'c', 'scan', settings)).toEqual({ block: '', rows: [] })
  })
})
