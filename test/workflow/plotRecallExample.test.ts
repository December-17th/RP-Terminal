import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// PLOT-RECALL WP5 — the shipped example workflow (docs/workflows/plot-recall.rptflow) + its MT-coded
// chronicle table template (docs/workflows/plot-recall-chronicle.chatsheets.json). Three layers, the
// same shape as defaultMemoryTemplate.test.ts (whose proven runWorkflow mock harness this reuses,
// plus a notesMemoryService stub for memory.recall's notes read):
//   1. shape pins — the example doc validates (structural + graph + per-node config), wires the
//      turn-coupled recall (ctx → recall → assemble.block, recall.error → util.log), and keeps the
//      headless maintainer group;
//   2. TURN trace-equivalence — with NO bound table template and NO notes, a turn run of the example
//      doc is trace-equivalent to the narrator spine: the narrator nodes have identical statuses, the
//      model sees the SAME prompt (recall no-ops on the empty corpus → no block, ZERO recall model
//      calls), and the whole memory group is excluded/gated off;
//   3. the chronicle template imports (parseChatSheets) and carries the MT code column + the
//      split-by-row keyword + extraIndex(概览 index_only, 编码索引 both) export config recall depends on.

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
  getChatTableTemplateId: vi.fn<() => string | null>(() => null),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn()
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn(() => floors[floors.length - 1]),
  getAllFloors: vi.fn(() => floors),
  saveFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => mockFloor)

const mockTableStatus = vi.hoisted(() => ({ getTablesStatus: vi.fn(() => ({}) as Record<string, unknown>) }))
vi.mock('../../src/main/services/tableStatusService', () => mockTableStatus)

const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn(() => null as unknown) }))
vi.mock('../../src/main/services/tableTemplateService', () => mockTemplate)

