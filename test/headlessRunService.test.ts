import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { ComposeFragment } from '../src/shared/workflow/compose'

// headlessRunService (agent-packs plan WP2.2): trigger evaluator + headless fragment runner. This is
// an INTEGRATION-style suite — the REAL engine (runSubgraph), the REAL builtin node registry, the
// REAL objectPath + trace + attachments grammar all run. Only the STATE services the runner reads /
// writes are mocked (the sqlite-backed ones, unloadable under Node), following agentPackService.test's
// module-mock idiom: enabledFragmentsFor (which packs are gated open), the committed-state readers
// (chat floor count, floor vars, table status), the per-trigger baseline store, and the sinks
// (workflowEvents trace broadcast, log). buildGenContext is stubbed to a minimal Context.

const mockAgentPack = vi.hoisted(() => ({
  enabledFragmentsFor: vi.fn<() => ComposeFragment[]>(() => [])
}))
vi.mock('../src/main/services/agentPackService', () => mockAgentPack)

const mockChat = vi.hoisted(() => ({
  getChat: vi.fn<() => { character_id: string; floor_count: number } | null>(() => ({
    character_id: 'w1',
    floor_count: 1
  }))
}))
vi.mock('../src/main/services/chatService', () => mockChat)

// floorService: getFloor returns the latest committed floor; saveFloor is the write spy a vars.save
// fragment lands on. getAllFloors is read by the vars.save node.
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

// In-memory trigger-state store (the sqlite table under Node returns empty rows; we fake it so the
// changedBy/cadence baselines actually persist across evaluations within a test).
const triggerState = vi.hoisted(
  () => new Map<string, { lastValue: number | null; lastFireFloor: number | null }>()
)
const mockTriggerStore = vi.hoisted(() => ({
  getTriggerState: vi.fn((chatId: string, packId: string, i: number) =>
    triggerState.get(`${chatId}|${packId}|${i}`) ?? null
  ),
  setTriggerLastValue: vi.fn((chatId: string, packId: string, i: number, v: number) => {
    const k = `${chatId}|${packId}|${i}`
    triggerState.set(k, { lastValue: v, lastFireFloor: triggerState.get(k)?.lastFireFloor ?? null })
  }),
  setTriggerLastFireFloor: vi.fn((chatId: string, packId: string, i: number, f: number) => {
    const k = `${chatId}|${packId}|${i}`
    triggerState.set(k, { lastValue: triggerState.get(k)?.lastValue ?? null, lastFireFloor: f })
  })
}))
vi.mock('../src/main/services/agentPackTriggerStore', () => mockTriggerStore)

const mockEvents = vi.hoisted(() => ({ notifyWorkflowTrace: vi.fn(), notifyWorkflowPanel: vi.fn() }))
vi.mock('../src/main/services/workflowEvents', () => mockEvents)

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)

// A minimal GenContext for the context-ready seed. The vars.save node only reads profileId/chatId/
// userAction off it; everything else is unused in these fragments.
const mockGenContext = vi.hoisted(() => ({
  buildGenContext: vi.fn((profileId: string, chatId: string, userAction: string) => ({
    profileId,
    chatId,
    userAction
  }))
}))
vi.mock('../src/main/services/generation/genContext', () => mockGenContext)

import { evaluateTriggers, runManual, HEADLESS_DEPTH_CAP } from '../src/main/services/headlessRunService'

// ── Fragment builders ──────────────────────────────────────────────────────────────────────────

/** A fragment that, when run headlessly, writes a floor variable — the observable "write lands"
 *  effect. context.action(gen) → text → vars.save(value). A context-ready entry seeds `gen` on both
 *  nodes. vars.save writes onto the latest floor and calls saveFloor (the mocked spy). */
const varsWriteFragment = (triggers: WorkflowDoc['attachments']): WorkflowDoc => ({
  id: 'frag',
  name: 'writer',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [
    { id: 'act', type: 'context.action' },
    { id: 'save', type: 'vars.save', config: { scope: 'floor', path: 'headlessRan' } }
  ],
  edges: [{ from: { node: 'act', port: 'text' }, to: { node: 'save', port: 'value' } }],
  attachments: [
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'act', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'save', port: 'gen' } },
    ...(triggers ?? [])
  ]
})

const frag = (packId: string, doc: WorkflowDoc, closed?: number[]): ComposeFragment => ({
  packId,
  doc,
  gateOpen: true,
  ...(closed ? { closedEntryIndexes: closed } : {})
})

