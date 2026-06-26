import { describe, it, expect } from 'vitest'
import {
  compactionRange,
  parseMemories,
  parseCompaction,
  buildExtractionPrompt,
  entitySummary,
  floorsToTranscript
} from '../../src/main/services/compactionService'
import type { MemoryCollection } from '../../src/main/types/models'

const COLLS: MemoryCollection[] = [
  {
    id: 'events',
    shape: 'stream',
    enabled: true,
    write: { trigger: 'checkpoint', prompt: 'narrative events' },
    retrieval: { mode: 'keyword', count: 5, tokenBudget: 600 },
    inject: { label: 'Events' }
  },
  {
    id: 'characters',
    shape: 'entity',
    enabled: true,
    write: { trigger: 'checkpoint', prompt: 'character updates' },
    retrieval: { mode: 'always', count: 6, tokenBudget: 800 },
    inject: { label: 'Characters' }
  }
]

describe('compactionRange', () => {
  // keepRecent=10, checkpointTurns=6 (the defaults)
  it('is null until a full batch has aged past the keep-recent window', () => {
    expect(compactionRange(15, -1, 10, 6)).toBeNull() // end=5, 5-0 < 6
  })

  it('returns the oldest batch once enough floors exist', () => {
    expect(compactionRange(16, -1, 10, 6)).toEqual({ start: 0, end: 6 }) // floors 0..5
  })

  it('advances from the last compacted floor (no double compaction)', () => {
    // Just compacted through floor 5; nothing new past the window yet.
    expect(compactionRange(16, 5, 10, 6)).toBeNull()
    // 6 more floors later, the next batch is available.
    expect(compactionRange(22, 5, 10, 6)).toEqual({ start: 6, end: 12 })
  })

  it('respects a larger keep_recent window', () => {
    expect(compactionRange(20, -1, 20, 6)).toBeNull() // end=0
    expect(compactionRange(30, -1, 20, 6)).toEqual({ start: 0, end: 10 })
  })
})

describe('parseMemories', () => {
  it('parses the {"memories":[…]} envelope', () => {
    const out = parseMemories('{"memories":[{"summary":"X fell","keywords":["X"],"salience":0.7}]}')
    expect(out).toEqual([{ summary: 'X fell', keywords: ['X'], salience: 0.7 }])
  })

  it('parses a bare array', () => {
    expect(parseMemories('[{"summary":"a"}]')).toEqual([
      { summary: 'a', keywords: [], salience: 1 }
    ])
  })

  it('extracts JSON from ```json fences and surrounding prose', () => {
    const fenced = parseMemories('Sure!\n```json\n{"memories":[{"summary":"b"}]}\n```\nDone.')
    expect(fenced).toEqual([{ summary: 'b', keywords: [], salience: 1 }])
  })

  it('drops entries without a non-empty summary and filters non-string keywords', () => {
    const out = parseMemories(
      '{"memories":[{"summary":"  "},{"summary":"ok","keywords":["a",5,"b"]}]}'
    )
    expect(out).toEqual([{ summary: 'ok', keywords: ['a', 'b'], salience: 1 }])
  })

  it('clamps salience to [0,1] and defaults a missing/invalid one to 1', () => {
    const out = parseMemories('[{"summary":"x","salience":5},{"summary":"y","salience":"nope"}]')
    expect(out).toEqual([
      { summary: 'x', keywords: [], salience: 1 },
      { summary: 'y', keywords: [], salience: 1 }
    ])
  })

  it('returns [] on non-JSON / empty replies (caller defers)', () => {
    expect(parseMemories('the model refused')).toEqual([])
    expect(parseMemories('')).toEqual([])
    expect(parseMemories('{ broken')).toEqual([])
  })
})

describe('floorsToTranscript', () => {
  const floor = (n: number, user: string, resp: string): any => ({
    floor: n,
    chat_id: 'c',
    timestamp: 't',
    user_message: { content: user, timestamp: 't' },
    response: { content: resp, model: '', provider: '' },
    events: [],
    variables: {}
  })

  it('renders User/Assistant turns and strips <thinking>', () => {
    const txt = floorsToTranscript([floor(0, 'hello', '<thinking>plan</thinking>The hero waves.')])
    expect(txt).toContain('User: hello')
    expect(txt).toContain('Assistant: The hero waves.')
    expect(txt).not.toContain('plan')
  })

  it('skips the blank user side of an opening greeting', () => {
    const txt = floorsToTranscript([floor(0, '', 'Welcome, traveler.')])
    expect(txt).toBe('Assistant: Welcome, traveler.')
  })

  it('joins multiple floors with a blank line', () => {
    const txt = floorsToTranscript([floor(0, 'a', 'b'), floor(1, 'c', 'd')])
    expect(txt).toBe('User: a\nAssistant: b\n\nUser: c\nAssistant: d')
  })
})

describe('parseCompaction', () => {
  it('splits stream and entity items by collection id', () => {
    const raw =
      '{"events":[{"summary":"the duel"}],"characters":[{"name":"Ayaka","aliases":["maiden"],"fields":{"role":"guard"},"note":"met"}]}'
    const out = parseCompaction(raw, COLLS)
    expect(out.streams.events).toEqual([{ summary: 'the duel', keywords: [], salience: 1 }])
    expect(out.entities.characters).toEqual([
      { name: 'Ayaka', aliases: ['maiden'], fields: { role: 'guard' }, note: 'met' }
    ])
  })

  it('drops malformed items (no summary / no name) and missing keys', () => {
    const out = parseCompaction(
      '{"events":[{"no":"summary"}],"characters":[{"aliases":["x"]}]}',
      COLLS
    )
    expect(out.streams.events).toEqual([])
    expect(out.entities.characters).toEqual([])
  })

  it('coerces numeric/boolean entity field values to strings and drops empty ones', () => {
    const out = parseCompaction(
      '{"characters":[{"name":"X","fields":{"level":7,"alive":true,"x":""}}]}',
      COLLS
    )
    expect(out.entities.characters[0].fields).toEqual({ level: '7', alive: 'true' })
  })

  it('returns empty maps + parsed:false on non-JSON', () => {
    expect(parseCompaction('the model refused', COLLS)).toEqual({
      parsed: false,
      streams: {},
      entities: {}
    })
  })

  it('reports parsed:true for a valid-but-empty object (model found nothing)', () => {
    const out = parseCompaction('{"events":[]}', COLLS)
    expect(out.parsed).toBe(true)
    expect(out.streams.events).toEqual([])
  })
})

describe('buildExtractionPrompt', () => {
  it('describes the per-collection JSON shapes + the no-numbers rule', () => {
    const p = buildExtractionPrompt(COLLS)
    expect(p).toContain('"events": [{"summary"')
    expect(p).toContain('"characters": [{"name"')
    expect(p).toContain('narrative events') // the collection's own prompt is appended
    expect(p).toContain('Do NOT restate numeric')
  })
})

describe('entitySummary', () => {
  it('renders the fields digest, else the last note, else empty', () => {
    expect(entitySummary({ aliases: [], fields: { role: 'guard', mood: 'wary' }, log: [] })).toBe(
      'role: guard; mood: wary'
    )
    expect(entitySummary({ aliases: [], fields: {}, log: [{ turn: '1', note: 'arrived' }] })).toBe(
      'arrived'
    )
    expect(entitySummary({ aliases: [], fields: {}, log: [] })).toBe('')
  })
})