const progress = vi.hoisted(() => ({ store: {} as Record<string, number> }))
const mockProgress = vi.hoisted(() => ({
  getProgress: vi.fn(() => ({}) as Record<string, number>),
  advanceProgress: vi.fn(),
  computeTableProgress: vi.fn(),
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(() => ({ applied: 1, changes: 1, statements: ['INSERT INTO chronicle VALUES (1)'] })),
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
const mockNotes = vi.hoisted(() => ({ readNotes: vi.fn(() => '') }))
vi.mock('../../src/main/services/notesMemoryService', () => mockNotes)

const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({ raw: 'ai reply', rawUsage: {} }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

const mockEvents = vi.hoisted(() => ({ notifyWorkflowTrace: vi.fn(), notifyWorkflowPanel: vi.fn() }))
vi.mock('../../src/main/services/workflowEvents', () => mockEvents)
const mockRunHistory = vi.hoisted(() => ({ appendRun: vi.fn() }))
vi.mock('../../src/main/services/runHistoryStore', () => mockRunHistory)
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

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
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => getDefaultPreset(),
  getActivePresetId: () => 'p'
}))
vi.mock('../../src/main/services/generation/persistFloor', () => ({ persistFloor: vi.fn(() => 6) }))

import { runWorkflow } from '../../src/main/services/workflowEngine'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { RunContext } from '../../src/main/services/nodes/types'
import { parseWorkflowDoc } from '../../src/shared/workflow/docSchema'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { NARRATOR_SPINE_DOC } from '../fixtures/narratorSpineDoc'
import { parseChatSheets } from '../../src/main/parsers/chatSheetsParser'
import { codeColumnOf } from '../../src/shared/memory/codeColumn'

const load = (name: string): WorkflowDoc =>
  JSON.parse(fs.readFileSync(path.join(__dirname, `../../docs/workflows/${name}`), 'utf-8')) as WorkflowDoc

const DOC = load('plot-recall.rptflow')
// The post-turn maintenance group: the table maintainer AND the notes maintainer share ONE cadence
// chain (trigger.cadence + trigger.state → control.mode → …when). All are gated off on a plain turn.
const MEMORY_GROUP_IDS = [
  'trigger-cadence',
  'trigger-state',
  'mode',
  'maintain',
  'log-apply',
  'notes-maintain',
  'log-notes'
]

beforeEach(() => {
  progress.store = {}
  mockAgentPack.enabledFragmentsFor.mockReset().mockReturnValue([])
  mockChat.getChat.mockReset().mockReturnValue({ character_id: 'w1', floor_count: 6 })
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue(null)
  mockChat.getChatLorebookIds.mockReset().mockReturnValue(null)
  mockChat.getChatMode.mockReset().mockReturnValue('explore')
  mockChat.getCachedWorldInfo.mockReset().mockReturnValue(null)
  mockFloor.getFloor.mockReset().mockReturnValue(floors[floors.length - 1])
  mockFloor.getAllFloors.mockReset().mockReturnValue(floors)
  mockTableStatus.getTablesStatus.mockReset().mockReturnValue({})
  mockTemplate.getTableTemplateById.mockReset().mockReturnValue(null)
  mockDb.readAllTables.mockReset().mockReturnValue([])
  mockNotes.readNotes.mockReset().mockReturnValue('')
  mockCallModel.callModel.mockReset().mockResolvedValue({ raw: 'ai reply', rawUsage: {} })
  mockRunHistory.appendRun.mockReset()
  mockEvents.notifyWorkflowTrace.mockReset()
  mockLog.log.mockReset()
})

// ── 1. shape pins ─────────────────────────────────────────────────────────────────────────────────

describe('plot-recall example — shape', () => {
  it('passes the full save gate (structural + graph rules + per-node config)', () => {
    const structural = parseWorkflowDoc(JSON.parse(JSON.stringify(DOC)))
    expect(structural.ok).toBe(true)
    if (!structural.ok) return
    const v = validateWorkflow(structural.doc, builtinRegistry.descriptors())
    if (!v.ok) throw new Error(v.errors.map((e) => e.message).join('; '))
    for (const n of structural.doc.nodes) {
      const schema = builtinRegistry.get(n.type)?.configSchema
      if (!schema) continue
      const r = schema.safeParse(n.config ?? {})
      if (!r.success) throw new Error(`${n.id} (${n.type}): ${r.error.message}`)
    }
  })

  it('is a turn doc with write as the sole main output', () => {
    expect(DOC.nodes.filter((n) => n.isMainOutput).map((n) => n.id)).toEqual(['write'])
  })

  it('wires turn-coupled recall: ctx → recall.gen, recall.block → assemble.block, recall.error → util.log', () => {
    expect(DOC.nodes.find((n) => n.id === 'recall')?.type).toBe('memory.recall')
    expect(DOC.edges.find((e) => e.to.node === 'recall' && e.to.port === 'gen')?.from).toEqual({
      node: 'ctx',
      port: 'gen'
    })
    expect(DOC.edges.find((e) => e.to.node === 'assemble' && e.to.port === 'block')?.from).toEqual({
      node: 'recall',
      port: 'block'
    })
    expect(DOC.edges.find((e) => e.from.node === 'recall' && e.from.port === 'error')?.to).toEqual({
      node: 'log-recall',
      port: 'value'
    })
    // recall's `when` is deliberately UNWIRED so it runs every turn (not signal-gated).
    expect(DOC.edges.some((e) => e.to.node === 'recall' && e.to.port === 'when')).toBe(false)
  })

  it('runs recall non-streaming (a side call, never the player stream)', () => {
    const recall = DOC.nodes.find((n) => n.id === 'recall')
    expect((recall?.config as { stream?: boolean }).stream).toBe(false)
  })

  it('keeps the headless maintainer group gated by mode.fired', () => {
    const g = DOC.groups![0]
    expect(g.nodeIds).toEqual(MEMORY_GROUP_IDS)
    expect(DOC.edges.find((e) => e.to.node === 'maintain' && e.to.port === 'when')?.from).toEqual({
      node: 'mode',
      port: 'fired'
    })
  })

  it('joins notes.maintain onto the shared maintenance cadence (mode.fired → notes-maintain.when)', () => {
    const notes = DOC.nodes.find((n) => n.id === 'notes-maintain')
    expect(notes?.type).toBe('notes.maintain')
    expect(
      DOC.edges.find((e) => e.to.node === 'notes-maintain' && e.to.port === 'when')?.from
    ).toEqual({ node: 'mode', port: 'fired' })
    expect(
      DOC.edges.find((e) => e.from.node === 'notes-maintain' && e.from.port === 'error')?.to
    ).toEqual({ node: 'log-notes', port: 'value' })
    // The group exposes an API preset knob for the notes maintainer alongside the table one.
    expect(DOC.groups![0].exposed?.some((x) => x.node === 'notes-maintain' && x.path === 'api_preset_id')).toBe(true)
  })

  it('groups turn-coupled recall with a cost note and exposes api_preset_id + max_rows', () => {
    const g = DOC.groups!.find((x) => x.nodeIds.includes('recall'))
    expect(g).toBeTruthy()
    expect(g!.nodeIds).toEqual(['recall', 'log-recall'])
    const paths = (g!.exposed ?? []).filter((x) => x.node === 'recall').map((x) => x.path)
    expect(paths).toContain('api_preset_id')
    expect(paths).toContain('max_rows')
    expect((g!.note ?? '').length).toBeGreaterThan(0)
  })
})

// ── 2. TURN trace-equivalence to the narrator spine ─────────────────────────────────────────────────

const turnCtx = (workflowId: string): RunContext => ({
  profileId: 'prof',
  chatId: 'c1',
  workflowId,
  userAction: 'do a thing',
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

describe('plot-recall example — TURN trace-equivalence to the narrator spine', () => {
  it('recall no-ops on the empty corpus; narrator traces match and the model sees the SAME prompt', async () => {
    // No bound table template + no notes → recall's corpus check returns empty, ZERO recall model calls.
    const recallRun = await runWorkflow(load('plot-recall.rptflow'), builtinRegistry, turnCtx('plot-recall'))
    const recallSend = mockCallModel.callModel.mock.calls[0]?.[1]
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1) // only the narrator's llm.sample

    mockCallModel.callModel.mockClear()
    const plain = await runWorkflow(structuredClone(NARRATOR_SPINE_DOC), builtinRegistry, turnCtx('default'))
    const plainSend = mockCallModel.callModel.mock.calls[0]?.[1]
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)

    const recallStatus = new Map(recallRun.traces.map((t) => [t.nodeId, t.status]))
    const plainStatus = new Map(plain.traces.map((t) => [t.nodeId, t.status]))
    // Narrator nodes: identical statuses in both runs.
    for (const id of ['ctx', 'assemble', 'llm', 'parse', 'apply', 'write']) {
      expect(recallStatus.get(id)).toBe(plainStatus.get(id))
      expect(recallStatus.get(id)).toBe('ran')
    }
    // Turn-coupled recall RAN (pre-phase ancestor of the main output) but produced no block.
    expect(recallStatus.get('recall')).toBe('ran')
    // The whole headless memory group is excluded/gated on a turn.
    for (const id of MEMORY_GROUP_IDS) expect(recallStatus.get(id)).toBe('skipped')
    // Empty-corpus recall left the prompt byte-identical to the plain narrator spine.
    expect(recallSend).toEqual(plainSend)
    // No memory write happened.
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })
})

// ── 3. the MT-coded chronicle table template ────────────────────────────────────────────────────────

describe('plot-recall chronicle template (chatSheets v2)', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../docs/workflows/plot-recall-chronicle.chatsheets.json'), 'utf-8')
  )
  const template = parseChatSheets(raw, 'chronicle')

  it('imports to a native TableTemplate with one 纪要 chronicle table', () => {
    expect(template.tables).toHaveLength(1)
    const t = template.tables[0]
    expect(t.sqlName).toBe('chronicle')
    expect(t.displayName).toBe('纪要表')
    expect(t.headers).toEqual(['row_id', '编码索引', '时间跨度', '地点', '纪要', '概览', '参与人员'])
  })

  it('carries the split-by-row keyword + extraIndex export config recall depends on', () => {
    const ec = template.tables[0].exportConfig
    expect(ec.enabled).toBe(true)
    expect(ec.splitByRow).toBe(true)
    expect(ec.entryType).toBe('keyword')
    expect(ec.keywords).toBe('编码索引')
    expect(ec.injectionTemplate).toContain('<记忆回溯>')
    expect(ec.extraIndexEnabled).toBe(true)
    expect(ec.extraIndexColumns).toEqual(['概览', '编码索引'])
    expect(ec.extraIndexColumnModes).toEqual({ 概览: 'index_only', 编码索引: 'both' })
  })

  it('exposes 编码索引 as the MT code column (WP3 codeColumnOf)', () => {
    expect(codeColumnOf(template.tables[0].exportConfig)).toBe('编码索引')
  })
})