beforeEach(() => {
  triggerState.clear()
  Object.values(mockAgentPack).forEach((f) => f.mockReset())
  Object.values(mockChat).forEach((f) => f.mockReset())
  Object.values(mockFloor).forEach((f) => f.mockReset())
  Object.values(mockTableStatus).forEach((f) => f.mockReset())
  Object.values(mockEvents).forEach((f) => f.mockReset())
  mockLog.log.mockReset()
  mockGenContext.buildGenContext.mockReset()

  mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 1 })
  mockFloor.getFloor.mockReturnValue({ floor: 0, variables: {} })
  mockFloor.getAllFloors.mockReturnValue([{ floor: 0, variables: {} }])
  mockTableStatus.getTablesStatus.mockReturnValue({})
  mockGenContext.buildGenContext.mockImplementation((p, c, u) => ({ profileId: p, chatId: c, userAction: u }))
  mockAgentPack.enabledFragmentsFor.mockReturnValue([])
})

// ── 1. State trigger fires → the fragment's write lands ──────────────────────────────────────────
describe('state trigger', () => {
  it('a satisfied vars-path gt trigger runs the fragment and its floor write lands', async () => {
    // Committed floor vars satisfy stat_data.hp gt 10.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'state', source: { scope: 'vars', path: 'stat_data.hp' }, op: 'gt', value: 10 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    await evaluateTriggers('prof', 'c1', 'turn', 0)

    // The fragment's vars.save landed a write (the observable side effect via the service it calls).
    expect(mockFloor.saveFloor).toHaveBeenCalled()
    // And its trace was broadcast (debug panel visibility — WP2.3 persists it later).
    expect(mockEvents.notifyWorkflowTrace).toHaveBeenCalled()
  })

  it('an unsatisfied trigger does not run the fragment', async () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 5 } } })
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'state', source: { scope: 'vars', path: 'stat_data.hp' }, op: 'gt', value: 10 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('a table-stat trigger reads tableProgress via tableStatusService', async () => {
    mockTableStatus.getTablesStatus.mockReturnValue({ log: { unprocessed: 12, processed: 3, nextExpected: 5 } })
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'state', source: { scope: 'table', table: 'log', stat: 'unprocessed' }, op: 'gte', value: 10 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).toHaveBeenCalled()
  })
})

// ── 2. changedBy: first evaluation baselines (no fire); advance past the delta → fires ─────────────
describe('changedBy delta', () => {
  it('baselines on first evaluation (no fire), fires once the source advances past the delta', async () => {
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'state', source: { scope: 'vars', path: 'stat_data.day' }, op: 'changedBy', value: 30 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    // First evaluation: source = 10 → baseline, no fire.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 10 } } })
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockTriggerStore.setTriggerLastValue).toHaveBeenCalledWith('c1', 'p1', 2, 10)

    // Advance to 45 (+35 >= 30) → fires.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 45 } } })
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).toHaveBeenCalled()
  })

  it('does not fire when the advance is below the delta', async () => {
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'state', source: { scope: 'vars', path: 'stat_data.day' }, op: 'changedBy', value: 30 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 10 } } })
    await evaluateTriggers('prof', 'c1', 'turn', 0) // baseline 10
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 20 } } }) // +10 < 30
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })
})

// ── 3. Cadence: fires at the floor rule (currentIdx - lastFire >= N), not early; last-fire persists ─
describe('cadence', () => {
  const cadenceDoc = () =>
    varsWriteFragment([{ kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }])

  it('does not fire before N floors elapse (floor index 1 < 2)', async () => {
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 2 }) // latest index 1
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', cadenceDoc())])
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('fires at floor index 2 (floors 0,1,2 = 3 elapsed) and persists last-fire', async () => {
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 3 }) // latest index 2
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', cadenceDoc())])
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).toHaveBeenCalled()
    expect(mockTriggerStore.setTriggerLastFireFloor).toHaveBeenCalledWith('c1', 'p1', 2, 2)
  })

  it('does not re-fire until another N floors elapse after the last fire', async () => {
    triggerState.set('c1|p1|2', { lastValue: null, lastFireFloor: 2 }) // last fired at index 2
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 5 }) // latest index 4 (4-2=2 < 3)
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', cadenceDoc())])
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })
})

