import { describe, it, expect, vi, beforeEach } from 'vitest'

// PLOT-RECALL WP4 — the `memory.recall` planner node with a MOCKED `runLlmCall` (partial-mock of
// generationNodes so the real config builders survive). gen is fed straight in on `inputs.gen`, so
// buildGenContext never runs and the test needs only a handful of service stubs. The mocks mirror
// memoryCore.test.ts's set (so memoryCore's DB-touching imports load cleanly) plus the recall-specific
// resolvers. Repo gotcha honored: beforeEach body is braced.

// The one model-call core — mocked; captures the composed prompt + drives the reply/abort/throw paths.
const mockRun = vi.hoisted(() => ({ runLlmCall: vi.fn() }))
vi.mock('../../src/main/services/nodes/builtin/generationNodes', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return { ...real, runLlmCall: mockRun.runLlmCall }
})

// chatTemplate resolvers + the per-chat corpora.
const mockChat = vi.hoisted(() => ({ getChatTableTemplateId: vi.fn(() => 'tmpl') }))
vi.mock('../../src/main/services/chatService', () => mockChat)
const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn(() => null as unknown) }))
vi.mock('../../src/main/services/tableTemplateService', () => mockTemplate)
const mockDb = vi.hoisted(() => ({ readAllTables: vi.fn(() => [] as unknown[]) }))
vi.mock('../../src/main/services/tableDbService', () => mockDb)
const mockNotes = vi.hoisted(() => ({ readNotes: vi.fn(() => '') }))
vi.mock('../../src/main/services/notesMemoryService', () => mockNotes)

// memoryCore's DB-touching imports — stubbed so the module loads without native/electron side effects
// (recall never calls these; it only uses chatTemplate/recentTranscript/historyText/composedPromptDebug).
vi.mock('../../src/main/services/tableSql', () => ({
  applySqlBatch: vi.fn(),
  executeReadQuery: vi.fn(),
  TableSqlError: class extends Error {}
}))
vi.mock('../../src/main/services/tableOpsService', () => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))
vi.mock('../../src/main/services/tableProgressService', () => ({
  advanceProgress: vi.fn(),
  getProgress: vi.fn(() => ({})),
  resolveUpdateFrequency: vi.fn(() => 3)
}))
vi.mock('../../src/main/services/floorService', () => ({ getAllFloors: vi.fn(() => []) }))

import { memoryRecall } from '../../src/main/services/nodes/builtin/recallNodes'
import { TableTemplateSchema } from '../../src/main/types/tableTemplate'
import { TableRead } from '../../src/main/services/tableDbService'
import { GenContext } from '../../src/main/services/generation/types'
import { RunContext, NodeRunFailure } from '../../src/main/services/nodes/types'
import { getDefaultSettings } from '../../src/main/services/settingsService'
import { getDefaultPreset } from '../../src/main/types/preset'

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE = TableTemplateSchema.parse({
  name: 'chron',
  tables: [
    {
      uid: 't1',
      sqlName: 'chronicle',
      displayName: '纪要',
      ddl: 'CREATE TABLE chronicle (a TEXT)',
      headers: ['编码索引', '概览', '纪要'],
      exportConfig: {
        enabled: true,
        splitByRow: true,
        entryType: 'keyword',
        keywords: '编码索引',
        injectionTemplate: '<记忆回溯>$1</记忆回溯>',
        extraIndexEnabled: true,
        extraIndexColumns: ['编码索引', '概览'],
        extraIndexColumnModes: { 编码索引: 'both', 概览: 'index_only' },
        extraIndexInjectionTemplate: '<已发生的事件概览>$1</已发生的事件概览>'
      }
    }
  ]
})

/** A TableRead for the chronicle table from `[编码索引, 概览, 纪要]` rows. */
const readsFor = (rows: string[][]): TableRead[] => [
  {
    sqlName: 'chronicle',
    displayName: '纪要',
    columns: ['编码索引', '概览', '纪要'],
    rows,
    rowids: rows.map((_, i) => i + 1)
  }
]

