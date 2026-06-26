import { describe, it, expect } from 'vitest'
import {
  compactionRange,
  parseMemories,
  floorsToTranscript
} from '../../src/main/services/compactionService'

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
