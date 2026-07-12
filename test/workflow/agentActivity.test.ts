import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the broadcast module so the engine's activity emit is observable WITHOUT electron. The engine
// only imports notifyWorkflowActivity; the other two exports are mocked defensively.
vi.mock('../../src/main/services/workflowEvents', () => ({
  notifyWorkflowActivity: vi.fn(),
  notifyWorkflowTrace: vi.fn(),
  notifyWorkflowPanel: vi.fn()
}))

import { runWorkflow } from '../../src/main/services/workflowEngine'
import { notifyWorkflowActivity } from '../../src/main/services/workflowEvents'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'
import {
  useAgentActivityStore,
  currentActivity,
  currentActivityLabelKey,
  activityLabelKey
} from '../../src/renderer/src/stores/agentActivityStore'

// ── agentActivityStore (renderer) ────────────────────────────────────────────
describe('agentActivityStore', () => {
  beforeEach(() => useAgentActivityStore.setState({ active: {} }))

  it('start sets the phase-aware label; end clears it', () => {
    const s = useAgentActivityStore.getState()
    s.start('c1', 'n1', 'memory.recall', 'pre')
    expect(currentActivityLabelKey(useAgentActivityStore.getState().active, 'c1', 'pre')).toBe(
      'chat.activity.recall'
    )
    // wrong phase → nothing
    expect(currentActivity(useAgentActivityStore.getState().active, 'c1', 'post')).toBeNull()

    useAgentActivityStore.getState().end('c1', 'n1')
    expect(currentActivity(useAgentActivityStore.getState().active, 'c1', 'pre')).toBeNull()
    // the chat key is pruned once empty
    expect(useAgentActivityStore.getState().active.c1).toBeUndefined()
  })

  it('a stray end (no matching start) is a no-op', () => {
    const before = useAgentActivityStore.getState().active
    useAgentActivityStore.getState().end('c1', 'ghost')
    expect(useAgentActivityStore.getState().active).toBe(before)
  })

  it('overlapping starts coexist; ending one leaves the other; priority picks the label', () => {
    const s = useAgentActivityStore.getState()
    s.start('c1', 'a', 'notes.maintain', 'post')
    s.start('c1', 'b', 'memory.maintain', 'post')
    // memory.maintain outranks notes.maintain in the priority order
    expect(currentActivity(useAgentActivityStore.getState().active, 'c1', 'post')).toBe(
      'memory.maintain'
    )
    useAgentActivityStore.getState().end('c1', 'b')
    expect(currentActivity(useAgentActivityStore.getState().active, 'c1', 'post')).toBe(
      'notes.maintain'
    )
  })

  it('activityLabelKey maps known types and falls back to the generic agent label', () => {
    expect(activityLabelKey('memory.recall')).toBe('chat.activity.recall')
    expect(activityLabelKey('memory.maintain')).toBe('chat.activity.memoryMaintain')
    expect(activityLabelKey('notes.maintain')).toBe('chat.activity.notesMaintain')
    expect(activityLabelKey('agent.llm')).toBe('chat.activity.agent')
    expect(activityLabelKey('something.new')).toBe('chat.activity.agent')
  })
})

// ── engine emit (main) ───────────────────────────────────────────────────────
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {},
  chatId: 'c1',
  ...over
})

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

// A fake memory.recall (a calls-llm ANCESTOR of the narrator → pre-phase) + the narrator (llm.sample,
// the main output). Types alone drive the announce-set predicate, so trivial run()s are enough.
const impls: NodeImpl[] = [
  {
    type: 'memory.recall',
    title: 'recall',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'mem' } })
  },
  {
    type: 'llm.sample',
    title: 'narrator',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    isMainOutputCapable: true,
    run: () => ({})
  }
]
const reg = createRegistry(impls)

describe('workflowEngine — activity emit', () => {
  beforeEach(() => (notifyWorkflowActivity as unknown as ReturnType<typeof vi.fn>).mockClear())

  it('emits a start+end activity for a pre-phase memory.recall, but not for llm.sample', async () => {
    const d = doc(
      [
        { id: 'r', type: 'memory.recall' },
        { id: 'k', type: 'llm.sample', isMainOutput: true }
      ],
      [{ from: { node: 'r', port: 'out' }, to: { node: 'k', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)

    const payloads = (notifyWorkflowActivity as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]
    )
    const recall = payloads.filter((p) => p.nodeId === 'r')
    expect(recall.map((p) => p.state)).toEqual(['start', 'end'])
    expect(recall[0]).toMatchObject({
      chatId: 'c1',
      nodeType: 'memory.recall',
      phase: 'pre',
      state: 'start'
    })
    // The narrator streams via generation-delta — it is NEVER announced.
    expect(payloads.some((p) => p.nodeType === 'llm.sample')).toBe(false)
  })

  it('does not emit when the run has no chatId (bare-context engine runs)', async () => {
    const d = doc(
      [
        { id: 'r', type: 'memory.recall' },
        { id: 'k', type: 'llm.sample', isMainOutput: true }
      ],
      [{ from: { node: 'r', port: 'out' }, to: { node: 'k', port: 'in' } }]
    )
    await runWorkflow(d, reg, ctx({ chatId: undefined }))
    expect((notifyWorkflowActivity as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
