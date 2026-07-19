import { beforeEach, describe, expect, it } from 'vitest'
import { recentAgentRuns, useAgentRunStore } from '../../src/renderer/src/stores/agentRunStore'
import type { AgentRunEvent, AgentRunSummary } from '../../src/shared/agentRuntime'

const run = (invocationId: string, status: AgentRunSummary['status']): AgentRunSummary => ({
  invocationId,
  chatId: 'c1',
  floor: 2,
  agentName: 'memory.curator',
  status,
  startedAt: '2026-07-18T12:00:00.000Z',
  notification: 'none',
  metrics: {
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 8,
    cacheWriteTokens: 1,
    latencyMs: 40,
    retries: 0,
    rateLimits: []
  }
})

describe('agentRunStore renderer read model', () => {
  beforeEach(() =>
    useAgentRunStore.setState({
      byChat: {},
      loadingByChat: {},
      errorByChat: {},
      revision: 0,
      revisionByChat: {},
      deletedRevisionByChat: {},
      hydrationByChat: {}
    })
  )

  it('keeps quiet invocations visible while running and recent after completion', () => {
    useAgentRunStore.getState().apply({ type: 'started', run: run('quiet', 'running') })
    expect(useAgentRunStore.getState().byChat.c1.quiet).toMatchObject({
      status: 'running',
      notification: 'none'
    })

    useAgentRunStore.getState().apply({
      type: 'finished',
      run: { ...run('quiet', 'succeeded'), finishedAt: '2026-07-18T12:00:01.000Z' }
    })
    expect(useAgentRunStore.getState().byChat.c1.quiet.status).toBe('succeeded')
  })

  it('removes only the deleted invocation', () => {
    for (const invocationId of ['one', 'two']) {
      useAgentRunStore
        .getState()
        .apply({ type: 'started', run: run(invocationId, 'running') } as AgentRunEvent)
    }
    useAgentRunStore
      .getState()
      .apply({ type: 'deleted', invocationId: 'one', chatId: 'c1', floor: 2 })

    expect(Object.keys(useAgentRunStore.getState().byChat.c1)).toEqual(['two'])
  })

  it('keeps every running invocation plus only the capped terminal history', () => {
    for (let index = 0; index < 7; index += 1) {
      useAgentRunStore.getState().apply({
        type: 'started',
        run: { ...run(`running-${index}`, 'running'), startedAt: `2026-07-18T12:00:0${index}.000Z` }
      })
    }
    for (let index = 0; index < 7; index += 1) {
      useAgentRunStore.getState().apply({
        type: 'finished',
        run: {
          ...run(`terminal-${index}`, 'succeeded'),
          startedAt: `2026-07-18T11:00:0${index}.000Z`,
          finishedAt: `2026-07-18T11:01:0${index}.000Z`
        }
      })
    }

    const visible = recentAgentRuns(useAgentRunStore.getState().byChat, 'c1')
    expect(visible.filter((item) => item.status === 'running')).toHaveLength(7)
    expect(visible.filter((item) => item.status !== 'running')).toHaveLength(5)
  })

  it('merges starts, finishes, and snapshot-absent runs received during hydration', () => {
    const generation = useAgentRunStore.getState().beginHydrate('c1')
    useAgentRunStore.getState().apply({ type: 'started', run: run('started-late', 'running') })
    useAgentRunStore.getState().apply({ type: 'started', run: run('finished-late', 'running') })
    useAgentRunStore.getState().apply({
      type: 'finished',
      run: {
        ...run('finished-late', 'succeeded'),
        finishedAt: '2026-07-18T12:00:01.000Z'
      }
    })

    expect(
      useAgentRunStore.getState().hydrate(
        'c1',
        [
          {
            ...run('finished-late', 'running'),
            agentVersion: 1,
            agentHash: 'hash',
            input: {},
            promptMessages: [],
            resultContract: { type: 'text' },
            retryPolicy: { maxRetryAttempts: 0, delayMs: 0 },
            provider: { presetId: 'preset', model: 'model', parameters: {} },
            attempts: [],
            evidence: null,
            replay: { status: 'not-requested' },
            warnings: []
          }
        ],
        generation
      )
    ).toBe(true)
    expect(useAgentRunStore.getState().byChat.c1).toMatchObject({
      'started-late': { status: 'running' },
      'finished-late': { status: 'succeeded' }
    })
  })

  it('ignores stale hydration generations and isolates chat hydration', () => {
    const stale = useAgentRunStore.getState().beginHydrate('c1')
    const current = useAgentRunStore.getState().beginHydrate('c1')
    const otherChat = useAgentRunStore.getState().beginHydrate('c2')

    expect(useAgentRunStore.getState().hydrate('c1', [], stale)).toBe(false)
    expect(useAgentRunStore.getState().loadingByChat.c1).toBe(true)
    expect(useAgentRunStore.getState().hydrate('c2', [], otherChat)).toBe(true)
    expect(useAgentRunStore.getState().hydrate('c1', [], current)).toBe(true)
    expect(useAgentRunStore.getState().byChat.c2).toEqual({})
  })

  it('replaces the selected chat hydration and reports loading failures per chat', () => {
    useAgentRunStore.getState().apply({ type: 'started', run: run('old', 'running') })
    const initial = useAgentRunStore.getState().beginHydrate('c2')
    useAgentRunStore.getState().hydrate('c2', [], initial)
    const failed = useAgentRunStore.getState().beginHydrate('c2')
    useAgentRunStore.getState().failHydrate('c2', failed)

    expect(useAgentRunStore.getState()).toMatchObject({
      loadingByChat: { c2: false },
      errorByChat: { c2: true }
    })
    expect(useAgentRunStore.getState().byChat.c1.old.status).toBe('running')
    expect(recentAgentRuns(useAgentRunStore.getState().byChat, 'c2')).toEqual([])
  })
})
