import { describe, it, expect, vi, beforeEach } from 'vitest'

// Memory-Manager WP2 — the on-demand "run maintenance now" service (tableMaintainNow.maintainNow) with a
// mock LLM. It RESOLVES the chat's effective memory.maintain node config, composes the SAME maintainer
// prompt via the shared cores, calls the model, extracts the <TableEdit> and applies it. Mirrors
// memoryMaintain.test's mock idiom; adds a workflowService.resolveEffectiveDoc mock (the config resolver)
// and a regression guard that the composed prompt never ends on an `assistant` turn.

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

// The config resolver: maintainNow reads the chat's effective memory.maintain node config from here.
const mockWorkflow = vi.hoisted(() => ({ resolveEffectiveDoc: vi.fn() }))
vi.mock('../../src/main/services/workflowService', () => mockWorkflow)

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

import {
  maintainNow,
  resolveMaintainConfig,
  composeMaintainNowMessages
} from '../../src/main/services/tableMaintainNow'
import { memoryMaintainConfig } from '../../src/main/services/nodes/builtin/memoryNodes'
import { buildGenContext } from '../../src/main/services/generation/genContext'

// A config that composes to end on a `user` turn (inline {history} folded into the trailing user row).
const APPLY_CONFIG = {
  messages: [
    { role: 'system', content: '维护AI。\n【表格与规则】\n{{tables}}' },
    { role: 'user', content: '请根据以下对话维护表格：\n{history}' }
  ],
  lastNFloors: 6,
  advance_progress: true
}
// A config whose base composition ends on an `assistant` turn (a STANDALONE {history} row splices the
// floors role-preserving → last floor's assistant reply). The regression guard: run-now must not send
// this as-is.
const REGRESSION_CONFIG = {
  messages: [
    { role: 'system', content: '维护AI。\n{{tables}}' },
    { role: 'user', content: '{history}' }
  ],
  lastNFloors: 6
}

const docWith = (config: unknown): unknown => ({
  id: 'w',
  doc: { nodes: [{ id: 'maintain', type: 'memory.maintain', config }] },
  warnings: []
})

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
  mockWorkflow.resolveEffectiveDoc.mockReset().mockReturnValue(docWith(APPLY_CONFIG))
})

describe('maintainNow — run maintenance on demand', () => {
  it('composes the resolved maintainer prompt, calls the model, applies the returned <TableEdit>, advances the pointer', async () => {
    const res = await maintainNow('prof', 'c1', { lastNFloors: 6 })

    expect(mockCallModel.callModel).toHaveBeenCalled()
    const sent = mockCallModel.callModel.mock.calls[0][1] as { role: string; content: string }[]
    const joined = sent.map((m) => `${m.role}:${m.content}`).join('\n')
    // {{tables}} → the rendered table block; {history} → spliced transcript.
    expect(joined).toContain('纪要 (summary)')
    expect(joined).toContain('player action 3')

    expect(mockSql.applySqlBatch).toHaveBeenCalled()
    expect(mockProgress.advanceProgress).toHaveBeenCalledWith('prof', 'c1', ['summary'], 3)
    expect(res).toEqual({ ok: true, applied: 1, changes: 1 })
  })

  it('an empty <TableEdit></TableEdit> reply → no write, reports empty', async () => {
    mockCallModel.callModel.mockResolvedValue({ raw: 'ok <TableEdit></TableEdit>', rawUsage: {} })
    const res = await maintainNow('prof', 'c1', {})
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, applied: 0, changes: 0, empty: true })
  })

  it('no template bound → the no-op shape, no model call, no write', async () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null)
    const res = await maintainNow('prof', 'c1', {})
    expect(res).toEqual({ ok: false, reason: 'no-template' })
    expect(mockCallModel.callModel).not.toHaveBeenCalled()
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })

  it('resolveMaintainConfig reads the effective doc memory.maintain node config; null when absent', () => {
    expect(resolveMaintainConfig('prof', 'c1')?.lastNFloors).toBe(6)
    mockWorkflow.resolveEffectiveDoc.mockReturnValue({ id: 'w', doc: { nodes: [] }, warnings: [] })
    expect(resolveMaintainConfig('prof', 'c1')).toBeNull()
  })

  it('the composed prompt never ends on an `assistant` role — extraHint keeps it a trailing `user` turn', () => {
    const gen = buildGenContext('prof', 'c1', '')
    // The base composition of the standalone-{history} config would end on the last floor's assistant reply.
    const base = composeMaintainNowMessages(gen, TEMPLATE, memoryMaintainConfig.parse(REGRESSION_CONFIG))
    expect(base[base.length - 1].role).toBe('assistant')
    // With an extra hint appended AFTER provider-shape, the array ends on a `user` turn instead.
    const withHint = composeMaintainNowMessages(
      gen,
      TEMPLATE,
      memoryMaintainConfig.parse(REGRESSION_CONFIG),
      '额外提示：重点维护纪要表'
    )
    expect(withHint[withHint.length - 1].role).toBe('user')
    expect(withHint[withHint.length - 1].content).toBe('额外提示：重点维护纪要表')
  })
})
