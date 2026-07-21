import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../src/main/services/settingsService'
import { getDefaultPreset } from '../src/main/types/preset'
import { TableTemplateSchema } from '../src/main/types/tableTemplate'
import type { GenContext } from '../src/main/services/generation/types'
import type { RunContext } from '../src/main/services/generation/runContext'

const mockCatalog = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    get(name: string): unknown {
      return mockCatalog.get(name)
    }
  }
}))

const mockRuntime = vi.hoisted(() => ({ run: vi.fn(), invocationRuntime: vi.fn() }))
vi.mock('../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: mockRuntime.invocationRuntime
}))

const mockChat = vi.hoisted(() => ({ getChatTableTemplateId: vi.fn(() => 'tmpl') }))
vi.mock('../src/main/services/chatService', () => mockChat)

const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn() }))
vi.mock('../src/main/services/tableTemplateService', () => mockTemplate)

const mockDb = vi.hoisted(() => ({ readAllTables: vi.fn() }))
vi.mock('../src/main/services/tableDbService', () => mockDb)

const mockNotes = vi.hoisted(() => ({ readNotes: vi.fn(() => '') }))
vi.mock('../src/main/services/notesMemoryService', () => mockNotes)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

import { runMemoryRecallAgent } from '../src/main/services/memoryRecallService'

const TEMPLATE = TableTemplateSchema.parse({
  name: 'chronicle',
  tables: [
    {
      uid: 't1',
      sqlName: 'chronicle',
      displayName: 'Chronicle',
      ddl: 'CREATE TABLE chronicle (code TEXT, overview TEXT, detail TEXT)',
      headers: ['Code', 'Overview', 'Detail'],
      exportConfig: {
        enabled: true,
        splitByRow: true,
        entryType: 'keyword',
        keywords: 'Code',
        injectionTemplate: '<memory>$1</memory>',
        extraIndexEnabled: true,
        extraIndexColumns: ['Code', 'Overview'],
        extraIndexColumnModes: { Code: 'both', Overview: 'index_only' },
        extraIndexInjectionTemplate: '<catalogue>$1</catalogue>'
      }
    }
  ]
})

const makeGen = (): GenContext => {
  const settings = getDefaultSettings()
  settings.persona = { name: 'U', description: 'a careful archivist', inject: true }
  return {
    profileId: 'p',
    chatId: 'c',
    userAction: 'open the sealed door',
    floors: [
      {
        floor: 0,
        plot_block:
          '<QuestPlan>Keep the key hidden.</QuestPlan><StoryEngine>The rival is nearby.</StoryEngine>',
        user_message: { content: 'Earlier action' },
        response: { content: 'Earlier response' }
      }
    ],
    lastFloor: undefined,
    card: {
      data: {
        name: 'C',
        description: 'Keeper of the sealed archive',
        personality: 'watchful',
        scenario: 'an old chapel'
      }
    },
    userName: 'U',
    workingVars: {},
    globals: {},
    settings,
    preset: getDefaultPreset()
  } as unknown as GenContext
}

