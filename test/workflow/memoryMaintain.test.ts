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
    expect(joined).toContain('【插入规则】每次新增一行概括')
    // {history} row → spliced transcript.
    expect(joined).toContain('ai reply 3')
    expect(joined).toContain('player action 3')

    // The <TableEdit> SQL was applied + the pointer advanced for the template's tables.
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
})
