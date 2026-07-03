import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { ComposeFragment } from '../src/shared/workflow/compose'

// explainTriggers (agent-packs plan WP3.5): the READ-ONLY "why isn't this pack running?" evaluation the
// Agents "Why?" popover consumes. It must compute the same fire decision the headless evaluator would —
// but as a PURE read: NEVER advancing a changedBy baseline or a cadence lastFireFloor. This suite pins
// (1) the met/current/required/baseline/lastFireFloor/floorsUntilDue shape for each trigger kind,
// (2) that the MATERIALIZED trigger param (an N override) is respected, and (3) — the load-bearing
// invariant — that calling explainTriggers TWICE never touches the trigger store (no setter is called).
//
// It mocks the SAME sqlite-backed services headlessRunService.test.ts does (they can't load under Node).

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

const mockFloor = vi.hoisted(() => ({
  getFloor: vi.fn<() => { floor: number; variables: Record<string, unknown> } | null>(() => ({
    floor: 0,
    variables: {}
  })),
  getAllFloors: vi.fn(() => [{ floor: 0, variables: {} }]),
  saveFloor: vi.fn()
}))
vi.mock('../src/main/services/floorService', () => mockFloor)

const mockTableStatus = vi.hoisted(() => ({
  getTablesStatus: vi.fn<
    () => Record<string, { unprocessed: number; processed: number; nextExpected: number }>
  >(() => ({}))
}))
vi.mock('../src/main/services/tableStatusService', () => mockTableStatus)

// The trigger-state store: getTriggerState is READ-ONLY here; the two SETTERS are spies we assert are
// NEVER called by explainTriggers (the read-only invariant).
const triggerState = vi.hoisted(
  () => new Map<string, { lastValue: number | null; lastFireFloor: number | null }>()
)
const mockTriggerStore = vi.hoisted(() => ({
  getTriggerState: vi.fn(
    (chatId: string, packId: string, i: number) =>
      triggerState.get(`${chatId}|${packId}|${i}`) ?? null
  ),
  setTriggerLastValue: vi.fn(),
  setTriggerLastFireFloor: vi.fn()
}))
vi.mock('../src/main/services/agentPackTriggerStore', () => mockTriggerStore)

const mockEvents = vi.hoisted(() => ({
  notifyWorkflowTrace: vi.fn(),
  notifyWorkflowPanel: vi.fn()
}))
vi.mock('../src/main/services/workflowEvents', () => mockEvents)
const mockRunHistory = vi.hoisted(() => ({ appendRun: vi.fn(() => undefined) }))
vi.mock('../src/main/services/runHistoryStore', () => mockRunHistory)
const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../src/main/services/logService', () => mockLog)
const mockGenContext = vi.hoisted(() => ({
  buildGenContext: vi.fn((p: string, c: string, u: string) => ({
    profileId: p,
    chatId: c,
    userAction: u
  }))
}))
vi.mock('../src/main/services/generation/genContext', () => mockGenContext)

import { explainTriggers } from '../src/main/services/headlessRunService'
import { materializeFragment, sysTriggerKey } from '../src/main/services/agentPackMaterialize'

/** A fragment carrying just the given trigger attachment(s) — no real work needed to explain triggers. */
const triggerFragment = (triggers: WorkflowDoc['attachments']): WorkflowDoc => ({
  id: 'frag',
  name: 'writer',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [{ id: 'act', type: 'context.action' }],
  edges: [],
  attachments: [
    {
      kind: 'entry',
      checkpoint: 'context-ready',
      mode: 'branch',
      entryPort: { node: 'act', port: 'gen' }
    },
    ...(triggers ?? [])
  ]
})

const frag = (packId: string, doc: WorkflowDoc): ComposeFragment => ({
  packId,
  doc,
  gateOpen: true
})

beforeEach(() => {
  triggerState.clear()
  Object.values(mockTriggerStore).forEach((f) => f.mockClear())
  mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 1 })
  mockFloor.getFloor.mockReturnValue({ floor: 0, variables: {} })
  mockTableStatus.getTablesStatus.mockReturnValue({})
  mockAgentPack.enabledFragmentsFor.mockReturnValue([])
})

describe('explainTriggers — state condition (point op)', () => {
  it('reports met with current + required when the condition holds', () => {
    mockTableStatus.getTablesStatus.mockReturnValue({
      log: { unprocessed: 12, processed: 0, nextExpected: 0 }
    })
    const doc = triggerFragment([
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'table', table: 'log', stat: 'unprocessed' },
        op: 'gte',
        value: 10
      }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.kind).toBe('state')
    expect(e.met).toBe(true)
    expect(e.current).toBe(12)
    expect(e.required).toBe(10)
  })

  it('reports NOT met with current 8 / required 10 for an unmet backlog', () => {
    mockTableStatus.getTablesStatus.mockReturnValue({
      log: { unprocessed: 8, processed: 0, nextExpected: 0 }
    })
    const doc = triggerFragment([
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'table', table: 'log', stat: 'unprocessed' },
        op: 'gte',
        value: 10
      }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.met).toBe(false)
    expect(e.current).toBe(8)
    expect(e.required).toBe(10)
  })
})

