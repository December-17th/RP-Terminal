import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentFailureStore,
  isHeadlessTrace,
  deriveHeadlessFailure
} from '../src/renderer/src/stores/agentFailureStore'
import type { WorkflowRunTrace, TraceNode } from '../src/shared/workflow/trace'

const trace = (over: Partial<WorkflowRunTrace> = {}): WorkflowRunTrace => ({
  chatId: 'chat-1',
  workflowId: 'headless:mem',
  startedAt: 0,
  durationMs: 1,
  ok: true,
  aborted: false,
  nodes: [],
  ...over
})

const node = (over: Partial<TraceNode> = {}): TraceNode => ({
  nodeId: 'n1',
  nodeType: 'memory.maintain',
  status: 'ran',
  phase: 'post',
  ...over
})

describe('isHeadlessTrace', () => {
  it('is true for headless and headless-doc workflow ids', () => {
    expect(isHeadlessTrace(trace({ workflowId: 'headless:mem' }))).toBe(true)
    expect(isHeadlessTrace(trace({ workflowId: 'headless-doc:abc' }))).toBe(true)
  })
  it('is false for a player-turn workflow id', () => {
    expect(isHeadlessTrace(trace({ workflowId: 'turn:default' }))).toBe(false)
  })
})

describe('deriveHeadlessFailure', () => {
  it('returns null for a clean run (ok, no failed node)', () => {
    expect(deriveHeadlessFailure(trace({ ok: true, nodes: [node()] }))).toBeNull()
  })

  it('flags a failed node even when the RUN stayed ok (class-B error-port case)', () => {
    // The load-bearing case: memory.maintain fails onto its error port, run.ok stays true.
    const f = deriveHeadlessFailure(
      trace({
        ok: true,
        nodes: [node({ status: 'failed', error: { message: 'empty completion' } })]
      })
    )
    expect(f).not.toBeNull()
    expect(f?.reason).toBe('empty completion')
    expect(f?.nodeLabel).toBe('memory.maintain')
  })

  it('flags a fatal run (ok===false) using the run error', () => {
    const f = deriveHeadlessFailure(
      trace({ ok: false, nodes: [], error: { message: 'boom', nodeId: 'x' } })
    )
    expect(f?.reason).toBe('boom')
    expect(f?.nodeLabel).toBe('x')
  })
})

describe('useAgentFailureStore', () => {
  beforeEach(() => {
    useAgentFailureStore.setState({ failures: {} })
  })

  it('records, keeps latest per chat, and clears', () => {
    const s = useAgentFailureStore.getState()
    s.recordFailure('c1', { reason: 'first' })
    expect(useAgentFailureStore.getState().failures['c1'].reason).toBe('first')

    s.recordFailure('c1', { reason: 'second' })
    expect(useAgentFailureStore.getState().failures['c1'].reason).toBe('second')

    s.clear('c1')
    expect(useAgentFailureStore.getState().failures['c1']).toBeUndefined()
  })

  it('clear on an unknown chat is a no-op', () => {
    const before = useAgentFailureStore.getState().failures
    useAgentFailureStore.getState().clear('nope')
    expect(useAgentFailureStore.getState().failures).toBe(before)
  })
})
