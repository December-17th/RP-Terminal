import { describe, it, expect, vi, beforeEach } from 'vitest'

// WP0 (memory.maintain plan) — direct unit tests for the two shared cores extracted from
// history.recent + table.apply. The node-level characterization tests (memoryFillChain, table.apply
// paths) still pin the wrappers; these pin the helpers in isolation.

const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(),
  // WS3: applyTableEdit's write-scope path validates + partitions through these (re-homed to tableSql).
  // Split the batch on ';' and classify each statement by its target table (INTO/UPDATE/FROM <name>).
  validateBatch: vi.fn((sql: string) =>
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ kind: 'insert', table: /\b(?:INTO|UPDATE|FROM)\s+(\w+)/i.exec(s)?.[1] ?? '?', sql: s }))
  ),
  partitionBySelected: (
    validated: Array<{ table: string; sql: string }>,
    selected: Set<string>
  ): { kept: string[]; dropped: string[] } => {
    const kept: string[] = []
    const dropped: string[] = []
    for (const v of validated) (selected.has(v.table) ? kept : dropped).push(v.sql)
    return { kept, dropped }
  },
  TableSqlError: class TableSqlError extends Error {}
}))
vi.mock('../../src/main/services/tableSql', () => mockSql)

const mockOps = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))
vi.mock('../../src/main/services/tableOpsService', () => mockOps)

const mockProgress = vi.hoisted(() => ({
  advanceProgress: vi.fn(),
  // P1 span-provenance: applyTableEdit reads per-table progress to compute a batch-wide from_floor.
  getProgress: vi.fn(() => ({}) as Record<string, number>),
  // dueTables resolves each table's cadence through the real semantics (-1 → global, 0 → null/never, N).
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

const mockFloor = vi.hoisted(() => ({ getAllFloors: vi.fn(() => []) }))
vi.mock('../../src/main/services/floorService', () => mockFloor)

// chatTemplate's resolvers aren't exercised here (callers pass a template straight in); stub so the
// module imports cleanly.
vi.mock('../../src/main/services/chatService', () => ({ getChatTableTemplateId: vi.fn(() => null) }))
vi.mock('../../src/main/services/tableTemplateService', () => ({ getTableTemplateById: vi.fn(() => null) }))

import { recentTranscript, applyTableEdit, dueTables } from '../../src/main/services/nodes/builtin/memoryCore'
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
  mockProgress.getProgress.mockReset().mockReturnValue({}) // no prior progress → from_floor clamps to 0
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
    // 6th arg = the batch-wide span start: no prior progress ({}) → min(-1+1)=0 clamped to 0.
    expect(mockOps.appendOps).toHaveBeenCalledWith('p', 'c', 1, ['INSERT 1', 'INSERT 2'], 'maintain', 0)
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

  // WS3 — write-scope filtering + scoped advance. `writeScope` drops out-of-scope statements before the
  // apply; `advanceTables` overrides which pointers move (default = all template tables, pre-WS3).
  it('drops out-of-scope statements before apply and reports the dropped count', () => {
    mockSql.applySqlBatch.mockReturnValue({ applied: 1, changes: 1, statements: ['INSERT INTO a VALUES (1)'] })
    const r = applyTableEdit(
      genWith([{}]),
      template(['a', 'b']),
      'INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)',
      { writeScope: ['a'] }
    )
    // Only the in-scope statement reaches applySqlBatch; the 'b' write is dropped (counted).
    expect(mockSql.applySqlBatch).toHaveBeenCalledWith('p', 'c', expect.anything(), 'INSERT INTO a VALUES (1)', {
      maxChanges: undefined
    })
    expect(r).toEqual({ applied: 1, changes: 1, dropped: 1 })
  })

  it('an all-dropped batch applies nothing but STILL advances the scoped pointers', () => {
    applyTableEdit(genWith([{}]), template(['a', 'b']), 'INSERT INTO b VALUES (2)', {
      writeScope: ['a'],
      advanceProgress: true,
      advanceTables: ['a']
    })
    // Nothing in scope → no apply, no op-log; the pass still ran for 'a', so its pointer advances.
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(mockOps.appendOps).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('p', 'c', ['a'], 2)
  })

  it('advanceTables scopes WHICH pointers advance (only the due subset, not all template tables)', () => {
    applyTableEdit(genWith([{}]), template(['a', 'b', 'c']), '<sql>', {
      advanceProgress: true,
      advanceTables: ['b']
    })
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('p', 'c', ['b'], 2)
  })
})

describe('dueTables — the auto due-set gate (WS3 / D9)', () => {
  const tmpl = (defs: Array<{ sqlName: string; updateFrequency: number }>): TableTemplate =>
    ({ tables: defs } as unknown as TableTemplate)

  it('a table is due when currentFloor - last >= resolved freq', () => {
    // freq 3; last 2 → 5-2=3 >= 3 → due. last 3 → 5-3=2 < 3 → not due.
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 3 }]), { a: 2 }, 5, 3)).toEqual(['a'])
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 3 }]), { a: 3 }, 5, 3)).toEqual([])
  })

  it('exactly at the threshold is due (>=, not >)', () => {
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 2 }]), { a: 1 }, 3, 3)).toEqual(['a'])
  })

  it('a never-processed table (absent → last -1) is due once currentFloor+1 >= freq', () => {
    // freq 3: floor 1 → 1-(-1)=2 < 3 → not due; floor 2 → 3 >= 3 → due.
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 3 }]), {}, 1, 3)).toEqual([])
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 3 }]), {}, 2, 3)).toEqual(['a'])
  })

  it('updateFrequency 0 → 手动维护, never auto-due', () => {
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 0 }]), {}, 99, 3)).toEqual([])
  })

  it('updateFrequency -1 resolves to the global default', () => {
    // global default 3: never-processed, floor 2 → due; floor 1 → not.
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: -1 }]), {}, 2, 3)).toEqual(['a'])
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: -1 }]), {}, 1, 3)).toEqual([])
  })

  it('returns the due subset in template order (mixed cadences)', () => {
    const t = tmpl([
      { sqlName: 'fast', updateFrequency: 1 },
      { sqlName: 'slow', updateFrequency: 10 },
      { sqlName: 'off', updateFrequency: 0 }
    ])
    // floor 4, all never-processed: fast 5>=1 due; slow 5>=10 no; off never.
    expect(dueTables(t, {}, 4, 3)).toEqual(['fast'])
  })

  it('an empty chat (currentFloor -1) yields no due tables', () => {
    expect(dueTables(tmpl([{ sqlName: 'a', updateFrequency: 1 }]), {}, -1, 3)).toEqual([])
  })
})