describe('explainTriggers — changedBy', () => {
  it('shows the baseline and the current delta', () => {
    triggerState.set('c1|p1|1', { lastValue: 120, lastFireFloor: null })
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 135 } } })
    const doc = triggerFragment([
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'vars', path: 'stat_data.day' },
        op: 'changedBy',
        value: 30
      }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.baseline).toBe(120)
    expect(e.current).toBe(135)
    expect(e.required).toBe(30)
    expect(e.met).toBe(false) // 135-120 = 15 < 30
  })

  it('is not met (and carries no baseline) on the first-ever evaluation', () => {
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 10 } } })
    const doc = triggerFragment([
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'vars', path: 'stat_data.day' },
        op: 'changedBy',
        value: 30
      }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.met).toBe(false)
    expect(e.baseline).toBeUndefined()
    expect(e.current).toBe(10)
  })
})

describe('explainTriggers — cadence', () => {
  it('shows lastFireFloor and floorsUntilDue for a pending cadence', () => {
    triggerState.set('c1|p1|1', { lastValue: null, lastFireFloor: 2 }) // last fired at index 2
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 4 }) // latest index 3
    const doc = triggerFragment([{ kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.kind).toBe('cadence')
    expect(e.met).toBe(false) // 3 - 2 = 1 < 3
    expect(e.lastFireFloor).toBe(2)
    expect(e.required).toBe(3)
    expect(e.floorsUntilDue).toBe(2) // 3 - (3 - 2) = 2
  })

  it('is met (floorsUntilDue ≤ 0) when enough floors have elapsed', () => {
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 3 }) // latest index 2, never fired
    const doc = triggerFragment([{ kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.met).toBe(true)
    expect(e.floorsUntilDue).toBeLessThanOrEqual(0)
  })
})

describe('explainTriggers — materialized override respected (WP3.2 path)', () => {
  it('an N override (sys.trigger.*.value = 10) shows required 10, not the default 6', () => {
    mockTableStatus.getTablesStatus.mockReturnValue({
      log: { unprocessed: 8, processed: 0, nextExpected: 0 }
    })
    // Default threshold 6; the trigger is attachment index 1 (index 0 is the context-ready entry).
    const base = triggerFragment([
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'table', table: 'log', stat: 'unprocessed' },
        op: 'gte',
        value: 6
      }
    ])
    const doc = materializeFragment(
      { id: 'p1', manifest: {}, fragment: base },
      { [sysTriggerKey(1, 'value')]: 10 }
    )
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    const [e] = explainTriggers('prof', 'c1', 'p1')
    expect(e.required).toBe(10) // the override, not 6
    expect(e.current).toBe(8)
    expect(e.met).toBe(false) // 8 >= 10 is false
  })
})

describe('explainTriggers — read-only invariant', () => {
  it('returns [] for a pack that is not gate-open', () => {
    mockAgentPack.enabledFragmentsFor.mockReturnValue([])
    expect(explainTriggers('prof', 'c1', 'p1')).toEqual([])
  })

  it('calling it twice NEVER advances any trigger baseline (store untouched)', () => {
    // A changedBy trigger + a cadence trigger — both stateful kinds. The evaluator would advance their
    // baselines; explain must not touch either setter, no matter how many times it runs.
    mockChat.getChat.mockReturnValue({ character_id: 'w1', floor_count: 5 }) // index 4, cadence would fire
    mockFloor.getFloor.mockReturnValue({ floor: 0, variables: { stat_data: { day: 100 } } })
    const doc = triggerFragment([
      {
        kind: 'trigger',
        trigger: 'state',
        source: { scope: 'vars', path: 'stat_data.day' },
        op: 'changedBy',
        value: 1
      },
      { kind: 'trigger', trigger: 'cadence', everyNFloors: 1 }
    ])
    mockAgentPack.enabledFragmentsFor.mockReturnValue([frag('p1', doc)])

    explainTriggers('prof', 'c1', 'p1')
    explainTriggers('prof', 'c1', 'p1')

    expect(mockTriggerStore.setTriggerLastValue).not.toHaveBeenCalled()
    expect(mockTriggerStore.setTriggerLastFireFloor).not.toHaveBeenCalled()
  })
})
