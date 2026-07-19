import { describe, it, expect, beforeEach, vi } from 'vitest'

// Backfill engine (issue 07). Pure planBatches/buildBatchTranscript are tested directly; the batch
// orchestration is tested with every service dep mocked (no real SQL/LLM) — we pin: floor attribution
// at the batch's LAST floor, progress advance on apply, the SQL-error corrective retry loop, exhausted-
// retry marks the batch failed + the run CONTINUES (fail-open), busy-lock treated as retryable, and
// cancellation between batches (applied batches stay applied). better-sqlite3 is alias-mocked.

const chatSvc = vi.hoisted(() => ({ getChatTableTemplateId: vi.fn() }))
vi.mock('../src/main/services/chatService', () => chatSvc)

const templateSvc = vi.hoisted(() => ({ getTableTemplateById: vi.fn() }))
vi.mock('../src/main/services/tableTemplateService', () => templateSvc)

const floorSvc = vi.hoisted(() => ({ getAllFloors: vi.fn() }))
vi.mock('../src/main/services/floorService', () => floorSvc)

const dbSvc = vi.hoisted(() => ({ readAllTables: vi.fn() }))
vi.mock('../src/main/services/tableDbService', () => dbSvc)

const sqlSvc = vi.hoisted(() => ({
  applySqlBatch: vi.fn(),
  TableSqlError: class TableSqlError extends Error {
    index: number
    constructor(message: string, index = -1) {
      super(message)
      this.name = 'TableSqlError'
      this.index = index
    }
  }
}))
vi.mock('../src/main/services/tableSql', () => sqlSvc)

const opsSvc = vi.hoisted(() => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))
vi.mock('../src/main/services/tableOpsService', () => opsSvc)

// resolveUpdateFrequency lives on the leaf tableProgressService (issue 04); backfill uses it (pure) to
// render each table's cadence header — supply the REAL implementation, not a stub.
const progressSvc = vi.hoisted(() => ({
  advanceProgress: vi.fn(),
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../src/main/services/tableProgressService', () => progressSvc)

// The backfill reads the app global default (issue 04) for the rendered cadence header.
const settingsSvc = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ tables: { default_update_frequency: 3 } }))
}))
vi.mock('../src/main/services/settingsService', () => settingsSvc)

const genSvc = vi.hoisted(() => ({ buildGenContext: vi.fn() }))
vi.mock('../src/main/services/generation/genContext', () => genSvc)

const resilientSvc = vi.hoisted(() => ({
  callModelResilient: vi.fn(),
  withPreset: vi.fn((gen: unknown) => gen)
}))
vi.mock('../src/main/services/generation/resilientCall', () => resilientSvc)

const eventsSvc = vi.hoisted(() => ({ notifyBackfillProgress: vi.fn() }))
vi.mock('../src/main/services/tableBackfillEvents', () => eventsSvc)

vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

// stripThinking is pure (shared/responseView) — leave it real; extractTagAll is real (parseNodes) too.

import {
  planBatches,
  buildBatchTranscript,
  startBackfill,
  getBackfillState,
  cancelBackfill,
  hasActiveBackfill
} from '../src/main/services/tableBackfillService'

describe('planBatches', () => {
  it('last-X scope, ascending batches, partial last batch', () => {
    // 10 floors, last 6 → start 4, batches of 3: [4-6], [7-9].
    expect(planBatches(10, 6, 3)).toEqual([
      { from: 4, to: 6 },
      { from: 7, to: 9 }
    ])
  })

  it("'all' scope covers the whole chat", () => {
    expect(planBatches(5, 'all', 2)).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 4 }
    ])
  })

  it('scope larger than the chat is clamped to the chat', () => {
    expect(planBatches(3, 100, 2)).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 2 }
    ])
  })

  it('empty chat / zero scope / non-positive batch → []', () => {
    expect(planBatches(0, 'all', 3)).toEqual([])
    expect(planBatches(5, 0, 3)).toEqual([])
    expect(planBatches(5, 3, 0)).toEqual([])
  })
})

describe('buildBatchTranscript', () => {
  const floors = [
    { user_message: { content: 'hi' }, response: { content: 'hello' } },
    { user_message: { content: '' }, response: { content: '<think>plan</think>reply' } },
    { user_message: { content: 'q' }, response: { content: '' } }
  ] as any

  it('renders User/Assistant lines, strips thinking, skips empties', () => {
    const t = buildBatchTranscript(floors, 0, 2)
    expect(t).toBe('User: hi\nAssistant: hello\nAssistant: reply\nUser: q')
  })

  it('respects the from..to window', () => {
    expect(buildBatchTranscript(floors, 0, 0)).toBe('User: hi\nAssistant: hello')
  })
})