const makeCtx = (): RunContext => ({
  profileId: 'p',
  chatId: 'c',
  userAction: 'open the sealed door',
  signal: new AbortController().signal,
  modelSignal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

beforeEach(() => {
  vi.clearAllMocks()
  mockCatalog.get.mockReturnValue({
    enabled: true,
    invocationConfig: { apiPresetId: 'recall-cheap' }
  })
  mockRuntime.invocationRuntime.mockReturnValue({ run: mockRuntime.run })
  mockChat.getChatTableTemplateId.mockReturnValue('tmpl')
  mockTemplate.getTableTemplateById.mockReturnValue(TEMPLATE)
  mockDb.readAllTables.mockReturnValue([
    {
      sqlName: 'chronicle',
      displayName: 'Chronicle',
      columns: ['Code', 'Overview', 'Detail'],
      rows: [
        ['MT0001', 'The brass key was found', 'The key is under the chapel floor.'],
        ['MT0002', 'The rival departed', 'The rival boarded the northbound train.']
      ],
      rowids: [1, 2]
    }
  ])
  mockNotes.readNotes.mockReturnValue('')
  mockRuntime.run.mockResolvedValue({
    invocationId: 'recall-1',
    status: 'succeeded',
    result: '<Recall></Recall>',
    sourceRestarts: 0,
    required: false
  })
})

describe('runMemoryRecallAgent', () => {
  it('uses Agent catalog enablement and starts no run while disabled', async () => {
    mockCatalog.get.mockReturnValue({ enabled: false, invocationConfig: {} })

    expect(await runMemoryRecallAgent(makeCtx(), makeGen())).toBeNull()
    expect(mockRuntime.run).not.toHaveBeenCalled()
  })

  it('starts no Agent run when both indexed tables and notes are absent', async () => {
    mockChat.getChatTableTemplateId.mockReturnValue(null)
    mockNotes.readNotes.mockReturnValue('')

    expect(await runMemoryRecallAgent(makeCtx(), makeGen())).toBeNull()
    expect(mockRuntime.run).not.toHaveBeenCalled()
  })

  it('runs through the Invocation Runtime with the pending-turn Shujuku-shaped inputs', async () => {
    const ctx = makeCtx()

    await runMemoryRecallAgent(ctx, makeGen())

    expect(mockRuntime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'p',
        chatId: 'c',
        floor: 0,
        agent: 'Memory Recall',
        // the deadline wrapper hands the runtime a COMPOSITE signal (Stop ∪ wall-clock bound), so
        // identity with ctx.modelSignal is deliberately not asserted here — linkage is pinned below.
        signal: expect.any(AbortSignal),
        options: expect.objectContaining({
          apiPresetId: 'recall-cheap',
          input: expect.objectContaining({
            summary_index: expect.stringContaining('MT0001'),
            previous_plan: expect.stringContaining('Keep the key hidden.'),
            recent_story: expect.stringContaining('Earlier response'),
            user_input: 'open the sealed door',
            user: expect.objectContaining({ persona: 'a careful archivist' }),
            character: expect.objectContaining({ name: 'C' })
          })
        })
      })
    )
  })

  it('lets the Agent resolve only rows present in the locally retrieved catalogue', async () => {
    const gen = makeGen()
    gen.userAction = 'find the chapel key'
    gen.settings.tables.retrieval.activation_threshold = 1
    gen.settings.tables.retrieval.recent_fixed_count = 0
    gen.settings.tables.retrieval.candidate_limit = 1
    mockRuntime.run.mockResolvedValue({
      invocationId: 'recall-1',
      status: 'succeeded',
      result: '<Recall>MT0002</Recall>',
      sourceRestarts: 0,
      required: false
    })

    const result = await runMemoryRecallAgent(makeCtx(), gen)
    const input = mockRuntime.run.mock.calls[0][0].options.input

    expect(input.summary_index).toContain('MT0001')
    expect(input.summary_index).not.toContain('MT0002')
    expect(result?.block).not.toContain('northbound train')
    expect(result?.report).toBe('recalled 0 of 1 code(s), 0 note section(s)')
  })

  it('selects exact memory codes, greps notes, and returns one tail block plus plot data', async () => {
    mockNotes.readNotes.mockReturnValue(
      '## Door ritual\n<!-- keywords: sigil, chapel -->\nThe moon sigil opens the sealed door.'
    )
    mockRuntime.run.mockResolvedValue({
      invocationId: 'recall-1',
      status: 'succeeded',
      result: [
        '<Recall>MT0001, MT9999</Recall>',
        '<Query>sigil</Query>',
        '<QuestPlan>Use the remembered key.</QuestPlan>',
        '<StoryEngine>Let the rival interrupt.</StoryEngine>'
      ].join(''),
      sourceRestarts: 0,
      required: false
    })

    const result = await runMemoryRecallAgent(makeCtx(), makeGen())

    expect(result?.block).toContain('The key is under the chapel floor.')
    expect(result?.block).not.toContain('northbound train')
    expect(result?.block).toContain('The moon sigil opens the sealed door.')
    expect(result?.plotBlock).toContain('<Recall>\nAM0001, AM9999\n</Recall>')
    expect(result?.report).toBe('recalled 1 of 2 code(s), 1 note section(s)')
  })

  it('fails open when the Agent outcome fails', async () => {
    mockRuntime.run.mockResolvedValue({
      invocationId: 'recall-1',
      status: 'failed',
      failure: { code: 'PROVIDER_TRANSIENT', message: 'planner unavailable', retryable: true },
      sourceRestarts: 0,
      required: false
    })

    await expect(runMemoryRecallAgent(makeCtx(), makeGen())).resolves.toBeNull()
    expect(mockLog.log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('planner unavailable')
    )
  })

  it('fails open when the recall deadline elapses on a hung provider', async () => {
    vi.useFakeTimers()
    try {
      // A hung provider: the run only settles when the harness signal aborts (as the real runtime
      // does), finalizing as an ordinary cancel.
      mockRuntime.run.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () =>
              resolve({
                invocationId: 'recall-1',
                status: 'cancelled',
                sourceRestarts: 0,
                required: false
              })
            )
          })
      )

      const pending = runMemoryRecallAgent(makeCtx(), makeGen())
      await vi.advanceTimersByTimeAsync(90_000)
      await expect(pending).resolves.toBeNull()
      expect(mockLog.log).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('timed out after 90000ms')
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a user Stop cancels the run silently — no timeout error is reported', async () => {
    const stop = new AbortController()
    const ctx = { ...makeCtx(), modelSignal: stop.signal }
    mockRuntime.run.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({
              invocationId: 'recall-1',
              status: 'cancelled',
              sourceRestarts: 0,
              required: false
            })
          )
          stop.abort()
        })
    )

    await expect(runMemoryRecallAgent(ctx, makeGen())).resolves.toBeNull()
    expect(mockLog.log).not.toHaveBeenCalled()
  })

  it('matches note queries as LITERAL text and caps them at 8 per turn', async () => {
    const notes = Array.from(
      { length: 10 },
      (_, index) => `## Topic ${index}\nBody mentions token${index} here.`
    ).join('\n\n')
    mockNotes.readNotes.mockReturnValue(notes)
    const queries = Array.from({ length: 10 }, (_, index) => `<Query>token${index}</Query>`)
    // `token0|token1` would match as a regex alternation but not as literal text.
    mockRuntime.run.mockResolvedValue({
      invocationId: 'recall-1',
      status: 'succeeded',
      result: `<Recall></Recall><Query>token0|token1</Query>${queries.join('')}`,
      sourceRestarts: 0,
      required: false
    })

    const result = await runMemoryRecallAgent(makeCtx(), makeGen())

    // 8-query cap: the alternation query (a literal no-match) consumes one slot, leaving 7 hits.
    expect(result?.report).toBe('recalled 0 of 0 code(s), 7 note section(s)')
  })
})
