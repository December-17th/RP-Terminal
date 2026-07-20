// Classic Narrator first execution plan — Milestone 3 (direct Classic player-generation orchestration).
//
// PARITY, not "the direct path works". Every case below runs the SAME turn twice against the SAME
// mocked leaves — once through `runWorkflow` on the real production doc, once through
// `runClassicTurnDirect` — and compares what actually left the process: the provider-bound message
// bytes and sampler params, and the persisted floor. A direct path that merely produces plausible
// output would pass a one-sided test and fail these.
//
// The harness is Milestone 2's oracle (test/workflow/classicTurnInventory.test.ts) verbatim: the REAL
// production doc, the REAL builtin registry, the REAL persistFloor, with only leaf I/O mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/services/agentPackService', () => ({
  enabledFragmentsFor: vi.fn(() => [])
}))

const floors = Array.from({ length: 3 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))

const chatState = vi.hoisted(() => ({ floorCount: 3 }))
const appendedFloors = vi.hoisted(() => [] as unknown[])
const mockChat = vi.hoisted(() => ({
  getChat: vi.fn(() => ({ character_id: 'w1', floor_count: chatState.floorCount })),
  getChatTableTemplateId: vi.fn<() => string | null>(() => null),
  getChatLorebookIds: vi.fn(() => null),
  getChatMode: vi.fn(() => 'explore'),
  isYuzuMode: vi.fn(() => false),
  getChatWorkflowId: vi.fn(() => null),
  getCachedWorldInfo: vi.fn(() => null),
  setCachedWorldInfo: vi.fn(),
  appendFloor: vi.fn((_p: string, _c: string, f: unknown) => {
    appendedFloors.push(f)
  })
}))
vi.mock('../../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn(() => floors[floors.length - 1]),
  getAllFloors: vi.fn(() => floors.slice(0, chatState.floorCount)),
  getFloorCount: vi.fn(() => chatState.floorCount),
  getFloorRequest: vi.fn(() => undefined),
  saveFloor: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => mockFloor)

const mockTemplateService = vi.hoisted(() => ({
  loadGlobals: vi.fn(() => ({})),
  saveGlobals: vi.fn()
}))
vi.mock('../../src/main/services/templateService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...mockTemplateService
}))

const mockRecordStore = vi.hoisted(() => ({ saveExecutionRecord: vi.fn() }))
vi.mock('../../src/main/services/executionRecordStore', () => mockRecordStore)

const mockFloorState = vi.hoisted(() => {
  const setBaseline = vi.fn()
  return {
    setBaseline,
    floorStateForChat: vi.fn(() => ({ setBaseline, append: vi.fn(), replay: vi.fn() }))
  }
})
vi.mock('../../src/main/services/agentRuntime/floorState', () => ({
  floorStateForChat: mockFloorState.floorStateForChat
}))

const mockTemplate = vi.hoisted(() => ({ getTableTemplateById: vi.fn(() => null as unknown) }))
vi.mock('../../src/main/services/tableTemplateService', () => mockTemplate)
const mockProgress = vi.hoisted(() => ({
  getProgress: vi.fn(() => ({}) as Record<string, number>),
  advanceProgress: vi.fn(),
  computeTableProgress: vi.fn(),
  resolveUpdateFrequency: (freq: number, globalDefault: number): number | null =>
    freq === 0 ? null : freq >= 1 ? freq : Math.max(1, Math.floor(globalDefault) || 3)
}))
vi.mock('../../src/main/services/tableProgressService', () => mockProgress)
vi.mock('../../src/main/services/tableStatusService', () => ({
  getTablesStatus: vi.fn(() => ({}))
}))
const mockSql = vi.hoisted(() => ({
  applySqlBatch: vi.fn(),
  executeReadQuery: vi.fn(),
  TableSqlError: class extends Error {}
}))
vi.mock('../../src/main/services/tableSql', () => mockSql)
vi.mock('../../src/main/services/tableDbService', () => ({ readAllTables: vi.fn(() => []) }))
vi.mock('../../src/main/services/tableOpsService', () => ({
  appendOps: vi.fn(),
  tryBeginTableWrite: vi.fn(() => true),
  endTableWrite: vi.fn()
}))

/** The ONE provider seam — the bytes that leave the process. */
const mockCallModel = vi.hoisted(() => ({
  callModel: vi.fn(async () => ({ raw: 'The door opens.', rawUsage: {}, stopped: false }))
}))
vi.mock('../../src/main/services/generation/callModel', () => mockCallModel)