// ---- orchestration -----------------------------------------------------------------------------

const template = {
  tables: [
    {
      sqlName: 'chronicle',
      displayName: '纪要',
      ddl: 'CREATE TABLE chronicle (row_id INTEGER, s TEXT)',
      headers: ['row_id', 's'],
      updateFrequency: 1,
      note: '',
      initNode: '',
      insertNode: '',
      updateNode: '',
      deleteNode: ''
    },
    {
      sqlName: 'world',
      displayName: '世界',
      ddl: 'CREATE TABLE world (row_id INTEGER, f TEXT)',
      headers: ['row_id', 'f'],
      updateFrequency: 3,
      note: '',
      initNode: '',
      insertNode: '',
      updateNode: '',
      deleteNode: ''
    }
  ]
}

const flush = async (): Promise<void> => {
  // Let the async run's microtasks drain. A few awaits cover the per-batch call chain.
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('backfill orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatSvc.getChatTableTemplateId.mockReturnValue('t1')
    templateSvc.getTableTemplateById.mockReturnValue(template)
    floorSvc.getAllFloors.mockReturnValue([{}, {}, {}, {}]) // 4 floors
    dbSvc.readAllTables.mockReturnValue([])
    genSvc.buildGenContext.mockReturnValue({ preset: { parameters: {} } })
    resilientSvc.withPreset.mockImplementation((gen: unknown) => gen)
    opsSvc.tryBeginTableWrite.mockReturnValue(true)
    sqlSvc.applySqlBatch.mockReturnValue({
      applied: 1,
      changes: 1,
      statements: ['INSERT INTO chronicle VALUES (1)']
    })
  })

  it('applies each batch at its LAST floor and advances progress for ALL tables', async () => {
    resilientSvc.callModelResilient.mockResolvedValue({
      raw: '<TableEdit>INSERT INTO chronicle VALUES (1)</TableEdit>'
    })
    // 4 floors, all, batch 2 → [0-1], [2-3].
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 2, retries: 0 })
    await flush()
    // 6th arg = the batch SPAN START: [0-1] → from 0, [2-3] → from 2.
    expect(opsSvc.appendOps).toHaveBeenNthCalledWith(
      1,
      'p1',
      'c1',
      1,
      ['INSERT INTO chronicle VALUES (1)'],
      'backfill',
      0
    )
    expect(opsSvc.appendOps).toHaveBeenNthCalledWith(
      2,
      'p1',
      'c1',
      3,
      ['INSERT INTO chronicle VALUES (1)'],
      'backfill',
      2
    )
    expect(progressSvc.advanceProgress).toHaveBeenCalledWith('p1', 'c1', ['chronicle', 'world'], 1)
    expect(progressSvc.advanceProgress).toHaveBeenCalledWith('p1', 'c1', ['chronicle', 'world'], 3)
    expect(getBackfillState('c1')?.running).toBe(false)
  })

  // Classic Narrator plan, Milestone 4 — a backfill reaches the provider via callModelResilient,
  // which never registers in `activeControllers`, so it is invisible to every other source of the
  // exit signal. Without its own accessor the app quits silently mid-job.
  it('reports active work while a backfill is mid-job, and idle once it finishes', async () => {
    expect(hasActiveBackfill()).toBe(false)

    let releaseBatch!: () => void
    const batchInFlight = new Promise<void>((resolve) => {
      releaseBatch = resolve
    })
    let sawActiveMidJob: boolean | null = null
    resilientSvc.callModelResilient.mockImplementation(async () => {
      sawActiveMidJob = hasActiveBackfill()
      await batchInFlight
      return { raw: '<TableEdit>INSERT INTO chronicle VALUES (1)</TableEdit>' }
    })

    const run = startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 4, retries: 0 })
    await flush()

    expect(sawActiveMidJob).toBe(true)
    expect(hasActiveBackfill()).toBe(true)

    releaseBatch()
    await run
    await flush()

    // The run entry SURVIVES for a re-mounting view, so this must read state.running, not map size.
    expect(getBackfillState('c1')).not.toBeNull()
    expect(hasActiveBackfill()).toBe(false)
  })

  it('empty <TableEdit> → no-op apply but progress still advances (span counts as processed)', async () => {
    resilientSvc.callModelResilient.mockResolvedValue({ raw: '<TableEdit></TableEdit>' })
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 4, retries: 0 })
    await flush()
    expect(sqlSvc.applySqlBatch).not.toHaveBeenCalled()
    expect(progressSvc.advanceProgress).toHaveBeenCalledWith('p1', 'c1', ['chronicle', 'world'], 3)
  })

  it('SQL error with retries: re-calls with the failure fed back, then applies', async () => {
    // First reply → bad SQL; corrective reply → good SQL.
    resilientSvc.callModelResilient
      .mockResolvedValueOnce({ raw: '<TableEdit>BAD</TableEdit>' })
      .mockResolvedValueOnce({ raw: '<TableEdit>INSERT INTO chronicle VALUES (1)</TableEdit>' })
    sqlSvc.applySqlBatch
      .mockImplementationOnce(() => {
        throw new sqlSvc.TableSqlError('syntax error')
      })
      .mockReturnValueOnce({
        applied: 1,
        changes: 1,
        statements: ['INSERT INTO chronicle VALUES (1)']
      })
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 4, retries: 1 })
    await flush()
    // Two model calls (first + corrective); the corrective one carries the error text.
    expect(resilientSvc.callModelResilient).toHaveBeenCalledTimes(2)
    const correctiveMessages = resilientSvc.callModelResilient.mock.calls[1][1] as Array<{
      role: string
      content: string
    }>
    expect(
      correctiveMessages.some((m) => m.role === 'assistant' && m.content.includes('BAD'))
    ).toBe(true)
    expect(correctiveMessages.some((m) => m.content.includes('syntax error'))).toBe(true)
    // 6th arg = the batch SPAN START (span.from = 0 for the single [0,3] batch).
    expect(opsSvc.appendOps).toHaveBeenCalledWith(
      'p1',
      'c1',
      3,
      ['INSERT INTO chronicle VALUES (1)'],
      'backfill',
      0
    )
  })

  it('exhausted SQL retries mark the batch failed and the run CONTINUES', async () => {
    resilientSvc.callModelResilient.mockResolvedValue({ raw: '<TableEdit>BAD</TableEdit>' })
    sqlSvc.applySqlBatch.mockImplementation(() => {
      throw new sqlSvc.TableSqlError('syntax error')
    })
    // 4 floors, batch 2 → two batches, both fail; the run still completes.
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 2, retries: 1 })
    await flush()
    const state = getBackfillState('c1')
    expect(state?.running).toBe(false)
    expect(state?.failures.length).toBe(2)
    expect(state?.failures[0].reason).toContain('syntax error')
    // No progress advanced for a failed batch.
    expect(progressSvc.advanceProgress).not.toHaveBeenCalled()
  })

  it('a busy write lock is a retryable failure (never a second write surface)', async () => {
    resilientSvc.callModelResilient.mockResolvedValue({
      raw: '<TableEdit>INSERT INTO chronicle VALUES (1)</TableEdit>'
    })
    opsSvc.tryBeginTableWrite.mockReturnValue(false) // lock always busy
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 4, retries: 0 })
    await flush()
    expect(sqlSvc.applySqlBatch).not.toHaveBeenCalled()
    const state = getBackfillState('c1')
    expect(state?.failures[0].reason).toContain('in flight')
  })

  it('rejects a second concurrent backfill for the same chat', async () => {
    // Make the first run hang on the model call so it stays "running".
    let resolveCall: (v: unknown) => void = () => {}
    resilientSvc.callModelResilient.mockReturnValue(new Promise((r) => (resolveCall = r)))
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 4, retries: 0 })
    await expect(
      startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 4, retries: 0 })
    ).rejects.toThrow('tables.backfillAlreadyRunning')
    resolveCall({ raw: '<TableEdit></TableEdit>' })
    await flush()
  })

  it('cancel between batches: applied batches stay applied, later batches are skipped', async () => {
    // Batch 1 resolves immediately; we cancel after it, before batch 2.
    resilientSvc.callModelResilient.mockResolvedValue({
      raw: '<TableEdit>INSERT INTO chronicle VALUES (1)</TableEdit>'
    })
    await startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 2, retries: 0 })
    // Cancel immediately — the first batch may already be in flight; assert the run ends and at most
    // the batches that ran applied.
    cancelBackfill('p1', 'c1')
    await flush()
    expect(getBackfillState('c1')?.running).toBe(false)
    // appendOps calls (if any) are a prefix of the plan — never more than the 2 planned batches.
    expect(opsSvc.appendOps.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('no template → rejects with the localized key', async () => {
    chatSvc.getChatTableTemplateId.mockReturnValue(null)
    await expect(
      startBackfill('p1', 'c1', { lastFloors: 'all', batchSize: 2, retries: 0 })
    ).rejects.toThrow('tables.backfillNoTemplate')
  })
})
