import { describe, it, expect, beforeEach } from 'vitest'
import {
  useRecallFailOpenStore,
  recallOutcome,
  shouldShowRecallBanner,
  RECALL_FAILOPEN_THRESHOLD
} from '../../src/renderer/src/stores/recallFailOpenStore'
import type { WorkflowRunTrace, TraceNode } from '../../src/shared/workflow/trace'

const node = (over: Partial<TraceNode> = {}): TraceNode => ({
  nodeId: 'n1',
  nodeType: 'memory.recall',
  status: 'ran',
  phase: 'pre',
  ...over
})

const trace = (nodes: TraceNode[]): WorkflowRunTrace => ({
  chatId: 'c1',
  workflowId: 'turn:default',
  startedAt: 0,
  durationMs: 1,
  ok: true,
  aborted: false,
  nodes
})

describe('recallOutcome', () => {
  it('is null when the trace has no recall node (leave the streak untouched)', () => {
    expect(recallOutcome(trace([node({ nodeType: 'memory.maintain' })]))).toBeNull()
  })
  it('is "failed" when the recall node fail-opened', () => {
    expect(recallOutcome(trace([node({ failedOpen: true })]))).toBe('failed')
  })
  it('is "ok" when the recall node ran cleanly', () => {
    expect(recallOutcome(trace([node()]))).toBe('ok')
  })
})

describe('shouldShowRecallBanner', () => {
  it('shows only at/above the threshold and only when not dismissed', () => {
    expect(shouldShowRecallBanner(RECALL_FAILOPEN_THRESHOLD - 1, false)).toBe(false)
    expect(shouldShowRecallBanner(RECALL_FAILOPEN_THRESHOLD, false)).toBe(true)
    expect(shouldShowRecallBanner(RECALL_FAILOPEN_THRESHOLD, true)).toBe(false)
  })
})

describe('useRecallFailOpenStore', () => {
  beforeEach(() => {
    useRecallFailOpenStore.setState({ counts: {}, dismissed: {} })
  })

  it('bumps the streak on each fail-open and reaches the threshold', () => {
    const s = () => useRecallFailOpenStore.getState()
    for (let i = 0; i < RECALL_FAILOPEN_THRESHOLD; i++) s().record('c1', true)
    expect(s().counts['c1']).toBe(RECALL_FAILOPEN_THRESHOLD)
    expect(shouldShowRecallBanner(s().counts['c1'], !!s().dismissed['c1'])).toBe(true)
  })

  it('a clean recall resets the streak AND re-arms a dismissed banner', () => {
    const s = () => useRecallFailOpenStore.getState()
    s().record('c1', true)
    s().record('c1', true)
    s().dismiss('c1')
    expect(s().dismissed['c1']).toBe(true)
    s().record('c1', false) // successful recall
    expect(s().counts['c1']).toBeUndefined()
    expect(s().dismissed['c1']).toBeUndefined()
  })

  it('tracks chats independently', () => {
    const s = () => useRecallFailOpenStore.getState()
    s().record('c1', true)
    s().record('c2', true)
    s().record('c2', true)
    expect(s().counts['c1']).toBe(1)
    expect(s().counts['c2']).toBe(2)
  })

  it('a success on an untracked chat is a no-op (same state reference)', () => {
    const before = useRecallFailOpenStore.getState().counts
    useRecallFailOpenStore.getState().record('nope', false)
    expect(useRecallFailOpenStore.getState().counts).toBe(before)
  })
})
