// Classic Narrator first execution plan — Milestone 2 (characterize the remaining workflow dependency).
//
// This file is EVIDENCE, not behavior: it pins exactly what `runWorkflow` still contributes to a real
// production Classic turn, so Milestone 3 (removing `runWorkflow` from the synchronous Classic path)
// can prove it changed nothing. Nothing here is a design statement — every assertion is a photograph
// of current production behavior.
//
// It runs the REAL production doc (`BUILTIN_DEFAULT_DOC`, i.e. buildDefaultMemoryDocV2) through the
// REAL engine and the REAL builtin node registry. Only LEAF I/O is mocked (provider call, chat/floor
// storage, table services) — the nodes, wiring, phase split, prune rules, and persist stage are the
// production ones. `persistFloor` is deliberately NOT mocked: milestone 3 must prove persistence
// parity, so its four durable writes are observed at their real call sites.
//
// The mock harness is the proven one from defaultMemoryTemplate.test.ts / memoryFillChain.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// No agent packs compose here — the zero-fragment case. Which packs are actually enabled in
// production is a separate question, pinned against the REAL provider registration in the companion
// suite `classicDocResolution.test.ts`.
vi.mock('../../src/main/services/agentPackService', () => ({ enabledFragmentsFor: vi.fn(() => []) }))

const floors = Array.from({ length: 3 }, (_, i) => ({
  floor: i,
  user_message: { content: `player action ${i}` },
  response: { content: `ai reply ${i}` },
  variables: {}
}))

/** Mutable so a test can drive the floor-0 (opening-turn) branch of persistFloor's baseline write. */
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

// ── The four durable writers `output.writeFloor` reaches (persistFloor.ts) ────────────────────────
const mockTemplateService = vi.hoisted(() => ({ loadGlobals: vi.fn(() => ({})), saveGlobals: vi.fn() }))
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

// ── Table services: unbound template (the default, fail-soft state) ───────────────────────────────
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
vi.mock('../../src/main/services/tableStatusService', () => ({ getTablesStatus: vi.fn(() => ({})) }))
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

// The ONE provider seam. Every model call on a turn must land here — the count IS the evidence.
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
/** Lets a test plant a real `{{setvar}}` macro in the preset's first prompt block, so a BUILD-TIME
 *  variable mutation genuinely fires during assembly (the `gen.workingVars` channel). Empty by
 *  default — every other test sees the stock default preset. */
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
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import { RunContext } from '../../src/main/services/nodes/types'
import { BUILTIN_DEFAULT_DOC } from '../../src/main/services/workflowStore'
import { GenContext } from '../../src/main/services/generation/types'

/** The production doc, fresh per run (the engine never mutates it, but identity hygiene is cheap). */
const productionDoc = () => structuredClone(BUILTIN_DEFAULT_DOC)

const turnCtx = (over: Partial<RunContext> = {}): RunContext => ({
  profileId: 'prof',
  chatId: 'c1',
  workflowId: 'default',
  userAction: 'open the door',
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {},
  ...over
})

/** The eight nodes a Classic turn runs, IN ORDER. Milestone 3 must reproduce exactly this sequence
 *  of work; a node added, dropped, or reordered breaks the tests below. */
const CLASSIC_TURN_ORDER = ['ctx', 'trim', 'export', 'assemble', 'llm', 'parse', 'apply', 'write']

/** The five nodes present in the production doc that a turn NEVER reaches, and why:
 *  · trigger-cadence / trigger-state — `isTrigger`, removed by computeExcluded (workflowEngine.ts);
 *  · mode — both incoming signal edges are dead, so the `gatedOff` prune rule skips it;
 *  · maintain — its sole `when` input comes from the pruned `mode`. This is the doc's SECOND
 *    model-backed node; it is structurally unreachable from a turn (it fires only via
 *    evaluateDocTriggers, on the detached post-turn pass);
 *  · log-apply — fed only by maintain.error. */
const NEVER_ON_A_TURN = ['trigger-cadence', 'trigger-state', 'mode', 'maintain', 'log-apply']

const ranInOrder = (traces: { nodeId: string; status: string }[]): string[] =>
  traces.filter((t) => t.status === 'ran').map((t) => t.nodeId)

beforeEach(() => {
  chatState.floorCount = 3
  appendedFloors.length = 0
  presetState.macro = ''
  vi.clearAllMocks()
  mockChat.getChat.mockImplementation(() => ({ character_id: 'w1', floor_count: chatState.floorCount }))
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
  mockCallModel.callModel.mockResolvedValue({ raw: 'The door opens.', rawUsage: {}, stopped: false })
})

// ── A1. The node inventory: exact set and exact order ─────────────────────────────────────────────

