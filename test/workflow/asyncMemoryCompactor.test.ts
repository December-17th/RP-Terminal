import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ComposeFragment } from '../../src/shared/workflow/compose'
import {
  ASYNC_MEMORY_FRAGMENT,
  ASYNC_MEMORY_PACK_ID,
  ASYNC_MEMORY_BACKLOG_N
} from '../../src/main/services/nodes/builtin/asyncMemoryPack'

// WP2.4 — the REAL headless compactor path for the async-memory pack. Drives evaluateTriggers against
// the ACTUAL fragment (not a stub): the backlog trigger fires → runHeadless runs the maintenance chain
// (mctx → gate → read → frame → side llm → sql → tableapply) → the table write lands (applySqlBatch)
// AND the progress pointer advances (advanceProgress). Below-threshold backlog → no run. This is the
// trigger→compaction half of ADR 0003's story; asyncMemoryFlagship covers the state→trimmed-prompt half.
//
// Mocks follow headlessRunService.test's idiom: the sqlite-backed leaves + the model call + the sinks
// are faked; the trigger evaluation, the engine (runSubgraph), and the real fragment all run.

const mockAgentPack = vi.hoisted(() => ({
  enabledFragmentsFor: vi.fn<() => ComposeFragment[]>(() => [])
}))
vi.mock('../../src/main/services/agentPackService', () => mockAgentPack)

const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 6 })),
  getChatTableTemplateId: vi.fn(() => 'tmpl'),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

// buildGenContext (mctx / export read a real-ish Context). Minimal but with the fields the chain reads.
const floors = Array.from({ length: 6 }, (_, i) => ({
  floor: i,
  user_message: { content: `u${i}` },
  response: { content: `a${i}` },
  variables: {}
}))
const mockFloor = vi.hoisted(() => {
  const getAllFloors = vi.fn(() => floors)
  return {
    getFloor: vi.fn(() => floors[floors.length - 1]),
    getAllFloors,
    // Count-only reads go through getFloorCount now — keep it slaved to the same fixture.
    getFloorCount: vi.fn(() => (getAllFloors() as unknown[] | undefined)?.length ?? 0),
    getFloorRequest: vi.fn(() => undefined),
    saveFloor: vi.fn()
  }
})
vi.mock('../../src/main/services/floorService', () => mockFloor)

// The table-status the trigger reads (unprocessed backlog).
const mockTableStatus = vi.hoisted(() => ({ getTablesStatus: vi.fn(() => ({})) }))
vi.mock('../../src/main/services/tableStatusService', () => mockTableStatus)

// The template the chain's table nodes resolve — parsed through the real schema so every field
// (note/initNode/insert/update/delete/exportConfig) gets its default, which table.read's renderer needs.
import { TableTemplateSchema } from '../../src/main/types/tableTemplate'
const TEMPLATE = TableTemplateSchema.parse({
  name: 'mem',
  tables: [
    {
      uid: 't1',
      sqlName: 'summary',
      displayName: '纪要',
      ddl: 'CREATE TABLE summary (t TEXT)',
      headers: ['t'],
      updateFrequency: 1
    }
  ]
})
const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn(() => null as unknown) }))
vi.mock('../../src/main/services/tableTemplateService', () => mockTemplate)

// The progress store — the pointer the gate advances (the observable compaction commit).
const progress = vi.hoisted(() => ({ store: {} as Record<string, number> }))
const mockProgress = vi.hoisted(() => ({
  getProgress: vi.fn(() => ({})),
  advanceProgress: vi.fn(),
  computeTableProgress: vi.fn(),
  // Pure resolver (issue 04): the gate/read use it for real — supply the real implementation.
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

// The SQL write the compaction lands.
const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(() => ({
    applied: 1,
    changes: 1,
    statements: ['INSERT INTO summary VALUES (1)']
  })),
  executeReadQuery: vi.fn(),
  TableSqlError: class extends Error {}
}))
vi.mock('../../src/main/services/tableSql', () => mockSql)
const mockOps = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))
vi.mock('../../src/main/services/tableOpsService', () => mockOps)
const mockDb = vi.hoisted(() => ({ readAllTables: vi.fn(() => []) }))
vi.mock('../../src/main/services/tableDbService', () => mockDb)