// ── 4. OR-dedupe: a pack with two satisfied triggers runs once ─────────────────────────────────────
describe('OR-dedupe', () => {
  it('a pack with two satisfied triggers runs its fragment exactly once at a boundary', async () => {
    // Two CADENCE triggers, both satisfied at floor index 4 (N=1 → 4-(-1)>=1; N=3 → 4-(-1)>=3). Using
    // cadence (not always-true state) isolates OR-dedupe from chain re-fire: both persist lastFire=4
    // on this boundary, so the headless commit's re-eval (same floor index 4) does NOT re-fire either
    // (4-4=0 < N). One boundary, two firing triggers → exactly ONE run.
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 5 }) // latest index 4
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'cadence', everyNFloors: 1 },
      { kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    await evaluateTriggers('prof', 'c1', 'turn', 0)
    // vars.save runs once per fragment run — two firing triggers must still yield ONE run.
    expect(mockFloor.saveFloor).toHaveBeenCalledTimes(1)
  })
})

// ── 5. Depth cap: a self-re-satisfying chain stops at the cap (no infinite loop) ───────────────────
describe('depth cap', () => {
  it('a fragment whose commit re-satisfies its own trigger stops the chain at the cap', async () => {
    // The trigger is ALWAYS satisfied (hp gt 0, hp=1), so every headless commit re-fires it. The
    // depth cap must bound the chain: turn(0) → run → eval(1) → run → eval(2) → run → eval(3) SKIP.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 1 } } })
    const doc = varsWriteFragment([
      { kind: 'trigger', trigger: 'state', source: { scope: 'vars', path: 'stat_data.hp' }, op: 'gt', value: 0 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    await evaluateTriggers('prof', 'c1', 'turn', 0)
    // Runs happen at depths 0,1,2 → exactly HEADLESS_DEPTH_CAP fragment runs, then eval at depth 3
    // skips. Not unbounded.
    expect(mockFloor.saveFloor).toHaveBeenCalledTimes(HEADLESS_DEPTH_CAP)
  })
})

// ── 6. Gate closed → no evaluation; manual not fired by boundaries ─────────────────────────────────
describe('gating + manual', () => {
  it('a gate-closed pack is never evaluated (enabledFragmentsFor omits it → no run)', async () => {
    // enabledFragmentsFor already filters gate-closed packs; simulate that by returning nothing.
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { hp: 42 } } })
    mockAgentPack.enabledFragmentsFor.mockReturnValue([])
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('a manual trigger does NOT fire from a boundary', async () => {
    const doc = varsWriteFragment([{ kind: 'trigger', trigger: 'manual' }])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
  })

  it('runManual runs a gate-open pack explicitly (the WP3.x hook)', async () => {
    const doc = varsWriteFragment([{ kind: 'trigger', trigger: 'manual' }])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])
    await runManual('prof', 'c1', 'p1')
    expect(mockFloor.saveFloor).toHaveBeenCalled()
  })

  it('runManual on a non-gate-open pack is a logged no-op', async () => {
    mockAgentPack.enabledFragmentsFor.mockReturnValue([])
    await runManual('prof', 'c1', 'missing')
    expect(mockFloor.saveFloor).not.toHaveBeenCalled()
    expect(mockLog.log).toHaveBeenCalled()
  })
})

// ── 7. In-flight guard: a re-entrant pass for the same chat is skipped ─────────────────────────────
describe('in-flight reentrancy guard', () => {
  it('a re-entrant evaluate for a chat already evaluating is skipped', async () => {
    // While a pass for c1 is in flight (the flag set), a second same-chat pass must SKIP — it must
    // not reach enabledFragmentsFor again (a turn landing mid-headless-chain must not double-schedule).
    // enabledFragmentsFor stays synchronous (its real contract); on its first call it re-enters
    // evaluateTriggers for the SAME chat, which the guard short-circuits (returns immediately).
    let reentered = false
    mockAgentPack.enabledFragmentsFor.mockImplementation(() => {
      if (!reentered) {
        reentered = true
        void evaluateTriggers('prof', 'c1', 'turn', 0) // re-entrant same-chat pass — should skip
      }
      return []
    })
    await evaluateTriggers('prof', 'c1', 'turn', 0)
    // The re-entrant pass short-circuited on the in-flight guard before reaching enabledFragmentsFor,
    // so it is called exactly once (the outer pass) — no double-schedule.
    expect(mockAgentPack.enabledFragmentsFor).toHaveBeenCalledTimes(1)

    // A DIFFERENT chat is not blocked by c1's flag.
    mockAgentPack.enabledFragmentsFor.mockClear()
    mockAgentPack.enabledFragmentsFor.mockReturnValue([])
    await evaluateTriggers('prof', 'c2', 'turn', 0)
    expect(mockAgentPack.enabledFragmentsFor).toHaveBeenCalledTimes(1)
  })
})