const makeGen = (over: Partial<GenContext> = {}): GenContext => {
  const settings = getDefaultSettings()
  settings.api = { provider: 'openai', endpoint: 'https://x/v1', api_key: 'k', model: 'm' }
  return {
    profileId: 'p',
    chatId: 'c',
    userAction: 'go to the tower',
    floors: [{ user_message: { content: 'u0' }, response: { content: 'a0' } }],
    card: { data: { name: 'C' } },
    userName: 'U',
    workingVars: {},
    globals: {},
    settings,
    preset: getDefaultPreset(),
    ...over
  } as unknown as GenContext
}

const makeCtx = (over: Partial<RunContext> = {}): RunContext => ({
  profileId: 'p',
  chatId: 'c',
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {},
  ...over
})

const config = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  memoryRecall.configSchema!.parse({
    messages: [
      { role: 'system', content: 'plan.' },
      {
        role: 'user',
        content:
          'CAT:{{catalogue}}\nTOC:{{notes_toc}}\nACT:{{action}}\nPLAN:{{plan}}\nHIST:{history}'
      }
    ],
    directive: 'DIR|{{StoryEngine}}|{{QuestPlan}}|{{recalled}}|{{notes}}',
    ...over
  })

const runRecall = (
  ctx: RunContext,
  gen: GenContext,
  cfg: Record<string, unknown>
): ReturnType<typeof memoryRecall.run> =>
  memoryRecall.run(ctx, { gen }, { id: 'recall', config: cfg })

beforeEach(() => {
  mockRun.runLlmCall.mockReset()
  mockChat.getChatTableTemplateId.mockReset().mockReturnValue('tmpl')
  mockTemplate.getTableTemplateById.mockReset().mockReturnValue(TEMPLATE)
  mockDb.readAllTables.mockReset().mockReturnValue(readsFor([['MT0001', '概览一', 'ROW_ONE']]))
  mockNotes.readNotes.mockReset().mockReturnValue('')
})

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe('memory.recall — corpus gate', () => {
  it('no template + no notes → no-op, ZERO model calls', async () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null)
    mockNotes.readNotes.mockReturnValue('')
    const res = await runRecall(makeCtx(), makeGen(), config())
    // No-op corpus: no outputs, and the `error` port is declared dead so a wired error edge stays
    // inert rather than delivering `undefined` (A2).
    expect(res).toEqual({ outputs: {}, deadPorts: ['error'] })
    expect(mockRun.runLlmCall).not.toHaveBeenCalled()
  })

  it('a bound template with NO extraIndex table + no notes → no-op, ZERO model calls', async () => {
    const noIndex = TableTemplateSchema.parse({
      name: 'x',
      tables: [{ uid: 'u', sqlName: 's', displayName: 'S', ddl: 'CREATE TABLE s (a TEXT)', headers: ['a'] }]
    })
    mockTemplate.getTableTemplateById.mockReturnValue(noIndex)
    const res = await runRecall(makeCtx(), makeGen(), config())
    expect(res).toEqual({ outputs: {}, deadPorts: ['error'] })
    expect(mockRun.runLlmCall).not.toHaveBeenCalled()
  })
})

describe('memory.recall — happy path', () => {
  it('<Recall> codes fetch the wrapped row into the block; plan is persisted', async () => {
    mockRun.runLlmCall.mockResolvedValue({
      raw: '<Recall>MT0001</Recall><QuestPlan>QP</QuestPlan><StoryEngine>SE</StoryEngine>',
      rawUsage: {}
    })
    const setNodeState = vi.fn()
    const res = await runRecall(makeCtx({ setNodeState }), makeGen(), config())

    expect(mockRun.runLlmCall).toHaveBeenCalledTimes(1)
    const block = res.outputs!.block as string
    expect(block).toContain('<记忆回溯>')
    expect(block).toContain('ROW_ONE')
    expect(block).toContain('SE') // StoryEngine slot
    expect(block).toContain('QP') // QuestPlan slot
    expect(res.outputs!.report).toBe('recalled 1 of 1 code(s), 0 note section(s)')
    // SUCCESS declares the `error` port dead (A2) and is NOT flagged failed-open.
    expect(res.deadPorts).toEqual(['error'])
    expect(res.failedOpen).toBeFalsy()
    // Plan persisted for the next turn.
    expect(setNodeState).toHaveBeenCalledWith('recall', {
      floor: 1,
      questPlan: 'QP',
      storyEngine: 'SE'
    })
  })

  it('the catalogue + pending action reach the composed planner prompt', async () => {
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Recall></Recall>', rawUsage: {} })
    await runRecall(makeCtx(), makeGen(), config())
    const sent = mockRun.runLlmCall.mock.calls[0][2] as { role: string; content: string }[]
    const joined = sent.map((m) => m.content).join('\n')
    expect(joined).toContain('MT0001') // catalogue line (编码索引)
    expect(joined).toContain('go to the tower') // pending action slot
    expect(joined).toContain('a0') // spliced transcript
  })
})

