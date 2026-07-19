import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowDoc } from '../src/shared/workflow/types'

// DOC-DRIVEN headless path (one-canvas rebuild WP6.1; ADR 0011). The sibling suite of
// headlessRunService.test.ts (the pack path) — same INTEGRATION style: the REAL engine (runSubgraph),
// REAL builtin registry (incl. the new trigger.* nodes), REAL objectPath/trace run; only the sqlite-
// backed state services + resolveWorkflowDoc are mocked. The pack-path suite stays untouched; this
// exercises evaluateDocTriggers / runManualDoc against a mocked active doc.

const mockChat = vi.hoisted(() => ({
  getChat: vi.fn<() => { character_id: string; floor_count: number } | null>(() => ({
    character_id: 'w1',
    floor_count: 1
  }))
}))
vi.mock('../src/main/services/chatService', () => mockChat)

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn<() => { floor: number; variables: Record<string, unknown> } | null>(() => ({
    floor: 0,
    variables: {}
  })),
  getAllFloors: vi.fn<() => Array<{ floor: number; variables: Record<string, unknown> }>>(() => [
    { floor: 0, variables: {} }
  ]),
  saveFloor: vi.fn()
}))
vi.mock('../src/main/services/floorService', () => mockFloor)

const mockTableStatus = vi.hoisted(() => ({
  getTablesStatus: vi.fn<() => Record<string, { unprocessed: number; processed: number; nextExpected: number }>>(
    () => ({})
  )
}))
vi.mock('../src/main/services/tableStatusService', () => mockTableStatus)

// In-memory DOC trigger-state store (keyed chat|doc|node). Faked so cadence/changedBy baselines persist
// across evaluations within a test (the sqlite table returns empty rows under Node).
const docTriggerState = vi.hoisted(
  () => new Map<string, { lastValue: number | null; lastFireFloor: number | null }>()
)
const mockDocTriggerStore = vi.hoisted(() => ({
  getDocTriggerState: vi.fn((chatId: string, docId: string, nodeId: string) =>
    docTriggerState.get(`${chatId}|${docId}|${nodeId}`) ?? null
  ),
  setDocTriggerLastValue: vi.fn((chatId: string, docId: string, nodeId: string, v: number) => {
    const k = `${chatId}|${docId}|${nodeId}`
    docTriggerState.set(k, { lastValue: v, lastFireFloor: docTriggerState.get(k)?.lastFireFloor ?? null })
  }),
  setDocTriggerLastFireFloor: vi.fn((chatId: string, docId: string, nodeId: string, f: number) => {
    const k = `${chatId}|${docId}|${nodeId}`
    docTriggerState.set(k, { lastValue: docTriggerState.get(k)?.lastValue ?? null, lastFireFloor: f })
  })
}))
vi.mock('../src/main/services/workflowTriggerStore', () => mockDocTriggerStore)

// The pack store is imported by headlessRunService too (the coexisting pack path). Mock it to a no-op
// so importing the module doesn't touch sqlite; the pack path is not exercised here.
const mockPackTriggerStore = vi.hoisted(() => ({
  getTriggerState: vi.fn(() => null),
  setTriggerLastValue: vi.fn(),
  setTriggerLastFireFloor: vi.fn()
}))
vi.mock('../src/main/services/agentPackTriggerStore', () => mockPackTriggerStore)

const mockAgentPack = vi.hoisted(() => ({ enabledFragmentsFor: vi.fn(() => []) }))
vi.mock('../src/main/services/agentPackService', () => mockAgentPack)

const mockEvents = vi.hoisted(() => ({ notifyWorkflowTrace: vi.fn(), notifyWorkflowPanel: vi.fn() }))
vi.mock('../src/main/services/workflowEvents', () => mockEvents)

const mockRunHistory = vi.hoisted(() => ({ appendRun: vi.fn(() => undefined) }))
vi.mock('../src/main/services/runHistoryStore', () => mockRunHistory)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