describe('Classic turn inventory — which nodes run, in which order', () => {
  it('runs exactly eight nodes, in exactly this order', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    // ORDER, not just membership: `toEqual` on an array is position-sensitive, so a reorder fails.
    expect(ranInOrder(res.traces)).toEqual(CLASSIC_TURN_ORDER)
    expect(res.ok).toBe(true)
  })

  it('pins each running node to its NODE TYPE, so swapping an implementation is caught', async () => {
    const doc = productionDoc()
    const res = await runWorkflow(doc, builtinRegistry, turnCtx())
    const typeOf = new Map(doc.nodes.map((n) => [n.id, n.type]))

    expect(ranInOrder(res.traces).map((id) => typeOf.get(id))).toEqual([
      'input.context',
      'context.trimProcessed',
      'table.export',
      'prompt.assemble',
      'llm.sample',
      'parse.response',
      'apply.state',
      'output.writeFloor'
    ])
  })

  it('accounts for every node in the doc — nothing runs unobserved', async () => {
    const doc = productionDoc()
    const res = await runWorkflow(doc, builtinRegistry, turnCtx())

    // Every node is traced, and every trace is one of the two expected outcomes (no 'failed').
    expect(new Set(res.traces.map((t) => t.nodeId))).toEqual(new Set(doc.nodes.map((n) => n.id)))
    expect(doc.nodes).toHaveLength(13)
    expect(new Set(res.traces.map((t) => t.status))).toEqual(new Set(['ran', 'skipped']))
  })

  it('every node that runs is SYNCHRONOUS — all eight complete in the pre phase', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    for (const t of res.traces.filter((t) => t.status === 'ran')) expect(t.phase).toBe('pre')
  })

  it('no node fails soft: a clean turn carries no failedOpen flag', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    for (const t of res.traces) expect(t.failedOpen).toBeUndefined()
  })
})

// ── A2. The unreachable nodes, and the second provider call that must never happen ────────────────

describe('Classic turn inventory — the five nodes a turn never reaches', () => {
  it('skips every memory-group node', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())
    const status = new Map(res.traces.map((t) => [t.nodeId, t.status]))

    for (const id of NEVER_ON_A_TURN) expect(status.get(id)).toBe('skipped')
    // The two lists partition the doc: 8 ran + 5 skipped = 13 nodes, no overlap.
    expect([...CLASSIC_TURN_ORDER, ...NEVER_ON_A_TURN].sort()).toEqual(
      productionDoc()
        .nodes.map((n) => n.id)
        .sort()
    )
  })

  it('makes EXACTLY ONE provider call per turn — memory.maintain never fires', async () => {
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    // `memory.maintain` is the doc's other model-backed node. If it ever reached a turn this count
    // would be 2 — the single most important regression this milestone guards.
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
  })

  it('writes no memory table on a turn', async () => {
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(mockSql.applySqlBatch).not.toHaveBeenCalled()
    expect(mockProgress.advanceProgress).not.toHaveBeenCalled()
  })

  it('stays single-call and skip-only regardless of the memory Mode setting', async () => {
    // Turn behavior is mode-INDEPENDENT: the group is trigger-rooted, so `selected` cannot reach it.
    for (const selected of ['every_turn', 'async', 'off']) {
      vi.clearAllMocks()
      mockCallModel.callModel.mockResolvedValue({ raw: 'r', rawUsage: {}, stopped: false })
      const doc = productionDoc()
      const mode = doc.nodes.find((n) => n.id === 'mode')!
      mode.config = { ...(mode.config as Record<string, unknown>), selected }

      const res = await runWorkflow(doc, builtinRegistry, turnCtx())

      expect(ranInOrder(res.traces)).toEqual(CLASSIC_TURN_ORDER)
      expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
    }
  })
})

// ── A3. The synchronous / detached boundary ───────────────────────────────────────────────────────

