import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// WP6.2 (one-canvas rebuild; ADR 0011) — the consolidated memory-fill chain END TO END through the
// DOC-DRIVEN headless path (WP6.1's evaluateDocTriggers). Drives the REAL memory-fill.rptflow (loaded
// from disk) with a mock LLM: the CADENCE trigger fires → history.recent extracts the transcript →
// agent.llm is called with the role-alternating maintenance prompt (history spliced) → parse.extract
// pulls the <TableEdit> SQL → table.apply lands the write + the progress pointer advances. A SECOND
// case runs the SAME doc as a plain TURN (via runWorkflow) and asserts the agent chain is SKIPPED while
// the export→assemble injection wiring still fires (turn-coupled wiring works).
//
// Mocking follows asyncMemoryCompactor.test's idiom: the sqlite leaves + the model call are faked; the
// trigger evaluation, the engine (runSubgraph / runWorkflow), and the real doc all run.

const mockAgentPack = vi.hoisted(() => ({ enabledFragmentsFor: vi.fn(() => []) }))
vi.mock('../../src/main/services/agentPackService', () => mockAgentPack)

const floors = Array.from({ length: 6 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))
const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 6 })),
  getChatTableTemplateId: vi.fn(() => 'tmpl'),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  isYuzuMode: vi.fn(() => false),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

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

const mockTableStatus = vi.hoisted(() => ({ getTablesStatus: vi.fn(() => ({})) }))
vi.mock('../../src/main/services/tableStatusService', () => mockTableStatus)

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

// The agent's model call — returns a TableEdit batch the sql extractor pulls. We capture the messages
// it was called with to assert the role-alternating prompt + spliced history reached the model.
const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({
    raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>',
    rawUsage: {}
  }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

// Doc trigger baseline store (keyed chat|doc|node), faked in-memory so cadence persists across evals.
const docTriggerState = vi.hoisted(
  () => new Map<string, { lastValue: number | null; lastFireFloor: number | null }>()
)
const mockDocTriggerStore = vi.hoisted(() => ({
  getDocTriggerState: vi.fn((c: string, d: string, n: string) => docTriggerState.get(`${c}|${d}|${n}`) ?? null),
  setDocTriggerLastValue: vi.fn((c: string, d: string, n: string, v: number) => {
    const k = `${c}|${d}|${n}`
    docTriggerState.set(k, { lastValue: v, lastFireFloor: docTriggerState.get(k)?.lastFireFloor ?? null })
  }),
  setDocTriggerLastFireFloor: vi.fn((c: string, d: string, n: string, f: number) => {
    const k = `${c}|${d}|${n}`
    docTriggerState.set(k, { lastValue: docTriggerState.get(k)?.lastValue ?? null, lastFireFloor: f })
  })
}))
vi.mock('../../src/main/services/workflowTriggerStore', () => mockDocTriggerStore)

// The pack path's trigger store is imported by headlessRunService too — no-op it.
const mockPackTriggerStore = vi.hoisted(() => ({
  getTriggerState: vi.fn(() => null),
  setTriggerLastValue: vi.fn(),
  setTriggerLastFireFloor: vi.fn()
}))
vi.mock('../../src/main/services/agentPackTriggerStore', () => mockPackTriggerStore)

const mockEvents = vi.hoisted(() => ({ notifyWorkflowTrace: vi.fn(), notifyWorkflowPanel: vi.fn() }))
vi.mock('../../src/main/services/workflowEvents', () => mockEvents)
const mockRunHistory = vi.hoisted(() => ({ appendRun: vi.fn() }))
vi.mock('../../src/main/services/runHistoryStore', () => mockRunHistory)
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

// Settings/preset/card/lore/regex the buildGenContext + assemble path touch.
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
vi.mock('../../src/main/services/regexService', () => ({ getPromptRules: () => [], getWorldInfoRules: () => [] }))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadGlobals: () => ({})
}))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'p'
}))

// resolveWorkflowDoc returns the real memory-fill doc.
const mockWorkflowService = vi.hoisted(() => ({
  resolveWorkflowDoc: vi.fn<() => { id: string; doc: WorkflowDoc }>()
}))
vi.mock('../../src/main/services/workflowService', () => mockWorkflowService)

// Persistence leaves the narrator's write.floor touches on a plain turn run.
vi.mock('../../src/main/services/generation/persistFloor', () => ({ persistFloor: vi.fn(() => 6) }))