const mockGenContext = vi.hoisted(() => ({
  buildGenContext: vi.fn((profileId: string, chatId: string, userAction: string) => ({
    profileId,
    chatId,
    userAction
  }))
}))
vi.mock('../src/main/services/generation/genContext', () => mockGenContext)

// resolveWorkflowDoc supplies the chat's ACTIVE doc. We set it per test.
const mockWorkflowService = vi.hoisted(() => ({
  resolveWorkflowDoc: vi.fn<() => { id: string; doc: WorkflowDoc }>()
}))
vi.mock('../src/main/services/workflowService', () => mockWorkflowService)

import {
  evaluateDocTriggers,
  runManualDoc,
  explainDocTriggers
} from '../src/main/services/headlessRunService'

// ── Doc builders ─────────────────────────────────────────────────────────────────────────────────
//
// A turn doc with a narrator (input.context → main output) AND a trigger-rooted agent chain that
// writes a floor variable. The agent: trigger → vars.save(when gate) with its own input.context feeding
// gen + a text.template feeding value. vars.save calls saveFloor (the observable "write lands").

/** A minimal narrator: one input.context marked main output (produces the reply). */
const narratorNodes = () => [
  { id: 'narrator', type: 'input.context', isMainOutput: true as const }
]

const docWith = (
  nodes: WorkflowDoc['nodes'],
  edges: WorkflowDoc['edges'],
  id = 'doc1'
): WorkflowDoc => ({
  id,
  name: 'active',
  version: 1,
  schemaVersion: 1,
  kind: 'turn',
  nodes,
  edges
})

/** Build a doc with a narrator + one agent: trigger(trigId) → vars.save gated by the trigger, fed by
 *  a context (input.context, self-seeds) and a text.template (the value). */
const docWithAgent = (
  trigId: string,
  trigType: string,
  trigConfig: Record<string, unknown> | undefined,
  savePath = 'agentRan',
  id = 'doc1'
): WorkflowDoc =>
  docWith(
    [
      ...narratorNodes(),
      { id: trigId, type: trigType, ...(trigConfig ? { config: trigConfig } : {}) },
      { id: `${trigId}_ctx`, type: 'input.context' },
      { id: `${trigId}_tpl`, type: 'text.template', config: { template: 'x' } },
      { id: `${trigId}_save`, type: 'vars.save', config: { scope: 'floor', path: savePath } }
    ],
    [
      { from: { node: trigId, port: 'fired' }, to: { node: `${trigId}_save`, port: 'when' } },
      { from: { node: `${trigId}_ctx`, port: 'gen' }, to: { node: `${trigId}_save`, port: 'gen' } },
      { from: { node: `${trigId}_tpl`, port: 'text' }, to: { node: `${trigId}_save`, port: 'value' } }
    ],
    id
  )

const stateCfg = (path: string, op: string, value: unknown) => ({
  source: { scope: 'vars', path },
  op,
  value
})

beforeEach(() => {
  docTriggerState.clear()
  Object.values(mockChat).forEach((f) => f.mockReset())
  Object.values(mockFloor).forEach((f) => f.mockReset())
  Object.values(mockTableStatus).forEach((f) => f.mockReset())
  Object.values(mockEvents).forEach((f) => f.mockReset())
  mockRunHistory.appendRun.mockReset()
  mockRunHistory.appendRun.mockReturnValue(undefined)
  mockLog.log.mockReset()
  mockGenContext.buildGenContext.mockReset()
  mockWorkflowService.resolveWorkflowDoc.mockReset()
  mockDocTriggerStore.getDocTriggerState.mockClear()
  mockDocTriggerStore.setDocTriggerLastValue.mockClear()
  mockDocTriggerStore.setDocTriggerLastFireFloor.mockClear()

  mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 1 })
  mockFloor.getFloor.mockReturnValue({ floor: 0, variables: {} })
  mockFloor.getAllFloors.mockReturnValue([{ floor: 0, variables: {} }])
  mockTableStatus.getTablesStatus.mockReturnValue({})
  mockGenContext.buildGenContext.mockImplementation((p, c, u) => ({ profileId: p, chatId: c, userAction: u }))
})