vi.mock('../../src/main/services/workflowEvents', () => ({
  notifyWorkflowTrace: vi.fn(),
  notifyWorkflowPanel: vi.fn(),
  notifyWorkflowActivity: vi.fn()
}))
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

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
  getCharacter: () => ({ id: 'w1', data: { name: 'C', description: 'calm', extensions: {} } })
}))
vi.mock('../../src/main/services/lorebookService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLorebookById: () => ({ id: 'w1', name: 'lb', entries: [] })
}))
vi.mock('../../src/main/services/regexService', () => ({
  getPromptRules: () => [],
  getWorldInfoRules: () => []
}))
/** Lets a case plant a real `{{setvar}}` in the preset's first prompt block so a BUILD-TIME variable
 *  mutation genuinely fires during assembly (the `gen.workingVars` by-reference channel). */
const presetState = vi.hoisted(() => ({ macro: '' }))
vi.mock('../../src/main/services/presetService', () => ({
  getActivePreset: () => {
    const preset = getDefaultPreset()
    if (presetState.macro) {
      const main = preset.prompts.find((p) => p.identifier === 'main')!
      main.content = `${main.content}\n${presetState.macro}`
    }
    return preset
  },
  getActivePresetId: () => 'p'
}))

import { runWorkflow } from '../../src/main/services/workflowEngine'
import { runClassicTurnDirect } from '../../src/main/services/generation/classicTurn'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { RunContext } from '../../src/main/services/nodes/types'
import { BUILTIN_DEFAULT_DOC } from '../../src/main/services/workflowStore'
import { GenContext } from '../../src/main/services/generation/types'

const productionDoc = () => structuredClone(BUILTIN_DEFAULT_DOC)

/** The two-signal turn context (turnContext.ts's shape): `signal` is the GRAPH signal, `modelSignal`
 *  the user's Stop. Both paths consume exactly this. */
const turnCtx = (over: Partial<RunContext> = {}): RunContext => {
  const graph = new AbortController()
  return {
    profileId: 'prof',
    chatId: 'c1',
    workflowId: 'default',
    userAction: 'open the door',
    signal: graph.signal,
    abortGraph: () => graph.abort(),
    streamMain: () => {},
    emitPanel: () => {},
    getNodeState: () => undefined,
    setNodeState: () => {},
    ...over
  }
}

const CLASSIC_TURN_ORDER = ['ctx', 'trim', 'export', 'assemble', 'llm', 'parse', 'apply', 'write']
const ranInOrder = (traces: { nodeId: string; status: string }[]): string[] =>
  traces.filter((t) => t.status === 'ran').map((t) => t.nodeId)

/** Per-node trace outcome, ORDER PRESERVED (timings stripped — they are wall-clock). */
const shape = (traces: { nodeId: string; status: string; phase: string }[]): unknown[] =>
  traces.map((t) => ({ nodeId: t.nodeId, status: t.status, phase: t.phase }))

/** The provider-bound request: the exact ordered message array and the resolved sampler params. */
const providerRequest = (): { messages: unknown; params: unknown; calls: number } => ({
  messages: mockCallModel.callModel.mock.calls[0]?.[1],
  params: mockCallModel.callModel.mock.calls[0]?.[2],
  calls: mockCallModel.callModel.mock.calls.length
})

/** The persisted floor with its wall-clock stamps removed — everything else must match byte for byte. */
const persistedFloor = (): unknown => {
  const f = appendedFloors[0] as Record<string, unknown> | undefined
  if (!f) return null
  const { timestamp: _t, user_message, metrics, ...rest } = f as Record<string, any>
  const { timestamp: _ut, ...user } = user_message ?? {}
  // `metrics.turn.ts` is a wall-clock stamp taken inside the turn; everything else about the floor —
  // including every other metrics field, token count, and usage number — must match byte for byte.
  const { ts: _mts, ...turnRest } = metrics?.turn ?? {}
  return { ...rest, user_message: user, metrics: { ...metrics, turn: turnRest } }
}

/** Restore every mock to its clean-turn state. Deliberately does NOT touch `chatState.floorCount`, so
 *  a case can select the opening turn once and have BOTH paths observe it. */