import { evaluateDocTriggers } from '../../src/main/services/headlessRunService'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { RunContext } from '../../src/main/services/nodes/types'

const memoryFillDoc = (): WorkflowDoc =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../docs/workflows/memory-fill.rptflow'), 'utf-8')
  ) as WorkflowDoc

const memoryFillAsyncDoc = (): WorkflowDoc =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../docs/workflows/memory-fill-async.rptflow'), 'utf-8')
  ) as WorkflowDoc

beforeEach(() => {
  docTriggerState.clear()
  progress.store = {}
  mockAgentPack.enabledFragmentsFor.mockReset().mockReturnValue([])
  mockChat.getChat.mockReset().mockReturnValue({ character_id: 'w1', floor_count: 6 })
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue('tmpl')
  mockChat.getChatLorebookIds.mockReset().mockReturnValue(null)
  mockChat.getChatMode.mockReset().mockReturnValue('explore')
  mockChat.getCachedWorldInfo.mockReset().mockReturnValue(null)
  mockFloor.getFloor.mockReset().mockReturnValue(floors[floors.length - 1])
  mockFloor.getAllFloors.mockReset().mockReturnValue(floors)
  // Derive `unprocessed` from the SHARED progress.store table.apply advances (currentFloor 5 over the
  // 6 floors: max(0, 5 - last), never-processed = -1 → 6). This couples the async state trigger's
  // `summary.unprocessed gte 6` backlog to the pointer: before the run 6 (fires), after advance 0.
  mockTableStatus.getTablesStatus.mockReset().mockImplementation(() => {
    const last = progress.store.summary ?? -1
    return { summary: { lastFloor: last < 0 ? null : last, processed: last + 1, nextExpected: last + 1, unprocessed: Math.max(0, 5 - last) } }
  })
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
  mockDb.readAllTables.mockReset().mockReturnValue([])
  mockCallModel.callModel
    .mockReset()
    .mockResolvedValue({ raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>', rawUsage: {} })
  mockRunHistory.appendRun.mockReset()
  mockEvents.notifyWorkflowTrace.mockReset()
  mockLog.log.mockReset()
})

describe('memory-fill chain — headless (evaluateDocTriggers)', () => {
  it('cadence trigger fires → history extracted → agent called with the role-alternating prompt → SQL lands + pointer advances', async () => {
    // Floor index 5, lastFire -1, everyNFloors 3 → 5 - (-1) = 6 >= 3 → fires.
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'memory-fill', doc: memoryFillDoc() })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    // The agent's model call happened...
    expect(mockCallModel.callModel).toHaveBeenCalled()
    // ...with the role-alternating maintenance prompt AND the extracted history spliced in.
    const sentMessages = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    expect(sentMessages[0].role).toBe('system')
    expect(sentMessages[0].content).toContain('数据库表格维护AI')
    // history.recent produced assistant + user rows from the floors; they were spliced ({history} row).
    const joined = sentMessages.map((m) => `${m.role}:${m.content}`).join('\n')
    expect(joined).toContain('ai reply 5')
    expect(joined).toContain('player action 5')
    // table.read's block reached the model via the `{{input}}` placeholder (read.block → agent.input).
    // Regression guard for the dropped-block bug: interpolate substitutes {{input}}, not just {{inN}}.
    expect(joined).toContain('纪要 (summary)')

    // parse.extract pulled the TableEdit block and table.apply LANDED it (the rows-land assertion).
    expect(mockSql.applySqlBatch).toHaveBeenCalled()
    // WP6.2b: table.apply now carries advance_progress:true, so a successful batch advances the
    // maintenance pointer to the current floor for every template table (re-closing the gap the
    // dropped table.gate left — the async trigger's backlog + context.trimProcessed depend on it).
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('prof', 'c1', ['summary'], 5)
    expect(progress.store.summary).toBe(5)

    // A headless run record was persisted (no pack attribution — doc-path).
    const run = mockRunHistory.appendRun.mock.calls.at(-1)![1] as { origin: string; packIds: string[] }
    expect(run.origin).toBe('headless')
    expect(run.packIds).toEqual([])

    // The composed prompt is inspectable in the run drawer: agent.llm's `debug` reaches the broadcast
    // trace (runSubgraph.debug → summarizeRun) as the agent node's "prompt (sent)" preview, carrying
    // the substituted table block + spliced history — end-to-end proof the debug channel works headless.
    const broadcast = mockEvents.notifyWorkflowTrace.mock.calls.at(-1)![0] as {
      nodes: { nodeId: string; outputs?: Record<string, string> }[]
    }
    const agentNode = broadcast.nodes.find((n) => n.nodeId === 'agent')!
    const sentPrompt = agentNode.outputs!['prompt (sent)']
    expect(sentPrompt).toContain('纪要 (summary)')
    expect(sentPrompt).toContain('ai reply 5')
  })

  it('an unsatisfied cadence (not yet due) does NOT run the chain', async () => {
    // lastFire 4, floor index 5 → 5 - 4 = 1 < 3 → not due.
    docTriggerState.set('c1|memory-fill|trigger', { lastValue: null, lastFireFloor: 4 })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'memory-fill', doc: memoryFillDoc() })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })
})