// ── State trigger ──────────────────────────────────────────────────────────────────────────────────
describe('doc-driven state trigger', () => {
  it('a satisfied vars-path trigger runs the agent chain and its floor write lands', async () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    expect(mockFloor.saveFloor).toHaveBeenCalled()
    expect(mockEvents.notifyWorkflowTrace).toHaveBeenCalled()
  })

  it('an unsatisfied trigger does not run the chain', async () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 5 } } })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('a table-stat trigger reads tableProgress via tableStatusService', async () => {
    mockTableStatus.getTablesStatus.mockReturnValue({ log: { unprocessed: 12, processed: 3, nextExpected: 5 } })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', {
        source: { scope: 'table', table: 'log', stat: 'unprocessed' },
        op: 'gte',
        value: 10
      })
    })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).toHaveBeenCalled()
  })
})

// ── changedBy + cadence semantics (mirrors the pack suite's approach) ────────────────────────────────
describe('doc-driven changedBy + cadence', () => {
  it('changedBy baselines on first evaluation (no fire), then fires on a big enough delta', async () => {
    const doc = docWithAgent('trg', 'trigger.state', stateCfg('stat_data.t', 'changedBy', 10))
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })

    // First eval: source = 5, no baseline → baseline set, no fire.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { t: 5 } } })
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(docTriggerState.get('c1|doc1|trg')?.lastValue).toBe(5)

    // Second eval: source jumped to 20 (delta 15 >= 10) → fires, baseline re-advances to 20.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { t: 20 } } })
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).toHaveBeenCalled()
    expect(docTriggerState.get('c1|doc1|trg')?.lastValue).toBe(20)
  })

  it('cadence fires every N floors, tracking lastFireFloor per (chat, doc, node)', async () => {
    const doc = docWithAgent('trg', 'trigger.cadence', { everyNFloors: 3 })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })

    // Floor index 1 (< 3 since lastFire −1) → no fire.
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 2 })
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()

    // Floor index 2 (2 − (−1) = 3 >= 3) → fires; lastFireFloor = 2.
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 3 })
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).toHaveBeenCalled()
    expect(docTriggerState.get('c1|doc1|trg')?.lastFireFloor).toBe(2)
  })
})

// ── OR-dedupe per chain ──────────────────────────────────────────────────────────────────────────────
describe('OR-dedupe per chain', () => {
  it('two triggers wired into ONE chain run it exactly once', async () => {
    // Two CADENCE(N=1) triggers both fire at THIS boundary (each advances its own lastFireFloor, so
    // neither re-fires when the chain's own commit re-evaluates at depth+1 — isolating this assertion
    // from the depth-cap re-fire a stateless point-op would exhibit). Both feed the SAME chain, so the
    // OR-dedupe groups them into one chain → one run. Wired as: t1 gates save.when, t2 gates tpl.when.
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 1 }) // floor index 0
    const doc = docWith(
      [
        ...narratorNodes(),
        { id: 't1', type: 'trigger.cadence', config: { everyNFloors: 1 } },
        { id: 't2', type: 'trigger.cadence', config: { everyNFloors: 1 } },
        { id: 'ctx', type: 'input.context' },
        { id: 'tpl', type: 'text.template', config: { template: 'x' } },
        { id: 'save', type: 'vars.save', config: { scope: 'floor', path: 'shared' } }
      ],
      [
        { from: { node: 't1', port: 'fired' }, to: { node: 'save', port: 'when' } },
        { from: { node: 't2', port: 'fired' }, to: { node: 'tpl', port: 'when' } },
        { from: { node: 'ctx', port: 'gen' }, to: { node: 'save', port: 'gen' } },
        { from: { node: 'tpl', port: 'text' }, to: { node: 'save', port: 'value' } }
      ]
    )
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    // ONE run for the shared chain → ONE appendRun with origin headless.
    const headlessRuns = mockRunHistory.appendRun.mock.calls.filter((c) => c[1].origin === 'headless')
    expect(headlessRuns).toHaveLength(1)
  })
})

