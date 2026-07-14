import { describe, it, expect, vi, beforeEach } from 'vitest'

// WP0 (memory.maintain plan) — direct unit tests for the two shared cores extracted from
// history.recent + table.apply. The node-level characterization tests (memoryFillChain, table.apply
// paths) still pin the wrappers; these pin the helpers in isolation.

const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(),
  TableSqlError: class TableSqlError extends Error {}
}))
vi.mock('../../src/main/services/tableSql', () => mockSql)

const mockOps = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))
vi.mock('../../src/main/services/tableOpsService', () => mockOps)

const mockProgress = vi.hoisted(() => ({ advanceProgress: vi.fn() }))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

const mockFloor = vi.hoisted(() => ({ getAllFloors: vi.fn(() => []) }))
vi.mock('../../src/main/services/floorService', () => mockFloor)

// chatTemplate's resolvers aren't exercised here (callers pass a template straight in); stub so the
// module imports cleanly.
vi.mock('../../src/main/services/chatService', () => ({ getChatTableTemplateId: vi.fn(() => null) }))
vi.mock('../../src/main/services/tableTemplateService', () => ({ getTableTemplateById: vi.fn(() => null) }))

import { recentTranscript, applyTableEdit } from '../../src/main/services/nodes/builtin/memoryCore'
import { NodeRunFailure } from '../../src/main/services/nodes/types'
import { GenContext } from '../../src/main/services/generation/types'
import { TableTemplate } from '../../src/main/types/tableTemplate'

const floor = (user: string, response: string): unknown => ({
  user_message: { content: user },
  response: { content: response }
})

const genWith = (floors: unknown[], ids = { profileId: 'p', chatId: 'c' }): GenContext =>
  ({ ...ids, floors } as unknown as GenContext)

const template = (sqlNames: string[]): TableTemplate =>
  ({ tables: sqlNames.map((sqlName) => ({ sqlName })) } as unknown as TableTemplate)

beforeEach(() => {
  mockSql.applySqlBatch.mockReset().mockReturnValue({ applied: 2, changes: 3, statements: ['INSERT 1', 'INSERT 2'] })
  mockOps.appendOps.mockReset()
  mockOps.tryBeginTableWrite.mockReset().mockReturnValue(true)
  mockOps.endTableWrite.mockReset()
  mockProgress.advanceProgress.mockReset()
  mockFloor.getAllFloors.mockReset().mockReturnValue([{}, {}, {}]) // 3 floors on disk → currentFloor 2
})

describe('recentTranscript', () => {
  it('emits player action THEN reply per floor (both, default), last-N only', () => {
    const gen = genWith([floor('u0', 'r0'), floor('u1', 'r1'), floor('u2', 'r2')])
    expect(recentTranscript(gen, { lastNFloors: 2 })).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'r2' }
    ])
  })

  it('include narrows to one side; blank sides skipped; thinking stripped from replies', () => {
    const gen = genWith([floor('  ', '<think>plan</think>hello'), floor('act', '')])
    expect(recentTranscript(gen, { include: 'assistant' })).toEqual([
      { role: 'assistant', content: 'hello' } // floor 0 reply only; floor 1 reply blank → skipped
    ])
    expect(recentTranscript(gen, { include: 'user' })).toEqual([
      { role: 'user', content: 'act' } // floor 0 user blank → skipped
    ])
  })

  it('strips the model state/meta tag families (MVU/status/options/summary/…) from replies', () => {
    const reply =
      'prose before ' +
      '<UpdateVariable>{"x":1}</UpdateVariable>' +
      '<summary>s</summary>' +
      '<options>o</options>' +
      '<StatusPlaceHolderImpl/>' +
      '<JSONPatch>[]</JSONPatch>' +
      '<Analysis>a</Analysis>' +
      '<tucao>t</tucao>' +
      '<review>r</review>' +
      '<refine>f</refine>' +
      ' prose after'
    const gen = genWith([floor('u', reply)])
    const [, assistant] = recentTranscript(gen, { lastNFloors: 1 })
    expect(assistant.content).toContain('prose before')
    expect(assistant.content).toContain('prose after')
    for (const gone of ['UpdateVariable', 'summary', 'options', 'StatusPlaceHolderImpl', 'JSONPatch', 'Analysis', 'tucao', 'review', 'refine', '{"x":1}']) {
      expect(assistant.content).not.toContain(gone)
    }
  })
})

describe('applyTableEdit', () => {
  it('applies the batch, logs the executed statements to the last floor, returns the tally', () => {
    const gen = genWith([{}, {}]) // gen.floors.length 2 → op floor 1
    const r = applyTableEdit(gen, template(['summary']), '<sql>', {})
    expect(r).toEqual({ applied: 2, changes: 3 })
    expect(mockOps.appendOps).toHaveBeenCalledWith('p', 'c', 1, ['INSERT 1', 'INSERT 2'], 'maintain')
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled() // advanceProgress not requested
    expect(mockOps.endTableWrite).toHaveBeenCalledWith('c')
  })

  it('advances the progress pointer (all template tables → disk currentFloor) after success when asked', () => {
    applyTableEdit(genWith([{}]), template(['summary', 'log']), '<sql>', { advanceProgress: true })
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('p', 'c', ['summary', 'log'], 2)
  })

  it('throws class-B busy WITHOUT touching the write when a write is already in flight', () => {
    mockOps.tryBeginTableWrite.mockReturnValue(false)
    expect(() => applyTableEdit(genWith([{}]), template(['t']), '<sql>', {})).toThrow(NodeRunFailure)
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(mockOps.endTableWrite).not.toHaveBeenCalled() // guard failed before the try/finally
  })

  it('maps a TableSqlError to a class-B bad-sql failure and still releases the write lock', () => {
    mockSql.applySqlBatch.mockImplementation(() => {
      throw new mockSql.TableSqlError('syntax error near INSERT')
    })
    try {
      applyTableEdit(genWith([{}]), template(['t']), '<sql>', {})
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NodeRunFailure)
      expect((e as NodeRunFailure).kind).toBe('B')
      expect((e as NodeRunFailure).message).toContain('table.apply: syntax error near INSERT')
    }
    expect(mockOps.endTableWrite).toHaveBeenCalledWith('c')
  })

  it('prefixes thrown messages with the caller-supplied label', () => {
    mockOps.tryBeginTableWrite.mockReturnValue(false)
    try {
      applyTableEdit(genWith([{}]), template(['t']), '<sql>', { label: 'memory.maintain' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as NodeRunFailure).message).toContain('memory.maintain: a table write is already in flight')
    }
  })
})