describe('memory.recall — deterministic fetch', () => {
  it('an invented code is dropped; report says 0 recalled', async () => {
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Recall>MT9999</Recall>', rawUsage: {} })
    const res = await runRecall(makeCtx(), makeGen(), config())
    expect(res.outputs!.report).toBe('recalled 0 of 1 code(s), 0 note section(s)')
    expect(res.outputs!.block).not.toContain('ROW_ONE')
  })

  it('caps recalled rows at max_rows', async () => {
    mockDb.readAllTables.mockReturnValue(
      readsFor([
        ['MT0001', 'o1', 'R1'],
        ['MT0002', 'o2', 'R2'],
        ['MT0003', 'o3', 'R3'],
        ['MT0004', 'o4', 'R4']
      ])
    )
    mockRun.runLlmCall.mockResolvedValue({
      raw: '<Recall>MT0001, MT0002, MT0003, MT0004</Recall>',
      rawUsage: {}
    })
    const res = await runRecall(makeCtx(), makeGen(), config({ max_rows: 2 }))
    expect(res.outputs!.report).toBe('recalled 2 of 4 code(s), 0 note section(s)')
    const block = res.outputs!.block as string
    expect(block).toContain('R1')
    expect(block).toContain('R2')
    expect(block).not.toContain('R3')
  })

  it('splits <Recall> codes on CJK separators （，、；） not just ASCII comma/space', async () => {
    mockDb.readAllTables.mockReturnValue(
      readsFor([
        ['MT0001', 'o1', 'R1'],
        ['MT0002', 'o2', 'R2'],
        ['MT0003', 'o3', 'R3']
      ])
    )
    // A zh model emits the ideographic comma / enumeration comma / fullwidth semicolon between codes.
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Recall>MT0001，MT0002、MT0003；MT9999</Recall>', rawUsage: {} })
    const res = await runRecall(makeCtx(), makeGen(), config())
    // All three real codes split out and resolve; the invented one drops.
    expect(res.outputs!.report).toBe('recalled 3 of 4 code(s), 0 note section(s)')
    const block = res.outputs!.block as string
    expect(block).toContain('R1')
    expect(block).toContain('R2')
    expect(block).toContain('R3')
  })

  it('MT001 does NOT collide with MT0012 (exact-key, not substring)', async () => {
    mockDb.readAllTables.mockReturnValue(
      readsFor([
        ['MT001', 'oa', 'ROW_ONE'],
        ['MT0012', 'ob', 'ROW_TWELVE']
      ])
    )
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Recall>MT001</Recall>', rawUsage: {} })
    const res = await runRecall(makeCtx(), makeGen(), config())
    expect(res.outputs!.report).toBe('recalled 1 of 1 code(s), 0 note section(s)')
    const block = res.outputs!.block as string
    expect(block).toContain('ROW_ONE')
    expect(block).not.toContain('ROW_TWELVE')
  })
})