// ── M4: memory.maintain is no longer fired by the doc-trigger path (double-fire guard) ────────────────
describe('memory.maintain is excluded from doc-trigger closures (M4, plan §6 risk 3)', () => {
  it('a cadence → memory.maintain chain runs the trigger but NEVER the maintain node', async () => {
    // floor index 0, cadence N=1 → the trigger fires. Before M4 this closure ran memory.maintain (the
    // doc's only model-backed node); after M4 it is dispatched as the built-in Agent instead, so the
    // doc-trigger closure strips it — a cadence window can never double-fire from both paths.
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 1 })
    const doc = docWith(
      [
        ...narratorNodes(),
        { id: 'trg', type: 'trigger.cadence', config: { everyNFloors: 1 } },
        { id: 'maintain', type: 'memory.maintain', config: { messages: [{ role: 'system', content: 'x' }] } }
      ],
      [{ from: { node: 'trg', port: 'fired' }, to: { node: 'maintain', port: 'when' } }]
    )
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    // The trigger fired (a trace was broadcast) but the maintain node is absent from every trace's
    // node set — it was stripped from the runnable closure, so it never executed.
    expect(mockEvents.notifyWorkflowTrace).toHaveBeenCalled()
    for (const call of mockEvents.notifyWorkflowTrace.mock.calls) {
      const ids = (call[0].nodes as Array<{ nodeId: string }>).map((n) => n.nodeId)
      expect(ids).not.toContain('maintain')
    }
    // And no memory write reached disk from this path.
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })
})

// ── Disabled trigger never fires ─────────────────────────────────────────────────────────────────────
describe('disabled trigger', () => {
  it('a disabled trigger is not evaluated and never fires', async () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    const doc = docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    doc.nodes = doc.nodes.map((n) => (n.id === 'trg' ? { ...n, disabled: true } : n))
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    // No baseline row was even touched (the trigger was skipped before evaluation).
    expect(mockDocTriggerStore.getDocTriggerState).not.toHaveBeenCalled()
  })
})

// ── Depth cap ───────────────────────────────────────────────────────────────────────────────────────
describe('depth cap', () => {
  it('skips evaluation entirely at the depth cap', async () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    })

    await evaluateDocTriggers('prof', 'c1', 'headless', 3) // HEADLESS_DEPTH_CAP = 3
    // resolveWorkflowDoc is never consulted — evaluation short-circuits before touching the doc.
    expect(mockWorkflowService.resolveWorkflowDoc).not.toHaveBeenCalled()
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })
})

// ── Narrator untouched by a headless run ──────────────────────────────────────────────────────────────
describe('narrator isolation', () => {
  it('a headless run does not run the narrator main-output node', async () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    })

    await evaluateDocTriggers('prof', 'c1', 'turn', 0)

    // The broadcast trace's node set is the agent closure only — the narrator node is absent.
    const trace = mockEvents.notifyWorkflowTrace.mock.calls.at(-1)![0]
    const nodeIds = trace.nodes.map((n: { nodeId: string }) => n.nodeId)
    expect(nodeIds).not.toContain('narrator')
    expect(nodeIds).toContain('trg')
  })
})

