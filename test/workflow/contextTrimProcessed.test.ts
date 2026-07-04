import { describe, it, expect, vi, beforeEach } from 'vitest'

// context.trimProcessed (agent-packs plan WP2.4): the async-memory pack's INLINE history trimmer.
// Given a Context, it slices `gen.floors` to the floors AFTER the committed maintenance progress
// pointer (tableProgressService.getProgress) — the safe pointer being the MIN last-processed floor
// over the chat's template tables. Fail-soft: no template / never-processed table / pointer < 0 →
// NOTHING trimmed (carry the full history — ADR 0003). NEVER trims past the pointer.
//
// The two sqlite-backed reads it makes are mocked (chatService template id, tableTemplateService,
// tableProgressService) following tableNodes.test's idiom; the trim MATH itself is the real node.

const chatSvc = vi.hoisted(() => ({ getChatTableTemplateId: vi.fn() }))
vi.mock('../../src/main/services/chatService', () => chatSvc)

const templateSvc = vi.hoisted(() => ({ getTableTemplateById: vi.fn() }))
vi.mock('../../src/main/services/tableTemplateService', () => templateSvc)

const progressSvc = vi.hoisted(() => ({ getProgress: vi.fn() }))
vi.mock('../../src/main/services/tableProgressService', () => progressSvc)

import { contextTrimProcessed } from '../../src/main/services/nodes/builtin/contextNodes'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'

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

/** A minimal floor carrying its index in a marker so a slice is easy to assert. */
const floor = (
  i: number
): { idx: number; user_message: { content: string }; response: { content: string } } => ({
  idx: i,
  user_message: { content: `u${i}` },
  response: { content: `a${i}` }
})

/** A minimal GenContext with N floors (only the fields the node reads matter). */
const genWith = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const floors = Array.from({ length: n }, (_, i) => floor(i))
  return {
    profileId: 'p1',
    chatId: 'c1',
    userAction: 'go',
    floors,
    lastFloor: floors[floors.length - 1],
    ...extra
  }
}

const template = (...sqlNames: string[]) => ({
  tables: sqlNames.map((sqlName) => ({ sqlName, updateFrequency: 1 }))
})

const run = (gen: Record<string, unknown>, config: Record<string, unknown> = {}) =>
  contextTrimProcessed.run(ctx, { gen }, meta(contextTrimProcessed, 'trim', config)) as {
    outputs: { gen: { floors: Array<{ idx: number }>; lastFloor: { idx: number } } }
  }

beforeEach(() => {
  chatSvc.getChatTableTemplateId.mockReset()
  templateSvc.getTableTemplateById.mockReset()
  progressSvc.getProgress.mockReset()
  chatSvc.getChatTableTemplateId.mockReturnValue('tmpl')
  templateSvc.getTableTemplateById.mockReturnValue(template('summary'))
  progressSvc.getProgress.mockReturnValue({})
})

describe('context.trimProcessed descriptor', () => {
  it('gen:Context in → gen:Context out (INLINE-shaped, like context.refresh)', () => {
    expect(contextTrimProcessed.type).toBe('context.trimProcessed')
    expect(contextTrimProcessed.inputs).toEqual([{ name: 'gen', type: 'Context' }])
    expect(contextTrimProcessed.outputs).toEqual([{ name: 'gen', type: 'Context' }])
  })
})

describe('trim math', () => {
  it('pointer at floor K → floors ≤ K dropped, > K kept, lastFloor re-pinned', () => {
    // 6 floors (idx 0..5); table processed through floor 2 → keep floors 3,4,5.
    progressSvc.getProgress.mockReturnValue({ summary: 2 })
    const r = run(genWith(6))
    expect(r.outputs.gen.floors.map((f) => f.idx)).toEqual([3, 4, 5])
    expect(r.outputs.gen.lastFloor.idx).toBe(5)
  })

  it('MIN over multiple tables is the safe pointer (never trims past any table)', () => {
    // Two tables: one processed to 4, one only to 1 → min = 1 → keep floors 2..5.
    templateSvc.getTableTemplateById.mockReturnValue(template('summary', 'chars'))
    progressSvc.getProgress.mockReturnValue({ summary: 4, chars: 1 })
    const r = run(genWith(6))
    expect(r.outputs.gen.floors.map((f) => f.idx)).toEqual([2, 3, 4, 5])
  })

  it('config.table narrows the pointer to ONE table (ignores the others)', () => {
    templateSvc.getTableTemplateById.mockReturnValue(template('summary', 'chars'))
    progressSvc.getProgress.mockReturnValue({ summary: 4, chars: 1 })
    // Watch only `summary` (processed to 4) → keep floor 5 alone.
    const r = run(genWith(6), { table: 'summary' })
    expect(r.outputs.gen.floors.map((f) => f.idx)).toEqual([5])
  })
})

describe('fail-soft (NEVER trim past the pointer)', () => {
  it('a never-processed table (absent from progress) pins the pointer to -1 → full history', () => {
    templateSvc.getTableTemplateById.mockReturnValue(template('summary', 'chars'))
    progressSvc.getProgress.mockReturnValue({ summary: 4 }) // `chars` absent → -1 → min -1 → no trim
    const r = run(genWith(6))
    expect(r.outputs.gen.floors.map((f) => f.idx)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('no template assigned → full history (nothing is "processed")', () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    const r = run(genWith(4))
    expect(r.outputs.gen.floors).toHaveLength(4)
  })

  it('empty progress store (compaction never landed) → full history', () => {
    progressSvc.getProgress.mockReturnValue({})
    const r = run(genWith(4))
    expect(r.outputs.gen.floors).toHaveLength(4)
  })

  it('returns the SAME context object when nothing is dropped (no needless clone)', () => {
    const gen = genWith(4)
    const r = contextTrimProcessed.run(ctx, { gen }, meta(contextTrimProcessed, 'trim')) as {
      outputs: { gen: unknown }
    }
    expect(r.outputs.gen).toBe(gen)
  })
})

describe('edge cases', () => {
  it('empty history → unchanged (no throw)', () => {
    progressSvc.getProgress.mockReturnValue({ summary: 2 })
    const gen = genWith(0)
    const r = contextTrimProcessed.run(ctx, { gen }, meta(contextTrimProcessed, 'trim')) as {
      outputs: { gen: { floors: unknown[] } }
    }
    expect(r.outputs.gen.floors).toHaveLength(0)
  })

  it('pointer beyond the history → empty tail (clamps, no throw)', () => {
    // Only 3 floors (idx 0..2) but pointer says processed through floor 9 → everything trimmed.
    progressSvc.getProgress.mockReturnValue({ summary: 9 })
    const r = run(genWith(3))
    expect(r.outputs.gen.floors).toEqual([])
    expect(r.outputs.gen.lastFloor).toBeUndefined()
  })

  it('pointer at the last floor → everything trimmed to empty', () => {
    progressSvc.getProgress.mockReturnValue({ summary: 5 }) // last idx is 5
    const r = run(genWith(6))
    expect(r.outputs.gen.floors).toEqual([])
  })

  it('named table not in the template → full history (no trim)', () => {
    templateSvc.getTableTemplateById.mockReturnValue(template('summary'))
    progressSvc.getProgress.mockReturnValue({ summary: 3 })
    const r = run(genWith(6), { table: 'does-not-exist' })
    expect(r.outputs.gen.floors).toHaveLength(6)
  })
})