describe('Classic turn inventory — what has completed when the response is returned', () => {
  it('fires onResponseReady with all eight nodes already done, the floor among them', async () => {
    let readyKeys: string[] | null = null
    let readyFloor: unknown = null
    const ctx = turnCtx({
      onResponseReady: (outputs) => {
        readyKeys = [...outputs.keys()]
        readyFloor = outputs.get('write')?.floor
      }
    })

    await runWorkflow(productionDoc(), builtinRegistry, ctx)

    // The whole synchronous chain — persistence included — is complete at the hand-off.
    expect(readyKeys).toEqual(CLASSIC_TURN_ORDER)
    expect(readyFloor).toBeTruthy()
  })

  it('has already persisted the floor BEFORE the response is handed over', async () => {
    // Ordering evidence: the durable write is inside the synchronous phase, not after it. Milestone 3
    // must keep persistence ahead of the return, or a renderer can read a chat without its new floor.
    let appendedAtReady = -1
    const ctx = turnCtx({ onResponseReady: () => (appendedAtReady = appendedFloors.length) })

    await runWorkflow(productionDoc(), builtinRegistry, ctx)

    expect(appendedAtReady).toBe(1)
    expect(mockChat.appendFloor).toHaveBeenCalledTimes(1)
  })

  it('runs NOTHING user-relevant in the detached post phase — every post trace is a skip', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const post = res.traces.filter((t) => t.phase === 'post')
    // On THIS doc the post phase holds only already-excluded/gated nodes. The genuinely detached
    // turn work (trace summarize + notifyWorkflowTrace, appendRun history, evaluateTriggers,
    // evaluateDocTriggers) lives OUTSIDE runWorkflow, chained on runPromise in generationService.
    for (const t of post) expect(t.status).toBe('skipped')
    expect(post.every((t) => NEVER_ON_A_TURN.includes(t.nodeId))).toBe(true)
  })

  it('BUT the empty post phase is a property of THIS DOC, not of the engine — an edited doc populates it', async () => {
    // The load-bearing caveat for Milestone 3. "runWorkflow contributes no detached work" is true of
    // the default doc's SHAPE, not of the Classic path. The default doc is user-EDITABLE (the seeded
    // copy — see classicDocResolution.test.ts), and any node downstream of the main output lands in
    // the detached post phase and RUNS there. Removing runWorkflow from the Classic path therefore
    // drops this capability for edited docs; it is a real behavior change, not a no-op.
    const doc = productionDoc()
    doc.nodes.push({ id: 'after-write', type: 'util.log', config: { label: 'post' }, position: { x: 0, y: 0 } })
    doc.edges.push({ from: { node: 'write', port: 'floor' }, to: { node: 'after-write', port: 'value' } })

    const res = await runWorkflow(doc, builtinRegistry, turnCtx())

    const added = res.traces.find((t) => t.nodeId === 'after-write')
    expect(added?.phase).toBe('post')
    expect(added?.status).toBe('ran') // detached, AFTER the response was handed over
  })
})

// ── A4. The durable side effects of output.writeFloor ─────────────────────────────────────────────

describe('Classic turn inventory — output.writeFloor is the only durable-state writer', () => {
  it('performs its three unconditional writes exactly once: saveGlobals, appendFloor, saveExecutionRecord', async () => {
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(mockTemplateService.saveGlobals).toHaveBeenCalledTimes(1)
    expect(mockChat.appendFloor).toHaveBeenCalledTimes(1)
    expect(mockRecordStore.saveExecutionRecord).toHaveBeenCalledTimes(1)
  })

  it('appends a floor carrying the turn action, the raw reply, and the request array', async () => {
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const floor = appendedFloors[0] as {
      floor: number
      user_message: { content: string }
      response: { content: string }
      request: unknown[]
      variables: unknown
      metrics: unknown
    }
    expect(floor.floor).toBe(3) // chat.floor_count — the next floor index
    expect(floor.user_message.content).toBe('open the door')
    expect(floor.response.content).toBe('The door opens.') // LOSSLESS: the unparsed raw
    expect(Array.isArray(floor.request)).toBe(true)
    expect(floor.request.length).toBeGreaterThan(0)
    expect(floor.variables).toBeDefined()
    expect(floor.metrics).toBeDefined()
  })

  it('saves the execution record under the SAME floor index it just appended', async () => {
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const [chatId, floorIndex, record] = mockRecordStore.saveExecutionRecord.mock.calls[0]
    expect(chatId).toBe('c1')
    expect(floorIndex).toBe(3)
    expect(record).toBeTruthy()
  })

  it('sets the FloorState baseline on floor 0 only', async () => {
    chatState.floorCount = 0 // the opening turn
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(mockFloorState.setBaseline).toHaveBeenCalledTimes(1)
    expect(mockFloorState.setBaseline.mock.calls[0][0]).toBe('c1')
  })

  it('does NOT set the baseline on any later floor', async () => {
    chatState.floorCount = 3
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(mockFloorState.setBaseline).not.toHaveBeenCalled()
  })

  it('no OTHER node writes durable state — the seven upstream nodes are side-effect free here', async () => {
    // Proven by elimination: if any upstream node persisted, these counts would exceed one.
    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockChat.appendFloor).toHaveBeenCalledTimes(1)
    expect(mockTemplateService.saveGlobals).toHaveBeenCalledTimes(1)
  })
})

// ── A5. The soft-failure behaviors of the two recall nodes ────────────────────────────────────────