// ── Manual fires only via runManualDoc ────────────────────────────────────────────────────────────────
describe('manual trigger', () => {
  it('a manual trigger does NOT fire at a commit boundary', async () => {
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.manual', undefined)
    })
    await evaluateDocTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('runManualDoc fires the manual trigger chain explicitly', async () => {
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.manual', undefined)
    })
    await runManualDoc('prof', 'c1', 'doc1', 'trg')
    expect(mockFloor.saveFloor).toHaveBeenCalled()
    const run = mockRunHistory.appendRun.mock.calls.at(-1)![1]
    expect(run.origin).toBe('manual')
    expect(run.trigger).toBe('manual')
    expect(run.packIds).toEqual([])
  })

  it('runManualDoc on a non-manual node is a logged no-op', async () => {
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    })
    await runManualDoc('prof', 'c1', 'doc1', 'trg')
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockLog.log).toHaveBeenCalled()
  })

  it('runManualDoc no-ops (and appends NO run record) when docId is not the chat active doc', async () => {
    // resolveWorkflowDoc returns the chat's ACTIVE doc, id 'doc1'; the caller passes a STALE id.
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.manual', undefined)
    })
    await runManualDoc('prof', 'c1', 'staleDoc', 'trg')
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockRunHistory.appendRun).not.toHaveBeenCalled()
  })

  it('runManualDoc on a disabled manual trigger is a logged no-op', async () => {
    const doc = docWithAgent('trg', 'trigger.manual', undefined)
    doc.nodes = doc.nodes.map((n) => (n.id === 'trg' ? { ...n, disabled: true } : n))
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })
    await runManualDoc('prof', 'c1', 'doc1', 'trg')
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockRunHistory.appendRun).not.toHaveBeenCalled()
    expect(mockLog.log).toHaveBeenCalled()
  })
})

// ── Read-only live trigger badges (WP6.4a: explainDocTriggers) ─────────────────────────────────────────
describe('explainDocTriggers (read-only badges)', () => {
  it('reports met/unmet + current/required for state triggers and never fires', () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({
      id: 'doc1',
      doc: docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    })

    const exp = explainDocTriggers('prof', 'c1')
    expect(exp).toHaveLength(1)
    expect(exp[0]).toMatchObject({ nodeId: 'trg', met: true, current: 42, required: 10 })
    // Read-only: no floor write, no baseline advance.
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockDocTriggerStore.setDocTriggerLastValue).not.toHaveBeenCalled()
    expect(mockDocTriggerStore.setDocTriggerLastFireFloor).not.toHaveBeenCalled()

    // An unmet comparison reports met:false.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 5 } } })
    expect(explainDocTriggers('prof', 'c1')[0]).toMatchObject({ met: false, current: 5 })
  })

  it('skips disabled trigger nodes', () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    const doc = docWithAgent('trg', 'trigger.state', stateCfg('stat_data.hp', 'gt', 10))
    doc.nodes = doc.nodes.map((n) => (n.id === 'trg' ? { ...n, disabled: true } : n))
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })
    expect(explainDocTriggers('prof', 'c1')).toEqual([])
  })

  it('two calls leave workflow_trigger_state untouched (no writes)', () => {
    // A changedBy trigger + a cadence trigger — the two STATEFUL kinds. Evaluating them advances
    // baselines; EXPLAINING them must not. Two calls back-to-back must write nothing.
    const doc = docWith([
      ...narratorNodes(),
      { id: 'chg', type: 'trigger.state', config: stateCfg('stat_data.t', 'changedBy', 10) },
      { id: 'cad', type: 'trigger.cadence', config: { everyNFloors: 3 } }
    ], [])
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { t: 20 } } })
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 5 })
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })

    explainDocTriggers('prof', 'c1')
    explainDocTriggers('prof', 'c1')

    expect(mockDocTriggerStore.setDocTriggerLastValue).not.toHaveBeenCalled()
    expect(mockDocTriggerStore.setDocTriggerLastFireFloor).not.toHaveBeenCalled()
    // The store is otherwise untouched — no rows written (the in-memory map stays empty).
    expect(docTriggerState.size).toBe(0)
  })

  it('cadence reports required = everyNFloors', () => {
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 5 }) // floor index 4
    const doc = docWith([
      ...narratorNodes(),
      { id: 'cad', type: 'trigger.cadence', config: { everyNFloors: 3 } }
    ], [])
    mockWorkflowService.resolveWorkflowDoc.mockReturnValue({ id: 'doc1', doc })
    const exp = explainDocTriggers('prof', 'c1')
    expect(exp[0]).toMatchObject({ nodeId: 'cad', required: 3, met: true })
  })
})