const reset = (): void => {
  appendedFloors.length = 0
  vi.clearAllMocks()
  mockChat.getChat.mockImplementation(() => ({
    character_id: 'w1',
    floor_count: chatState.floorCount
  }))
  mockChat.getChatTableTemplateId.mockReturnValue(null)
  mockChat.getChatLorebookIds.mockReturnValue(null)
  mockChat.getChatMode.mockReturnValue('explore')
  mockChat.isYuzuMode.mockReturnValue(false)
  mockChat.getCachedWorldInfo.mockReturnValue(null)
  mockFloor.getAllFloors.mockImplementation(() => floors.slice(0, chatState.floorCount))
  mockFloor.getFloorCount.mockImplementation(() => chatState.floorCount)
  mockFloor.getFloor.mockReturnValue(floors[floors.length - 1])
  mockFloor.getFloorRequest.mockReturnValue(undefined)
  mockTemplate.getTableTemplateById.mockReturnValue(null)
  mockProgress.getProgress.mockReturnValue({})
  mockTemplateService.loadGlobals.mockReturnValue({})
  mockFloorState.floorStateForChat.mockImplementation(() => ({
    setBaseline: mockFloorState.setBaseline,
    append: vi.fn(),
    replay: vi.fn()
  }))
  mockCallModel.callModel.mockResolvedValue({
    raw: 'The door opens.',
    rawUsage: {},
    stopped: false
  })
}

beforeEach(() => {
  presetState.macro = ''
  chatState.floorCount = 3
  reset()
})

/** Run one turn on each path against identical mock state, returning both observations. */
const bothPaths = async (
  over: Partial<RunContext> = {}
): Promise<{
  workflow: { request: ReturnType<typeof providerRequest>; floor: unknown; result: any }
  direct: { request: ReturnType<typeof providerRequest>; floor: unknown; result: any }
}> => {
  reset()
  const wfResult = await runWorkflow(productionDoc(), builtinRegistry, turnCtx(over))
  const workflow = { request: providerRequest(), floor: persistedFloor(), result: wfResult }

  reset()
  const dResult = await runClassicTurnDirect(productionDoc(), turnCtx(over))
  const direct = { request: providerRequest(), floor: persistedFloor(), result: dResult }

  return { workflow, direct }
}

// ── Parity: the bytes and the persisted state ─────────────────────────────────────────────────────
//
// M5a note: the `classicShape` predicate and the `runWorkflow` fallback are gone — generate() now always
// takes the direct path. This suite survives as a PARITY pin: it still runs the SAME turn through the
// (still-present, M5b-doomed) engine and through `runClassicTurnDirect` against identical mocked leaves,
// proving the direct path reproduces the engine byte-for-byte before the engine is deleted.