describe('Classic turn inventory — recall nodes fail soft with no table template bound', () => {
  it('table.export returns NO entries when no table template is bound', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(res.traces.find((t) => t.nodeId === 'export')?.status).toBe('ran')
    expect(res.outputs.get('export')?.entries).toEqual([])
  })

  it('context.trimProcessed is the IDENTITY without a progress pointer — same gen object, untrimmed', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const fromCtx = res.outputs.get('ctx')?.gen as GenContext
    const fromTrim = res.outputs.get('trim')?.gen as GenContext
    // Not merely equal — the SAME object. With no template the node returns its input untouched
    // (resolveProcessedPointer yields -1 → carry the full history).
    expect(fromTrim).toBe(fromCtx)
    expect(fromTrim.floors).toHaveLength(3)
  })

  it('neither soft failure perturbs the prompt or aborts the turn', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    expect(res.ok).toBe(true)
    expect(res.aborted).toBe(false)
    expect(res.error).toBeUndefined()
    expect(mockCallModel.callModel).toHaveBeenCalledTimes(1)
  })
})

// ── A6. The hidden gen-context side channels (NOT graph ports) ────────────────────────────────────

describe('Classic turn inventory — the hidden side channels a port-only rewrite would drop', () => {
  it('carries ONE shared GenContext object from ctx all the way to write', async () => {
    // The whole side-channel mechanism: `gen` is one mutable object threaded through every node, so a
    // node can hand data downstream WITHOUT a wire. Milestone 3 must preserve the channels below.
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(res.outputs.get('trim')?.gen).toBe(gen)
  })

  it('prompt.assemble stamps gen.executionRecord, and output.writeFloor persists THAT object', async () => {
    // The record travels assemble → write on the gen object, NOT through any port. A naive rewrite
    // that wires only the declared ports would silently stop persisting execution records — the
    // forensic prompt/response evidence Milestone 1 was told to keep inspectable.
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(gen.executionRecord).toBeDefined()
    // Identity: the exact object assemble stamped is the one that reached the store.
    expect(mockRecordStore.saveExecutionRecord.mock.calls[0][2]).toBe(gen.executionRecord)
    // And it is genuinely off-port: `executionRecord` is not an output port of the assemble node.
    const assembleNode = builtinRegistry.get('prompt.assemble')!
    expect(assembleNode.outputs.map((p) => p.name)).not.toContain('executionRecord')
  })

  it('apply.state stamps gen.floorStateBaseline on the opening turn, and write consumes it', async () => {
    // A SECOND off-port channel (generation/foldState.ts): on floor 0 the fold captures the initial
    // variables onto `gen`, and persistFloor uses it for FloorState.setBaseline. No port carries it.
    chatState.floorCount = 0
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(gen.floorStateBaseline).toBeDefined()
    expect(mockFloorState.setBaseline.mock.calls[0][1]).toBe(gen.floorStateBaseline)
  })

  it('apply.state folds onto the SHARED gen.workingVars object, not a copy', async () => {
    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    // foldState.ts documents `variables === ctx.workingVars`. Identity, not equality: the fold
    // mutates the shared object in place, and that same object is what write persists.
    expect(res.outputs.get('apply')?.variables).toBe(gen.workingVars)
    const floor = appendedFloors[0] as { variables: unknown }
    expect(floor.variables).toBe(gen.workingVars)
  })

  it('a BUILD-TIME setvar during assemble survives the fold and reaches the persisted floor', async () => {
    // The FOURTH off-port channel, and the subtlest. `assemble.ts` calls buildTemplateContext with
    // `ctx.workingVars` BY REFERENCE (never cloned — its "PARITY HAZARD" comment), so a template
    // `{{setvar}}` evaluated while BUILDING the prompt mutates the shared object; `foldState` then
    // folds this turn's events on top of those same mutations. Nothing carries the value between
    // assemble and apply except the shared `gen` — no port does.
    presetState.macro = '{{setvar::probeVar::planted-at-build}}'

    await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const floor = appendedFloors[0] as { variables: Record<string, unknown> }
    // Were the template context built from a COPY, the value would be lost here silently — the turn
    // would still succeed, the floor would just quietly miss the variable.
    expect(floor.variables.probeVar).toBe('planted-at-build')
  })

  it('the build-time mutation and the fold coexist on the same object', async () => {
    // Guards the ordering too: the fold must not clobber build-time keys, and the build must not
    // strand the fold's own output. Both must be present on the one persisted object.
    presetState.macro = '{{setvar::probeVar::planted-at-build}}'

    const res = await runWorkflow(productionDoc(), builtinRegistry, turnCtx())

    const gen = res.outputs.get('ctx')?.gen as GenContext
    expect(gen.workingVars.probeVar).toBe('planted-at-build')
    expect(res.outputs.get('apply')?.variables).toBe(gen.workingVars)
  })
})