// WP6.2b: the async doc's STATE trigger fires on `summary.unprocessed gte 6`. table.apply's
// advance_progress:true advances the pointer on a successful batch, dropping unprocessed to 0 — so a
// SECOND boundary does NOT re-fire, and context.trimProcessed then trims the processed floors.
describe('memory-fill-async chain — pointer advance clears the backlog (evaluateDocTriggers)', () => {
  it('first pass fires + advances the pointer to the latest floor; a second pass does NOT re-fire', async () => {
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'memory-fill-async', doc: memoryFillAsyncDoc() })

    // Backlog 6 (pointer -1, currentFloor 5) → summary.unprocessed = 6 >= 6 → fires.
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockSql.applySqlBatch).toHaveBeenCalledTimes(1)
    // The pointer advanced to the latest floor (index 5) for the template's table.
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('prof', 'c1', ['summary'], 5)
    expect(progress.store.summary).toBe(5)

    // Second boundary: unprocessed is now max(0, 5 - 5) = 0 < 6 → the state trigger does NOT re-fire.
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockSql.applySqlBatch).toHaveBeenCalledTimes(1) // still just the one apply
  })

  it('context.trimProcessed runs inline on the narrator path once the pointer has advanced', async () => {
    // With the pointer at floor 5 (all 6 floors processed), context.trimProcessed reads the same
    // getProgress-mirrored pointer and would slice floors > pointer → an empty tail. Run the async doc
    // as a plain TURN so the INLINE trim node executes on the narrator path.
    progress.store.summary = 5
    const ctx: RunContext = {
      profileId: 'prof',
      chatId: 'c1',
      workflowId: 'memory-fill-async',
      userAction: 'do a thing',
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }

    const result = await runWorkflow(memoryFillAsyncDoc(), builtinRegistry, ctx)
    const status = new Map(result.traces.map((t) => [t.nodeId, t.status]))
    // The inline trim node ran (fed by the advanced pointer). NOTE: asserting the EXACT trimmed floor
    // set would need to read the trim node's output Context, which the runWorkflow result exposes only
    // as a truncated JSON preview string — skipped per spec (contextNodes.test.ts pins the slice unit).
    expect(status.get('trim')).toBe('ran')
  })
})

describe('memory-fill chain — turn run isolation (runWorkflow)', () => {
  it('the agent chain is SKIPPED in a turn, while export→assemble injection still fires', async () => {
    const ctx: RunContext = {
      profileId: 'prof',
      chatId: 'c1',
      workflowId: 'memory-fill',
      userAction: 'do a thing',
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }

    const result = await runWorkflow(memoryFillDoc(), builtinRegistry, ctx)

    const status = new Map(result.traces.map((t) => [t.nodeId, t.status]))
    // The trigger-rooted agent chain is excluded/pruned on a turn.
    for (const id of ['trigger', 'history', 'read', 'agent', 'sql', 'tableapply']) {
      expect(status.get(id)).toBe('skipped')
    }
    // The narrator ran and the export→assemble injection wiring fired (both ran, turn-coupled).
    expect(status.get('export')).toBe('ran')
    expect(status.get('assemble')).toBe('ran')
    expect(status.get('write')).toBe('ran')
    // The agent's model call NEVER happened in the turn (only the narrator's llm.sample did).
    // Both llm.sample nodes route through callModel; the agent 'agent' node was skipped, so only the
    // narrator 'llm' node called it — exactly once.
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
    // table.apply (the agent's write) did NOT run in the turn.
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })
})