describe('Milestone 3 — provider-byte and persisted-floor parity', () => {
  it('sends the IDENTICAL ordered message array and sampler params', async () => {
    const { workflow, direct } = await bothPaths()

    expect(direct.request.calls).toBe(1)
    expect(workflow.request.calls).toBe(1)
    expect(direct.request.messages).toEqual(workflow.request.messages)
    expect(direct.request.params).toEqual(workflow.request.params)
    // Not vacuous: a real prompt actually went out.
    expect((direct.request.messages as unknown[]).length).toBeGreaterThan(0)
  })

  it('persists an IDENTICAL floor', async () => {
    const { workflow, direct } = await bothPaths()

    expect(direct.floor).toEqual(workflow.floor)
    expect(direct.floor).toBeTruthy()
  })

  it('performs the same durable writes exactly once each', async () => {
    reset()
    await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(mockTemplateService.saveGlobals).toHaveBeenCalledTimes(1)
    expect(mockChat.appendFloor).toHaveBeenCalledTimes(1)
    expect(mockRecordStore.saveExecutionRecord).toHaveBeenCalledTimes(1)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('makes EXACTLY ONE provider call — the memory node is never reached', async () => {
    reset()
    await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
  })

  it('runs the same eight stages, in the same order', async () => {
    const { workflow, direct } = await bothPaths()

    expect(ranInOrder(direct.result.traces)).toEqual(CLASSIC_TURN_ORDER)
    expect(ranInOrder(direct.result.traces)).toEqual(ranInOrder(workflow.result.traces))
  })

  it('holds parity on the OPENING turn too (floor 0 — the FloorState baseline branch)', async () => {
    chatState.floorCount = 0
    const { workflow, direct } = await bothPaths()

    expect(direct.floor).toEqual(workflow.floor)
    expect(direct.request.messages).toEqual(workflow.request.messages)
    expect(mockFloorState.setBaseline).toHaveBeenCalledTimes(1)
  })
})

// ── The four off-port side channels ───────────────────────────────────────────────────────────────

describe('Milestone 3 — the four off-port channels survive the direct path', () => {
  it('threads ONE shared GenContext through every stage', async () => {
    reset()
    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    // Not merely equal — the SAME object (no template bound ⇒ trim is the identity).
    expect(res.outputs.get('trim')?.gen).toBe(gen)
  })

  it('stamps gen.executionRecord at assembly and persists THAT object', async () => {
    reset()
    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(gen.executionRecord).toBeDefined()
    expect(mockRecordStore.saveExecutionRecord.mock.calls[0][2]).toBe(gen.executionRecord)
  })

  it('stamps gen.floorStateBaseline on the opening turn and hands THAT object to FloorState', async () => {
    chatState.floorCount = 0
    reset()
    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(gen.floorStateBaseline).toBeDefined()
    expect(mockFloorState.setBaseline.mock.calls[0][1]).toBe(gen.floorStateBaseline)
  })

  it('folds onto the SHARED gen.workingVars object, and persists that same object', async () => {
    reset()
    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(res.outputs.get('apply')?.variables).toBe(gen.workingVars)
    expect((appendedFloors[0] as { variables: unknown }).variables).toBe(gen.workingVars)
  })

  it('a real BUILD-TIME {{setvar}} reaches the persisted floor on BOTH paths, identically', async () => {
    // The subtlest channel and the highest-risk regression: assemble.ts builds its template context
    // from `gen.workingVars` BY REFERENCE ("PARITY HAZARD"), so this value exists only because the
    // object is shared. Copy instead of share and the turn still SUCCEEDS — the variable just
    // silently vanishes. That is why this is asserted against the workflow path, not in isolation.
    presetState.macro = '{{setvar::probeVar::planted-at-build}}'
    const { workflow, direct } = await bothPaths()

    expect((direct.floor as any).variables.probeVar).toBe('planted-at-build')
    expect((workflow.floor as any).variables.probeVar).toBe('planted-at-build')
    expect(direct.floor).toEqual(workflow.floor)
  })

  it('the build-time mutation and this turn’s fold coexist on the one object', async () => {
    presetState.macro = '{{setvar::probeVar::planted-at-build}}'
    reset()
    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(gen.workingVars.probeVar).toBe('planted-at-build')
    expect(res.outputs.get('apply')?.variables).toBe(gen.workingVars)
  })
})

// ── Response timing, abort, and failure ───────────────────────────────────────────────────────────

describe('Milestone 3 — response timing, abort, and failure classification', () => {
  it('fires onResponseReady with all eight stages done and the floor ALREADY persisted', async () => {
    reset()
    // Captured per CALL, not overwritten: the hand-off must happen exactly once, and the floor must
    // already be on disk at THAT moment. Recording only the last call would hide an early hand-off.
    const handoffs: { keys: string[]; appended: number; floor: unknown }[] = []
    await runClassicTurnDirect(
      productionDoc(),
      turnCtx({
        onResponseReady: (outputs) => {
          handoffs.push({
            keys: [...outputs.keys()],
            appended: appendedFloors.length,
            floor: outputs.get('write')?.floor
          })
        }
      })
    )

    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].keys).toEqual(CLASSIC_TURN_ORDER)
    expect(handoffs[0].appended).toBe(1) // the durable write precedes the hand-off
    expect(handoffs[0].floor).toBeTruthy()
  })

  it('abort-with-EMPTY persists nothing, aborts the run, and never fires onResponseReady', async () => {
    reset()
    mockCallModel.callModel.mockResolvedValue(null as never)
    const ready = vi.fn()

    const res = await runClassicTurnDirect(productionDoc(), turnCtx({ onResponseReady: ready }))

    expect(res.aborted).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.error).toBeUndefined() // an abort is NOT an error — generate() must return null
    expect(ready).not.toHaveBeenCalled()
    expect(mockChat.appendFloor).not.toHaveBeenCalled()
  })

  it('abort-with-TEXT still persists the partial floor, identically to the workflow path', async () => {
    // The user pressed Stop but tokens had already arrived: callModel returns {stopped:true, raw}.
    // Nothing aborts the GRAPH signal, so parse/apply/write must still run.
    const partial = { raw: 'The door ope', rawUsage: {}, stopped: true }
    reset()
    mockCallModel.callModel.mockResolvedValue(partial)
    const wf = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())
    const wfFloor = persistedFloor()

    reset()
    mockCallModel.callModel.mockResolvedValue(partial)
    const direct = await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(direct.ok).toBe(true)
    expect(wf.ok).toBe(true)
    expect(mockChat.appendFloor).toHaveBeenCalledTimes(1)
    expect(persistedFloor()).toEqual(wfFloor)
    expect((persistedFloor() as any).response.content).toBe('The door ope')
  })

  it('a hard provider failure surfaces as a fatal RESULT, never as a silent null', async () => {
    reset()
    mockCallModel.callModel.mockRejectedValue(new Error('provider exploded'))

    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(res.ok).toBe(false)
    expect(res.aborted).toBe(false)
    expect(res.error?.message).toContain('provider exploded')
    expect(res.error?.nodeId).toBe('llm')
    expect(mockChat.appendFloor).not.toHaveBeenCalled()
    // The failing stage is traced 'failed' — the run drawer shows WHERE the turn died.
    expect(res.traces.find((t) => t.nodeId === 'llm')?.status).toBe('failed')
  })

  it('classifies the same failure the same way on both paths', async () => {
    reset()
    mockCallModel.callModel.mockRejectedValue(new Error('provider exploded'))
    const wf = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    reset()
    mockCallModel.callModel.mockRejectedValue(new Error('provider exploded'))
    const direct = await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(direct.ok).toBe(wf.ok)
    expect(direct.aborted).toBe(wf.aborted)
    expect(direct.error?.nodeId).toBe(wf.error?.nodeId)
    expect(direct.error?.kind).toBe(wf.error?.kind)
    expect(direct.error?.message).toBe(wf.error?.message)
  })

  it('streams deltas to the renderer', async () => {
    reset()
    mockCallModel.callModel.mockImplementation((async (
      _gen: unknown,
      _msgs: unknown,
      _params: unknown,
      onDelta: (d: string) => void
    ) => {
      onDelta('The door ')
      onDelta('opens.')
      return { raw: 'The door opens.', rawUsage: {}, stopped: false }
    }) as never)
    const deltas: string[] = []

    await runClassicTurnDirect(productionDoc(), turnCtx({ streamMain: (d) => deltas.push(d) }))

    expect(deltas).toEqual(['The door ', 'opens.'])
  })
})