describe('memory.recall — notes <Query> path', () => {
  it('greps the notes file for a zh query and folds the section into the block', async () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null) // notes-only corpus
    mockNotes.readNotes.mockReturnValue('## 黑塔的秘密\n黑塔是一位天才科学家。\n\n## 别的\n无关内容。')
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Query>黑塔</Query>', rawUsage: {} })
    const res = await runRecall(makeCtx(), makeGen(), config())
    const block = res.outputs!.block as string
    expect(block).toContain('黑塔是一位天才科学家')
    expect(block).not.toContain('无关内容')
    expect(res.outputs!.report).toBe('recalled 0 of 0 code(s), 1 note section(s)')
  })

  it('dedupes a section hit by two <Query> tags → ONE entry (A5)', async () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null) // notes-only corpus
    // One section with two keywords; two queries each hit a different keyword of the SAME section.
    mockNotes.readNotes.mockReturnValue(
      '## 黑塔的秘密\n<!-- keywords: 天才, 科学家 -->\n黑塔隐藏着一个身份。\n\n## 别的\n无关内容。'
    )
    mockRun.runLlmCall.mockResolvedValue({
      raw: '<Query>天才</Query><Query>科学家</Query>',
      rawUsage: {}
    })
    const res = await runRecall(makeCtx(), makeGen(), config())
    const block = res.outputs!.block as string
    // The section body appears exactly once (not twice), and it consumes ONE section of the budget.
    expect(block.split('黑塔隐藏着一个身份').length - 1).toBe(1)
    expect(res.outputs!.report).toBe('recalled 0 of 0 code(s), 1 note section(s)')
  })
})

describe('memory.recall — plan persistence', () => {
  it('discards a rewind-stale plan (stored floor ahead of the current floor count)', async () => {
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Recall></Recall>', rawUsage: {} })
    const getNodeState = vi.fn(() => ({ floor: 99, questPlan: 'STALE_QP', storyEngine: 'STALE_SE' }))
    await runRecall(makeCtx({ getNodeState }), makeGen(), config())
    const sent = mockRun.runLlmCall.mock.calls[0][2] as { content: string }[]
    const joined = sent.map((m) => m.content).join('\n')
    expect(joined).not.toContain('STALE_QP')
  })

  it('includes a still-valid previous plan in the planner prompt', async () => {
    mockRun.runLlmCall.mockResolvedValue({ raw: '<Recall></Recall>', rawUsage: {} })
    const getNodeState = vi.fn(() => ({ floor: 1, questPlan: 'PREV_QP', storyEngine: 'PREV_SE' }))
    await runRecall(makeCtx({ getNodeState }), makeGen(), config())
    const sent = mockRun.runLlmCall.mock.calls[0][2] as { content: string }[]
    const joined = sent.map((m) => m.content).join('\n')
    expect(joined).toContain('PREV_QP')
  })
})

describe('memory.recall — fail-open', () => {
  it('abort-with-empty (runLlmCall → null) → empty outputs, prompt still traced', async () => {
    mockRun.runLlmCall.mockResolvedValue(null)
    const res = await runRecall(makeCtx(), makeGen(), config())
    expect(res.outputs).toEqual({})
    expect(res.debug!['prompt (sent)']).toBeTruthy()
  })

  it('a side-call error NEVER throws (pre-phase turn safety): no block, error emitted as a value', async () => {
    // recall is a PRE-phase ancestor of the main output; an uncaught throw with `error` unwired would
    // be FATAL for the turn (workflowEngine's pre-phase rule — state.failOpen is empty for hand-wired
    // docs). The node must therefore complete normally: no `block` output (assemble reads unwired),
    // the NodeError-shaped value returned on its OWN `error` output, failure observable via
    // report/debug.
    mockRun.runLlmCall.mockRejectedValue(new NodeRunFailure('A', 'boom', 1, 'bad-preset'))
    const res = await runRecall(makeCtx(), makeGen(), config())
    expect(res.outputs!.block).toBeUndefined()
    expect(res.outputs!.error).toMatchObject({
      kind: 'A',
      message: 'boom',
      code: 'bad-preset',
      nodeId: 'recall',
      attempts: 1
    })
    expect(res.outputs!.report).toContain('failed open')
    expect(res.debug!['recall error (failed open)']).toBe('boom')
    // A2/A3: the non-error ports are declared dead (throw-path parity) and the node is flagged
    // failed-open so the trace can tint it a warning without being a hard 'failed'.
    expect(res.deadPorts).toEqual(['block', 'report'])
    expect(res.failedOpen).toBe(true)
  })

  it('a plain (non-NodeRunFailure) side-call error also fails open with class-A defaults', async () => {
    mockRun.runLlmCall.mockRejectedValue(new Error('socket hang up'))
    const res = await runRecall(makeCtx(), makeGen(), config())
    expect(res.outputs!.block).toBeUndefined()
    expect(res.outputs!.error).toMatchObject({ kind: 'A', message: 'socket hang up', attempts: 1 })
  })
})