// The side LLM call the maintainer makes — returns a TableEdit batch the sql extractor pulls.
const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({
    raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>',
    rawUsage: {}
  }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

// The trigger baseline store + sinks.
const triggerState = vi.hoisted(
  () => new Map<string, { lastValue: number | null; lastFireFloor: number | null }>()
)
const mockTriggerStore = vi.hoisted(() => ({
  getTriggerState: vi.fn(
    (c: string, p: string, i: number) => triggerState.get(`${c}|${p}|${i}`) ?? null
  ),
  setTriggerLastValue: vi.fn(),
  setTriggerLastFireFloor: vi.fn()
}))
vi.mock('../../src/main/services/agentPackTriggerStore', () => mockTriggerStore)
const mockEvents = vi.hoisted(() => ({
  notifyWorkflowTrace: vi.fn(),
  notifyWorkflowPanel: vi.fn()
}))
vi.mock('../../src/main/services/workflowEvents', () => mockEvents)
const mockRunHistory = vi.hoisted(() => ({ appendRun: vi.fn() }))
vi.mock('../../src/main/services/runHistoryStore', () => mockRunHistory)
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

// Settings/preset/card/lore/regex the mctx buildGenContext + assemble path touch (like generateParity).
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
vi.mock('../../src/main/services/settingsService', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const s = (real.getDefaultSettings as typeof getDefaultSettings)()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
  s.agent = { mode: 'off' }
  return { ...real, getSettings: () => s }
})
vi.mock('../../src/main/services/characterService', () => ({
  getCharacter: () => ({ id: 'w1', data: { name: 'C', description: '', extensions: {} } })
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'w1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({})
}))

import { evaluateTriggers } from '../../src/main/services/headlessRunService'

const frag: ComposeFragment = {
  packId: ASYNC_MEMORY_PACK_ID,
  doc: ASYNC_MEMORY_FRAGMENT,
  gateOpen: true
}

// keep getDefaultPreset referenced (mocked settings uses default preset indirectly via presetService)
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'p'
}))

beforeEach(() => {
  triggerState.clear()
  progress.store = {}
  mockAgentPack.enabledFragmentsFor.mockReset().mockReturnValue([])
  mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 6 })
  mockTableStatus.getTablesStatus.mockReset().mockReturnValue({})
  mockTemplate.getTableTemplateById.mockReset().mockReturnValue(TEMPLATE)
  mockProgress.getProgress.mockReset().mockImplementation(() => ({ ...progress.store }))
  mockProgress.advanceProgress
    .mockReset()
    .mockImplementation((_p, _c, names: string[], f: number) => {
      for (const n of names) progress.store[n] = Math.max(progress.store[n] ?? -1, f)
    })
  mockSql.applySqlBatch
    .mockReset()
    .mockReturnValue({ applied: 1, changes: 1, statements: ['INSERT INTO summary VALUES (1)'] })
  mockOps.tryBeginTableWrite.mockReset().mockReturnValue(true)
  mockCallModel.callModel
    .mockReset()
    .mockResolvedValue({
      raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>',
      rawUsage: {}
    })
  mockRunHistory.appendRun.mockReset()
  mockLog.log.mockReset()
})

describe('async-memory compactor — trigger threshold', () => {
  it('backlog < N (unprocessed 5) → the compactor does NOT run', async () => {
    mockTableStatus.getTablesStatus.mockReturnValue({
      summary: { unprocessed: ASYNC_MEMORY_BACKLOG_N - 1, processed: 1, nextExpected: 3 }
    })
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag])

    await evaluateTriggers('prof', 'c1', 'turn', 0)

    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled()
  })

  it('backlog >= N → the compactor runs headlessly: SQL write lands + pointer advances', async () => {
    mockTableStatus.getTablesStatus.mockReturnValue({
      summary: { unprocessed: ASYNC_MEMORY_BACKLOG_N, processed: 0, nextExpected: 3 }
    })
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag])

    await evaluateTriggers('prof', 'c1', 'turn', 0)

    // The maintenance chain's table.apply landed the compaction write...
    expect(mockSql.applySqlBatch).toHaveBeenCalled()
    // ...and the gate advanced the committed progress pointer to the current floor (index 5).
    expect(mockProgress.advanceProgress).toHaveBeenCalled()
    expect(progress.store.summary).toBe(5)
    // A run record was persisted (WP2.3) attributed to the pack, and the trace broadcast.
    expect(mockRunHistory.appendRun).toHaveBeenCalled()
    const record = mockRunHistory.appendRun.mock.calls[0][1] as {
      origin: string
      packIds: string[]
    }
    expect(record.origin).toBe('headless')
    expect(record.packIds).toEqual([ASYNC_MEMORY_PACK_ID])
  })
})