// ── Run history ───────────────────────────────────────────────────────────────────────────────────

describe('Milestone 3 — run history is still recorded on the direct path', () => {
  it('returns a trace covering EVERY node of the doc, so summarizeRun/appendRun see a full run', async () => {
    // generationService feeds this RunResult to the unchanged summarizeRun → notifyWorkflowTrace →
    // appendRun block. A direct path emitting no traces would silently delete Classic run history.
    const { workflow, direct } = await bothPaths()
    const doc = productionDoc()

    expect(new Set(direct.result.traces.map((t: any) => t.nodeId))).toEqual(
      new Set(doc.nodes.map((n) => n.id))
    )
    // Same per-node status and phase as the engine produced — IN THE SAME ORDER. The Runs timeline
    // renders rows in trace order, so an out-of-sequence synthesized trace shows the user a
    // different-looking run for the same turn. Deliberately NOT sorted: sorting would hide exactly
    // that. The excluded trigger nodes therefore have to head the trace, not trail it.
    expect(shape(direct.result.traces)).toEqual(shape(workflow.result.traces))
  })

  it('matches the engine’s trace order on the ABORT path too', async () => {
    reset()
    mockCallModel.callModel.mockResolvedValue(null as never)
    const wf = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    reset()
    mockCallModel.callModel.mockResolvedValue(null as never)
    const direct = await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(shape(direct.traces)).toEqual(shape(wf.traces))
  })

  it('matches the engine’s trace order on the FATAL path — which traces NEITHER the remaining pre nodes NOR the post phase', async () => {
    // The engine returns from its node loop the moment a pre-phase node fails unwired, so the run
    // record stops at the failure. Synthesizing skip rows past it would invent a run that never
    // happened.
    reset()
    mockCallModel.callModel.mockRejectedValue(new Error('provider exploded'))
    const wf = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    reset()
    mockCallModel.callModel.mockRejectedValue(new Error('provider exploded'))
    const direct = await runClassicTurnDirect(productionDoc(), turnCtx())

    expect(shape(direct.traces)).toEqual(shape(wf.traces))
    expect(direct.traces.some((t) => t.nodeId === 'write')).toBe(false)
  })

  it('carries per-stage timings and the outputs the run drawer previews', async () => {
    reset()
    const res = await runClassicTurnDirect(productionDoc(), turnCtx())

    for (const t of res.traces.filter((t) => t.status === 'ran')) {
      expect(typeof t.ms).toBe('number')
    }
    expect(res.outputs.get('llm')?.raw).toBe('The door opens.')
    expect(res.outputs.get('write')?.floor).toBeTruthy()
  })
})
