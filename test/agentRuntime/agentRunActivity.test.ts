import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRunActivityListView,
  requestAgentRunCancel
} from '../../src/renderer/src/components/AgentRunActivity'
import { translate } from '../../src/renderer/src/i18n'
import type { AgentRunSummary } from '../../src/shared/agentRuntime'

const running: AgentRunSummary = {
  invocationId: 'run-1',
  chatId: 'chat-1',
  floor: 17,
  agentName: 'memory.curator',
  status: 'running',
  startedAt: '2026-07-18T12:00:00.000Z',
  notification: 'none',
  model: 'frozen-model-v2',
  metrics: {
    inputTokens: 1200,
    outputTokens: 34,
    cacheReadTokens: 900,
    cacheWriteTokens: 12,
    latencyMs: 1250,
    retries: 0,
    rateLimits: []
  }
}

describe('AgentRunActivity public UI seam', () => {
  const cancelAgentRun = vi.fn()

  beforeEach(() => {
    cancelAgentRun.mockReset()
    vi.stubGlobal('window', { api: { cancelAgentRun } })
  })

  it('renders quiet running activity with floor, status, frozen model, use, latency and stop label', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunActivityListView, {
        runs: [running],
        loading: false,
        loadError: false,
        cancelError: false,
        stoppingIds: new Set<string>(),
        onStop: vi.fn(),
        t: (key: string, vars?: Record<string, string | number>) => translate('en', key, vars)
      })
    )

    expect(html).toContain('memory.curator')
    expect(html).toContain('Floor 17')
    expect(html).toContain('Running')
    expect(html).toContain('frozen-model-v2')
    expect(html).toContain('Tokens 1,200 in / 34 out')
    expect(html).toContain('Cache 900 read / 12 write')
    expect(html).toContain('Latency 1.3s')
    expect(html).toContain('aria-label="Stop memory.curator on floor 17"')
  })

  it('uses the scoped typed preload cancellation call', async () => {
    cancelAgentRun.mockResolvedValue({ invocationId: 'run-1', cancelled: true })

    await expect(requestAgentRunCancel('profile-1', 'chat-1', 'run-1')).resolves.toEqual({
      invocationId: 'run-1',
      cancelled: true
    })
    expect(cancelAgentRun).toHaveBeenCalledWith('profile-1', 'chat-1', 'run-1')
  })

  it('renders a Stop action for every visible running invocation', () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunActivityListView, {
        runs: Array.from({ length: 7 }, (_, index) => ({
          ...running,
          invocationId: `run-${index}`,
          agentName: `agent-${index}`
        })),
        loading: false,
        loadError: false,
        cancelError: false,
        stoppingIds: new Set<string>(),
        onStop: vi.fn(),
        t: (key: string, vars?: Record<string, string | number>) => translate('en', key, vars)
      })
    )

    expect(html.match(/class="agent-run-stop"/g)).toHaveLength(7)
  })

  it('renders empty and load-error states', () => {
    const view = (loadError: boolean): string =>
      renderToStaticMarkup(
        createElement(AgentRunActivityListView, {
          runs: [],
          loading: false,
          loadError,
          cancelError: false,
          stoppingIds: new Set<string>(),
          onStop: vi.fn(),
          t: (key: string, vars?: Record<string, string | number>) => translate('en', key, vars)
        })
      )

    expect(view(false)).toContain('No agent runs for this chat yet.')
    expect(view(true)).toContain('Recent agent activity could not be loaded.')
  })
})
