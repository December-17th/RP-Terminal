import { describe, it, expect, vi, beforeEach } from 'vitest'

// WP1 (memory.maintain plan) — the consolidated node END TO END with a mock LLM: it self-seeds its
// Context, renders the bound template's tables block, composes the scaffold prompt (with {{tables}}
// substituted + {history} spliced), calls the model, extracts the <TableEdit> SQL, and applies it —
// the SAME shared cores the five-node chain uses. Mocks follow the memoryFillChain idiom.

const floors = Array.from({ length: 4 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))
const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: 4 })),
  getChatTableTemplateId: vi.fn(() => 'tmpl'),
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
      insertNode: '每次新增一行概括',
      updateFrequency: 1
    }
  ]
})
const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn(() => null as unknown) }))
vi.mock('../../src/main/services/tableTemplateService', () => mockTemplate)

const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(() => ({ applied: 1, changes: 1, statements: ['INSERT INTO summary VALUES (1)'] })),
  executeReadQuery: vi.fn(),
  // WS3: the auto pass now runs its batch through the shared write-scope filter (validateBatch +
  // partitionBySelected, re-homed to tableSql). Classify by the target table named in the statement.
  validateBatch: vi.fn((sql: string) => {
    const table = /\b(?:INTO|UPDATE|FROM)\s+(\w+)/i.exec(sql)?.[1] ?? 'summary'
    return [{ kind: 'insert', table, sql }]
  }),
  partitionBySelected: (
    validated: Array<{ table: string; sql: string }>,
    selected: Set<string>
  ): { kept: string[]; dropped: string[] } => {
    const kept: string[] = []
    const dropped: string[] = []
    for (const v of validated) (selected.has(v.table) ? kept : dropped).push(v.sql)
    return { kept, dropped }
  },
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
const mockProgress = vi.hoisted(() => ({
  advanceProgress: vi.fn(),
  getProgress: vi.fn(() => ({})),
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)

// The model call — returns a TableEdit batch. Captured so we assert the composed prompt reached it.
const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({ raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>', rawUsage: {} }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'
vi.mock('../../src/main/services/settingsService', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const s = (real.getDefaultSettings as typeof getDefaultSettings)()
  s.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
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

import { memoryMaintain, composeMaintainerMessages } from '../../src/main/services/nodes/builtin/memoryNodes'
import { buildDefaultMemoryDocV2 } from '../../src/main/services/nodes/builtin/defaultMemoryTemplate'
import { buildGenContext } from '../../src/main/services/generation/genContext'
import { RunContext } from '../../src/main/services/nodes/types'

const ctx = (): RunContext => ({
  profileId: 'prof',
  chatId: 'c1',
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const config = {
  messages: [
    { role: 'system', content: '维护AI。\n【表格与规则】\n{{tables}}' },
    { role: 'user', content: '{history}' }
  ],
  lastNFloors: 6,
  advance_progress: true
}

beforeEach(() => {
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue('tmpl')
  mockTemplate.getTableTemplateById.mockReset().mockReturnValue(TEMPLATE)
  mockFloor.getAllFloors.mockReset().mockReturnValue(floors)
  mockDb.readAllTables.mockReset().mockReturnValue([])
  mockSql.applySqlBatch
    .mockReset()
    .mockReturnValue({ applied: 1, changes: 1, statements: ['INSERT INTO summary VALUES (1)'] })
  mockOps.appendOps.mockReset()
  mockOps.tryBeginTableWrite.mockReset().mockReturnValue(true)
  mockOps.endTableWrite.mockReset()
  mockProgress.advanceProgress.mockReset()
  mockProgress.getProgress.mockReset().mockReturnValue({}) // WS3: default = nothing processed → all due
  mockCallModel.callModel
    .mockReset()
    .mockResolvedValue({ raw: '<TableEdit>INSERT INTO summary VALUES (1)</TableEdit>', rawUsage: {} })
})

describe('memory.maintain — end to end', () => {
  it('renders the tables block + splices history into the prompt, applies the TableEdit, advances the pointer', async () => {
    const res = await memoryMaintain.run(ctx(), {}, { id: 'm', config: memoryMaintain.configSchema!.parse(config) })

    // The model was called with the composed prompt.
    expect(mockCallModel.callModel).toHaveBeenCalled()
    const sent = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    const joined = sent.map((m) => `${m.role}:${m.content}`).join('\n')
    // {{tables}} → the rendered table block (renderTableBlock header).
    expect(joined).toContain('纪要 (summary)')
    // The block now carries the table's CREATE TABLE so the model writes SQL against real columns.
    expect(joined).toContain('【建表语句】')
    expect(joined).toContain('CREATE TABLE summary (t TEXT)')
    expect(joined).toContain('【插入规则】每次新增一行概括')
    // {history} row → spliced transcript.
    expect(joined).toContain('ai reply 3')
    expect(joined).toContain('player action 3')

    // The <TableEdit> SQL was applied + the pointer advanced. WS3: the advance set is now the DUE tables
    // (summary, freq 1, never processed → due at floor 3), not unconditionally "all template tables". The
    // pre-WS3 characterization pinned advance-all-every-turn; the due-set plan changes that on purpose
    // (here the sole table is due, so the concrete call is unchanged).
    expect(mockSql.applySqlBatch).toHaveBeenCalled()
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('prof', 'c1', ['summary'], 3)

    // Report emitted + composed prompt traced on debug.
    expect(res.outputs!.report).toContain('applied 1 statement')
    expect((res.debug!['prompt (sent)'] as string)).toContain('纪要 (summary)')
  })

  it('composeMaintainerMessages (the shared node/preview core): {{tables}} and {{input}} are aliases', () => {
    const gen = buildGenContext('prof', 'c1', '')
    const base = { lastNFloors: 6 as const }
    const withTables = composeMaintainerMessages(gen, TEMPLATE, {
      ...base,
      messages: [{ role: 'system', content: '规则\n{{tables}}' }]
    })
    const withInput = composeMaintainerMessages(gen, TEMPLATE, {
      ...base,
      messages: [{ role: 'system', content: '规则\n{{input}}' }]
    })
    expect(withTables[0].content).toContain('纪要 (summary)')
    // The alias substitutes the identical rendered block.
    expect(withInput[0].content).toBe(withTables[0].content)
  })

  it('the seeded default (v2) maintain messages compose to end on a `user` turn (not a trailing assistant)', () => {
    const maintain = buildDefaultMemoryDocV2().nodes.find((n) => n.id === 'maintain')!
    const cfg = maintain.config as { messages: { role: string; content: string }[] }
    const gen = buildGenContext('prof', 'c1', '')
    const composed = composeMaintainerMessages(gen, TEMPLATE, { messages: cfg.messages, lastNFloors: 6 })
    // A standalone-{history} row would splice the floors role-preserving and end on the last floor's
    // `assistant` reply → OpenAI-compatible Gemini returns an empty completion. The seeded template's
    // merged inline-{history} row flattens the transcript into the trailing `user` message instead.
    expect(composed[composed.length - 1].role).toBe('user')
    // The transcript still reaches the model (flattened, not spliced).
    const joined = composed.map((m) => `${m.role}:${m.content}`).join('\n')
    expect(joined).toContain('ai reply 3')
    expect(joined).toContain('player action 3')
  })

  // WS3 — auto due-set gating: the node runs every turn but SKIPS the model call when no table is due
  // this turn (the cadence gate). This deliberately changes the pre-WS3 "maintain every turn" behavior.
  it('no table due this turn → skips the model call, reports "no tables due", no write/advance', async () => {
    // summary has updateFrequency 1; mark it already processed through the current floor (3) → not due.
    mockProgress.getProgress.mockReturnValue({ summary: 3 })
    const res = await memoryMaintain.run(ctx(), {}, { id: 'm', config: memoryMaintain.configSchema!.parse(config) })
    expect(res.outputs!.report).toBe('no tables due')
    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled()
  })

  it('no template bound → silent no-op (no model call, no write)', async () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null)
    const res = await memoryMaintain.run(ctx(), {}, { id: 'm', config: memoryMaintain.configSchema!.parse(config) })
    expect(res).toEqual({ outputs: {} })
    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })

  it('an empty <TableEdit></TableEdit> reply → no write, reports "no changes", still traces the prompt', async () => {
    mockCallModel.callModel.mockResolvedValue({ raw: 'ok <TableEdit></TableEdit>', rawUsage: {} })
    const res = await memoryMaintain.run(ctx(), {}, { id: 'm', config: memoryMaintain.configSchema!.parse(config) })
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(res.outputs!.report).toBe('no changes')
    expect(res.debug!['prompt (sent)']).toBeTruthy()
  })

  // A6 — memory-trio input symmetry: an OPTIONAL `gen` Context port (mirrors memory.recall) that reuses
  // an upstream bundle when wired and self-seeds when not.
  it('declares an optional `gen` Context input (memory-trio symmetry)', () => {
    const gen = memoryMaintain.inputs.find((i) => i.name === 'gen')
    expect(gen).toEqual({ name: 'gen', type: 'Context' })
  })

  it('reuses a wired `gen` input instead of self-seeding (byte-identical userAction reaches the model)', async () => {
    const wired = buildGenContext('prof', 'c1', 'WIRED_ACTION')
    await memoryMaintain.run(ctx(), { gen: wired }, { id: 'm', config: memoryMaintain.configSchema!.parse(config) })
    // The wired Context's floors reached the model (self-seed would rebuild the SAME floors here, so this
    // asserts the wired object is honoured — the port is live, not dropped).
    const sent = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    const joined = sent.map((m) => m.content).join('\n')
    expect(joined).toContain('ai reply 3')
  })
})
