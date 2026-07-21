import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/vanilla/shallow'
import { recentAgentRuns, useAgentRunStore } from '../../src/renderer/src/stores/agentRunStore'
import type { AgentRunSummary } from '../../src/shared/agentRuntime'

/**
 * Regression guard for the blank-screen-on-session-entry bug.
 *
 * The title-strip Agent activity toggle mounts as soon as a chat is opened. React's
 * useSyncExternalStore requires every
 * store subscription to return a value that is Object.is-stable while the store is unchanged; an
 * unstable snapshot re-renders forever and tears the whole tree down — the title strip goes with it.
 *
 * The original code subscribed with `useShallow(state => ({ runs: recentAgentRuns(...), ... }))`.
 * `recentAgentRuns` builds a fresh array per call, and shallow() compares that nested array with
 * Object.is (node_modules/zustand/vanilla/shallow.js), so the snapshot was never stable.
 *
 * NOTE ON SEAM: the faithful test would mount the component and observe the render loop, but this
 * repo has no DOM test environment (vitest.config.ts pins environment: 'node'), so these tests
 * assert the underlying invariant the component depends on instead of the render behaviour itself.
 */
const summary = (invocationId: string, status: AgentRunSummary['status']): AgentRunSummary => ({
  invocationId,
  chatId: 'chat-1',
  floor: 3,
  agentName: 'memory.curator',
  status,
  startedAt: '2026-07-18T12:00:00.000Z',
  notification: 'none',
  metrics: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 10,
    retries: 0,
    rateLimits: []
  }
})

describe('AgentRunActivity store subscription stability', () => {
  // The exact stable store slices used by the title-strip Agent activity surfaces.
  const subscriptions = [
    (state: ReturnType<typeof useAgentRunStore.getState>) => state.byChat,
    (state: ReturnType<typeof useAgentRunStore.getState>) => state.loadingByChat['chat-1'] ?? false,
    (state: ReturnType<typeof useAgentRunStore.getState>) => state.errorByChat['chat-1'] ?? false
  ]

  it('every subscription is Object.is-stable across repeated reads of an unchanged store', () => {
    useAgentRunStore.setState({
      byChat: { 'chat-1': { 'run-1': summary('run-1', 'running') } }
    })
    const state = useAgentRunStore.getState()

    for (const select of subscriptions) expect(select(state)).toBe(select(state))
  })

  it('is stable for a chat that has no runs at all (a freshly created session)', () => {
    useAgentRunStore.setState({ byChat: {} })
    const state = useAgentRunStore.getState()

    for (const select of subscriptions) expect(select(state)).toBe(select(state))
  })

  it('recentAgentRuns is unsafe to call inside a selector: it returns a fresh array each call', () => {
    // Pins WHY the derivation must stay in useMemo rather than move back into a store selector.
    const byChat = { 'chat-1': { 'run-1': summary('run-1', 'running') } }

    const first = recentAgentRuns(byChat, 'chat-1')
    const second = recentAgentRuns(byChat, 'chat-1')

    expect(second).not.toBe(first)
    expect(second).toStrictEqual(first)
    // ...and therefore a wrapper object around it never shallow-compares equal.
    expect(shallow({ runs: first }, { runs: second })).toBe(false)
  })
})
