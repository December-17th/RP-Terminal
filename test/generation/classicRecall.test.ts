import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenContext } from '../../src/main/services/generation/types'
import type { RunContext } from '../../src/main/services/generation/runContext'

const gen = { profileId: 'p', chatId: 'c', userAction: 'act' } as GenContext

const stages = vi.hoisted(() => ({
  buildGenContext: vi.fn(),
  trimProcessedContext: vi.fn(),
  exportTableEntries: vi.fn(),
  runMemoryRecallAgent: vi.fn(),
  matchWorldInfo: vi.fn(),
  assemblePrompt: vi.fn(),
  sampleMainCall: vi.fn(),
  parseResponse: vi.fn(),
  computeMetrics: vi.fn(),
  foldState: vi.fn(),
  persistFloor: vi.fn()
}))

vi.mock('../../src/main/services/generation/genContext', () => ({
  buildGenContext: stages.buildGenContext
}))
vi.mock('../../src/main/services/generation/classicStages', () => ({
  trimProcessedContext: stages.trimProcessedContext,
  exportTableEntries: stages.exportTableEntries
}))
vi.mock('../../src/main/services/memoryRecallService', () => ({
  runMemoryRecallAgent: stages.runMemoryRecallAgent
}))
vi.mock('../../src/main/services/generation/assemble', () => ({
  matchWorldInfo: stages.matchWorldInfo,
  assemblePrompt: stages.assemblePrompt,
  // The build-time setvar capture brackets assembly with these two pure helpers. This suite pins the
  // RECALL seam, so they are stubbed to "nothing was written" rather than pulling the real assemble
  // module (and its whole service graph) back in — the capture itself is pinned in
  // classicTurnHazards.test.ts against the real path.
  snapshotTemplateVars: () => ({}),
  captureTemplateWrites: () => []
}))
vi.mock('../../src/main/services/generation/mainSample', () => ({
  sampleMainCall: stages.sampleMainCall
}))
vi.mock('../../src/main/services/generation/parseResponse', () => ({
  parseResponse: stages.parseResponse,
  computeMetrics: stages.computeMetrics
}))
vi.mock('../../src/main/services/generation/foldState', () => ({ foldState: stages.foldState }))
vi.mock('../../src/main/services/generation/persistFloor', () => ({
  persistFloor: stages.persistFloor
}))
vi.mock('../../src/main/services/yuzu/vnGate', () => ({
  runVnGate: vi.fn(),
  mergeYuzuMvu: vi.fn()
}))

import { runClassicTurnDirect } from '../../src/main/services/generation/classicTurn'

const ctx = (): RunContext => ({
  profileId: 'p',
  chatId: 'c',
  userAction: 'act',
  signal: new AbortController().signal,
  modelSignal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

beforeEach(() => {
  vi.clearAllMocks()
  stages.buildGenContext.mockReturnValue(gen)
  stages.trimProcessedContext.mockReturnValue(gen)
  stages.exportTableEntries.mockReturnValue({ entries: [], block: '' })
  stages.runMemoryRecallAgent.mockResolvedValue({
    block: 'RECALLED MEMORY',
    plotBlock: 'PLOT BLOCK',
    report: 'recalled 1 of 1 code(s), 0 note section(s)'
  })
  stages.matchWorldInfo.mockReturnValue([])
  stages.assemblePrompt.mockReturnValue({ sendMessages: [], params: {}, record: undefined })
  stages.sampleMainCall.mockResolvedValue({ raw: 'reply', rawUsage: {} })
  stages.parseResponse.mockReturnValue({ parsed: { events: [] }, mvu: {} })
  stages.computeMetrics.mockReturnValue({})
  stages.foldState.mockReturnValue({})
  stages.persistFloor.mockReturnValue({ floor: 1 })
})

describe('Classic direct recall seam', () => {
  it('runs recall before assembly and persists its display block on the resulting floor', async () => {
    await runClassicTurnDirect(ctx())

    expect(stages.runMemoryRecallAgent).toHaveBeenCalledWith(expect.anything(), gen)
    expect(stages.assemblePrompt).toHaveBeenCalledWith(gen, [], 'RECALLED MEMORY')
    expect(stages.persistFloor).toHaveBeenCalledWith(
      gen,
      expect.objectContaining({ plot_block: 'PLOT BLOCK' })
    )
    expect(stages.runMemoryRecallAgent.mock.invocationCallOrder[0]).toBeLessThan(
      stages.assemblePrompt.mock.invocationCallOrder[0]
    )
  })

  it('preserves the old empty-block path when recall no-ops', async () => {
    stages.runMemoryRecallAgent.mockResolvedValue(null)

    await runClassicTurnDirect(ctx())

    expect(stages.assemblePrompt).toHaveBeenCalledWith(gen, [], '')
    expect(stages.persistFloor).toHaveBeenCalledWith(
      gen,
      expect.not.objectContaining({ plot_block: expect.anything() })
    )
  })

  it('recalls from the untrimmed seed while assembling from the compacted context', async () => {
    const trimmed = { ...gen, floors: [], lastFloor: undefined } as GenContext
    stages.trimProcessedContext.mockReturnValue(trimmed)

    await runClassicTurnDirect(ctx())

    expect(stages.runMemoryRecallAgent).toHaveBeenCalledWith(expect.anything(), gen)
    expect(stages.assemblePrompt).toHaveBeenCalledWith(trimmed, [], 'RECALLED MEMORY')
  })
})
