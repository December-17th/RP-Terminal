// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'

/**
 * Renderer smoke-mount seam (execution-plan M2 §2).
 *
 * The rest of the suite pins `environment: 'node'` with no DOM, so no test can mount a React tree.
 * That blind spot let commit `2ce4277` ship: AgentRunActivity subscribed to an unstable store
 * snapshot, re-rendered forever, and tore the WHOLE app
 * down — a blank window past 4000+ green tests. This file actually MOUNTS the two Agent-Runtime
 * render surfaces (TopStrip → AgentRunActivity, and the Agent Workspace popup) so a top-level
 * render crash — a throw during mount OR an unstable-snapshot render loop ("Maximum update depth
 * exceeded") — fails the gate.
 *
 * ACCEPTANCE: reverting the `2ce4277` guard (deriving `runs` inside a `useShallow` selector in
 * AgentRunActivity, so the snapshot is a fresh array every render) must make this test throw.
 *
 * window.api is a pragmatic Proxy: the handful of channels the mount path awaits return real
 * shapes (arrays / objects the components destructure or iterate); everything else returns a value
 * that is both callable (event-registration unsub) and awaitable (async call) so no mount-time call
 * throws. We do NOT hand-mock hundreds of channels.
 */

const apiOverrides: Record<string, (...args: unknown[]) => unknown> = {
  listAgentCatalog: async () => [],
  getAgentRoleBindings: async () => ({}),
  listAgentRuns: async () => [],
  getRenderMarkers: async () => ({ before: [], after: [] })
}

// Default channel: returns undefined so `await api.foo()` resolves cleanly and the inline-card
// bridge, which JSON-clones whatever its sync host getters return at build time, never chokes on a
// non-serializable value. Event-registration channels (`on*`, returning an unsub fn) are re-added
// below because the mount path calls their unsub. Value channels the mount path destructures are in
// apiOverrides with real shapes.
const apiStub = new Proxy(apiOverrides, {
  get(target, prop: string) {
    if (prop in target) return target[prop]
    if (prop.startsWith('on')) return () => () => {}
    return () => undefined
  }
})

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = apiStub
  // jsdom implements neither of these; ChatView's paging effect calls scrollTo on mount.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  if (!window.scrollTo) window.scrollTo = () => {}
})

afterEach(() => {
  cleanup()
  apiOverrides.listAgentCatalog = async () => []
  apiOverrides.getAgentRoleBindings = async () => ({})
  apiOverrides.listAgentRuns = async () => []
  delete apiOverrides.getAgentDefinition
  delete apiOverrides.editAgent
  delete apiOverrides.restoreAgent
  delete apiOverrides.upgradeAgent
  delete apiOverrides.deleteAgent
  delete apiOverrides.bindAgentRole
  delete apiOverrides.listAgentLabCases
  delete apiOverrides.runAgentLabCaseLive
  delete apiOverrides.captureAgentLabCase
  sessionStorage.clear()
})

// Imported after the jsdom/window.api setup above so store modules see a live window.
async function seedActiveSession(): Promise<string> {
  const { useChatStore } = await import('../../src/renderer/src/stores/chatStore')
  const { useUiStore } = await import('../../src/renderer/src/stores/uiStore')
  const { useAgentRunStore } = await import('../../src/renderer/src/stores/agentRunStore')
  const chatId = 'smoke-chat-1'
  useChatStore.setState({
    activeChatId: chatId,
    floors: [],
    isGenerating: false,
    error: null,
    activeChatMode: 'explore'
  })
  // A running row exercises the title-strip AgentRunActivity disclosure, not just its empty branch.
  useAgentRunStore.setState({
    revisionByChat: {},
    byChat: {
      [chatId]: {
        'run-1': {
          invocationId: 'run-1',
          chatId,
          floor: 0,
          agentName: 'memory.curator',
          status: 'running',
          startedAt: '2026-07-19T00:00:00.000Z',
          notification: 'none',
          metrics: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            latencyMs: 1,
            retries: 0,
            rateLimits: []
          }
        }
      }
    }
  })
  useUiStore.setState({
    settingsOpen: false,
    agentWorkspaceOpen: true,
    agentWorkspaceAgentId: null,
    agentWorkspaceRunId: null,
    agentWorkspaceAgentName: null,
    agentWorkspaceInitialTab: null
  })
  return chatId
}

describe('Agent-Runtime renderer surfaces mount without crashing', () => {
  it('ChatView mounts with a session open', async () => {
    await seedActiveSession()
    const { ChatView } = await import('../../src/renderer/src/components/ChatView')
    const { container } = render(<ChatView profileId="p1" />)
    expect(container.firstChild).toBeTruthy()
  })

  it('toggles Agent status inside the title-strip spacer without an overlay', async () => {
    await seedActiveSession()
    const { TopStrip } = await import('../../src/renderer/src/components/TopStrip')
    const view = render(<TopStrip profileId="p1" profileName="Player" />)
    const toggle = view.getByRole('button', { name: /show agent activity/i })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('memory.curator')).toBeNull()
    expect(view.container.querySelector('.tstrip-agent-runs__popover')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('memory.curator')).toBeTruthy()
    expect(view.container.querySelector('.tstrip-spacer > #agent-run-status-strip')).toBeTruthy()
    expect(view.container.querySelector('.tstrip-agent-runs__popover')).toBeNull()

    fireEvent.click(view.getByTitle(/Open memory\.curator/))
    const { useUiStore } = await import('../../src/renderer/src/stores/uiStore')
    expect(useUiStore.getState()).toMatchObject({
      agentWorkspaceOpen: true,
      agentWorkspaceRunId: 'run-1',
      agentWorkspaceAgentName: 'memory.curator',
      agentWorkspaceInitialTab: 'runs'
    })

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('memory.curator')).toBeNull()
  })

  it('offers View all runs when the title strip hides activity items', async () => {
    const chatId = await seedActiveSession()
    const { useAgentRunStore } = await import('../../src/renderer/src/stores/agentRunStore')
    const base = useAgentRunStore.getState().byChat[chatId]['run-1']
    useAgentRunStore.setState({
      byChat: {
        [chatId]: Object.fromEntries(
          [1, 2, 3, 4].map((index) => [
            `run-${index}`,
            {
              ...base,
              invocationId: `run-${index}`,
              agentName: `Agent ${index}`,
              status: index === 1 ? 'running' : 'succeeded'
            }
          ])
        )
      }
    })
    const { AgentRunStatusStrip } =
      await import('../../src/renderer/src/components/AgentRunActivity')
    const { useUiStore } = await import('../../src/renderer/src/stores/uiStore')
    const view = render(<AgentRunStatusStrip chatId={chatId} />)

    fireEvent.click(view.getByRole('button', { name: 'View all runs' }))
    expect(useUiStore.getState()).toMatchObject({
      agentWorkspaceOpen: true,
      agentWorkspaceInitialTab: 'runs'
    })
  })

  it('AgentWorkspace popup mounts (flat library + editor surface)', async () => {
    await seedActiveSession()
    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const { container } = render(<AgentWorkspace profileId="p1" />)
    expect(container.textContent).toBeTruthy()
  })

  it('preserves definition and plan drafts across tabs, and Cancel restores the saved definition', async () => {
    await seedActiveSession()
    const definition = {
      format: 'rpt-agent' as const,
      formatVersion: 1 as const,
      name: 'Agent One',
      prompt: [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'Work.' }] }],
      inputSchema: { type: 'object' as const },
      result: { mode: 'text' as const },
      tools: [],
      defaults: {
        required: false,
        maxSteps: 1,
        maxRetryAttempts: 3,
        retryDelayMs: 3000,
        blocksNextTurn: false,
        toolResultMaxTokens: 10000,
        notification: 'failure' as const
      }
    }
    apiOverrides.listAgentCatalog = async () => [
      {
        id: 'a1',
        name: 'Agent One',
        sourceKind: 'user-authored',
        sourceKey: 'user:a1',
        sourceVersion: '1',
        sourcePresent: true,
        enabled: true,
        upgradeAvailable: false,
        blocksNextTurn: false,
        resultMode: 'text',
        promptMessages: 1,
        promptChars: 5,
        roles: []
      }
    ]
    apiOverrides.getAgentDefinition = async () => definition
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })

    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)
    fireEvent.click(await view.findByRole('button', { name: /Agent One/i }))

    fireEvent.change(await view.findByDisplayValue('Agent One'), {
      target: { value: 'Draft Agent' }
    })
    fireEvent.click(view.getByRole('button', { name: 'Plan' }))
    fireEvent.click(view.getByRole('button', { name: 'Add call' }))
    fireEvent.click(view.getByRole('button', { name: 'Definition' }))
    expect(view.getByDisplayValue('Draft Agent')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(view.getByDisplayValue('Agent One')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Plan' }))
    expect(view.getByDisplayValue(/"agent": "Agent One"/)).toBeTruthy()
  })

  it('guards agent switches and Escape with save, discard, and keep-editing choices', async () => {
    await seedActiveSession()
    const definitions = Object.fromEntries(
      ['Agent One', 'Agent Two'].map((name, index) => [
        `a${index + 1}`,
        {
          format: 'rpt-agent' as const,
          formatVersion: 1 as const,
          name,
          prompt: [
            { role: 'system' as const, content: [{ type: 'text' as const, text: 'Work.' }] }
          ],
          inputSchema: { type: 'object' as const },
          result: { mode: 'text' as const },
          tools: [],
          defaults: {
            required: false,
            maxSteps: 1,
            maxRetryAttempts: 3,
            retryDelayMs: 3000,
            blocksNextTurn: false,
            toolResultMaxTokens: 10000,
            notification: 'failure' as const
          }
        }
      ])
    )
    apiOverrides.listAgentCatalog = async () =>
      ['Agent One', 'Agent Two'].map((name, index) => ({
        id: `a${index + 1}`,
        name,
        sourceKind: 'user-authored',
        sourceKey: `user:a${index + 1}`,
        sourceVersion: '1',
        sourcePresent: true,
        enabled: true,
        upgradeAvailable: false,
        blocksNextTurn: false,
        resultMode: 'text',
        promptMessages: 1,
        promptChars: 5,
        roles: []
      }))
    apiOverrides.getAgentDefinition = async (_profileId, id) => definitions[String(id)]
    let savedName = ''
    apiOverrides.editAgent = async (_profileId, _id, definition) => {
      savedName = (definition as { name: string }).name
      return { ok: true }
    }
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    const { useUiStore } = await import('../../src/renderer/src/stores/uiStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })

    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)
    fireEvent.click(await view.findByRole('button', { name: /Agent One/i }))
    fireEvent.change(await view.findByDisplayValue('Agent One'), {
      target: { value: 'Draft Agent' }
    })
    fireEvent.click(view.getByRole('button', { name: /Agent Two/i }))
    expect(view.getByRole('button', { name: 'Save changes' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Discard changes' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Keep editing' }))
    expect(view.getByDisplayValue('Draft Agent')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: /Agent Two/i }))
    fireEvent.click(view.getByRole('button', { name: 'Discard changes' }))
    expect(await view.findByDisplayValue('Agent Two')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /Agent One/i }))
    fireEvent.change(await view.findByDisplayValue('Agent One'), {
      target: { value: 'Draft Agent' }
    })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(useUiStore.getState().agentWorkspaceOpen).toBe(false))
    expect(savedName).toBe('Draft Agent')
  })

  it('separates explicit definition saves from immediate settings and confirms source overwrites', async () => {
    await seedActiveSession()
    const definition = {
      format: 'rpt-agent' as const,
      formatVersion: 1 as const,
      name: 'Source Agent',
      prompt: [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'Work.' }] }],
      inputSchema: { type: 'object' as const },
      result: { mode: 'text' as const },
      tools: [],
      defaults: {
        required: false,
        maxSteps: 1,
        maxRetryAttempts: 3,
        retryDelayMs: 3000,
        blocksNextTurn: false,
        toolResultMaxTokens: 10000,
        notification: 'failure' as const
      }
    }
    const summary = {
      id: 'source-1',
      name: 'Source Agent',
      sourceKind: 'user-imported' as const,
      sourceKey: 'file:source-agent.rptagent',
      sourceVersion: '1',
      sourcePresent: true,
      enabled: true,
      customized: true,
      upgradeAvailable: true,
      blocksNextTurn: false,
      resultMode: 'text' as const,
      promptMessages: 1,
      promptChars: 5,
      roles: [],
      hasApiPreset: false,
      updatedAt: '2026-07-21T00:00:00.000Z'
    }
    let restoreCalls = 0
    let upgradeCalls = 0
    apiOverrides.listAgentCatalog = async () => [summary]
    apiOverrides.getAgentDefinition = async () => definition
    apiOverrides.restoreAgent = async () => {
      restoreCalls += 1
      return { ok: true, agent: summary }
    }
    apiOverrides.upgradeAgent = async () => {
      upgradeCalls += 1
      return { ok: true, agent: summary }
    }
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })

    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)
    fireEvent.click(await view.findByRole('button', { name: /Source Agent/i }))

    expect(await view.findByText('Operational settings')).toBeTruthy()
    expect(view.getByText(/Preset, role, and enabled state apply immediately/)).toBeTruthy()
    expect(view.getByText('Definition draft')).toBeTruthy()
    expect(view.getByText('Saved')).toBeTruthy()
    fireEvent.change(view.getByDisplayValue('Source Agent'), {
      target: { value: 'Unsaved Source Agent' }
    })
    expect(view.getByText('Unsaved changes')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Restore to source' }))
    const restoreDialog = view
      .getByText('Restore “Source Agent” to its source?')
      .closest('.modal-panel') as HTMLElement
    expect(within(restoreDialog).getByText(/saved definition customizations/)).toBeTruthy()
    expect(restoreCalls).toBe(0)
    fireEvent.click(within(restoreDialog).getByRole('button', { name: 'Restore to source' }))
    await vi.waitFor(() => expect(restoreCalls).toBe(1))
    await vi.waitFor(() =>
      expect(
        (view.getByRole('button', { name: 'Update, use source' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )

    fireEvent.click(view.getByRole('button', { name: 'Update, use source' }))
    const updateDialog = view
      .getByText('Update “Source Agent” from its source?')
      .closest('.modal-panel') as HTMLElement
    expect(
      within(updateDialog).getByText(/saved edits to fields changed by the source/)
    ).toBeTruthy()
    expect(upgradeCalls).toBe(0)
    fireEvent.click(within(updateDialog).getByRole('button', { name: 'Update, use source' }))
    await vi.waitFor(() => expect(upgradeCalls).toBe(1))
  })

  it('starts creation from an outcome and progressively discloses definition details', async () => {
    await seedActiveSession()
    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)

    fireEvent.click(await view.findByRole('button', { name: 'New agent' }))
    expect(view.getByRole('button', { name: /Narrative role/ })).toBeTruthy()
    expect(view.getByRole('button', { name: /Background updater/ })).toBeTruthy()
    expect(view.getByRole('button', { name: /Custom/ })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: /Background updater/ }))
    expect(view.getByText('Essentials')).toBeTruthy()
    for (const label of ['Result', 'Tools & input', 'Triggering', 'Reliability']) {
      const disclosure = view.getByText(label).closest('details') as HTMLDetailsElement
      expect(disclosure.open).toBe(false)
    }
  })

  it('builds manual input from the schema and renders structured run evidence', async () => {
    await seedActiveSession()
    const definition = {
      format: 'rpt-agent' as const,
      formatVersion: 1 as const,
      name: 'Updater',
      prompt: [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'Update.' }] }],
      inputSchema: {
        type: 'object',
        required: ['topic'],
        properties: { topic: { type: 'string', title: 'Topic', description: 'What to update.' } }
      },
      result: { mode: 'json' as const, schema: { type: 'object' } },
      tools: [],
      defaults: {
        required: false,
        maxSteps: 1,
        maxRetryAttempts: 3,
        retryDelayMs: 3000,
        blocksNextTurn: false,
        toolResultMaxTokens: 10000,
        notification: 'failure' as const
      }
    }
    const summary = {
      id: 'updater',
      name: 'Updater',
      sourceKind: 'user-authored' as const,
      sourceKey: 'user:updater',
      sourceVersion: '1',
      sourcePresent: true,
      enabled: true,
      upgradeAvailable: false,
      blocksNextTurn: false,
      resultMode: 'json' as const,
      promptMessages: 1,
      promptChars: 7,
      roles: []
    }
    apiOverrides.listAgentCatalog = async () => [summary]
    apiOverrides.getAgentDefinition = async () => definition
    apiOverrides.listAgentRuns = async () => [
      {
        invocationId: 'run-structured',
        agentName: 'Updater',
        status: 'succeeded',
        floor: 4,
        startedAt: '2026-07-21T10:00:00.000Z',
        finishedAt: '2026-07-21T10:00:00.250Z',
        metrics: { retries: 1 },
        attempts: [
          {
            attempt: 1,
            outcome: 'retry',
            providerCalls: 1,
            latencyMs: [120],
            repairs: [],
            tools: [{ call: { name: 'lookup' }, result: { ok: true } }]
          }
        ],
        warnings: ['Prompt source unavailable.'],
        result: { updated: true }
      }
    ]
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })
    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)

    fireEvent.click(await view.findByRole('button', { name: /Updater/i }))
    fireEvent.click(await view.findByRole('button', { name: 'Runs' }))
    expect(await view.findByLabelText(/Topic/)).toBeTruthy()
    const advanced = view.getByText('Advanced').closest('details') as HTMLDetailsElement
    expect(advanced.open).toBe(false)

    const history = view.container.querySelector('.agent-runs__list') as HTMLElement
    fireEvent.click(await within(history).findByRole('button', { name: /Updater/ }))
    expect(view.getByText('250 ms')).toBeTruthy()
    expect(view.getByText('Warnings (1)')).toBeTruthy()
    expect(view.getByText('Tool calls (1)')).toBeTruthy()
    expect(view.getByText('Output')).toBeTruthy()
    const detail = view.container.querySelector('.agent-runs__detail') as HTMLElement
    expect(
      (within(detail).getByText('Copy JSON').closest('details') as HTMLDetailsElement).open
    ).toBe(false)
  })

  it('deep-links to an exact failed run and opens the grounded preset recovery', async () => {
    const chatId = await seedActiveSession()
    const definition = {
      format: 'rpt-agent' as const,
      formatVersion: 1 as const,
      name: 'Provider Agent',
      prompt: [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'Work.' }] }],
      inputSchema: { type: 'object' as const },
      result: { mode: 'text' as const },
      tools: [],
      defaults: {
        required: false,
        maxSteps: 1,
        maxRetryAttempts: 3,
        retryDelayMs: 3000,
        blocksNextTurn: false,
        toolResultMaxTokens: 10000,
        notification: 'failure' as const
      }
    }
    apiOverrides.listAgentCatalog = async () => [
      {
        id: 'provider-agent',
        name: 'Provider Agent',
        sourceKind: 'user-authored',
        sourceKey: 'user:provider-agent',
        sourceVersion: '1',
        sourcePresent: true,
        enabled: true,
        upgradeAvailable: false,
        blocksNextTurn: false,
        resultMode: 'text',
        promptMessages: 1,
        promptChars: 5,
        roles: []
      }
    ]
    apiOverrides.getAgentDefinition = async () => definition
    apiOverrides.listAgentRuns = async () => [
      {
        invocationId: 'provider-run',
        profileId: 'p1',
        chatId,
        floor: 3,
        agentName: 'Provider Agent',
        agentVersion: 1,
        agentHash: 'hash',
        status: 'failed',
        startedAt: '2026-07-21T10:00:00.000Z',
        finishedAt: '2026-07-21T10:00:00.100Z',
        notification: 'failure',
        definition,
        config: {},
        input: {},
        renderedPrompt: [],
        history: [],
        contracts: { input: {}, result: definition.result, tools: [] },
        provider: {
          presetId: 'preset-1',
          presetName: 'Primary',
          provider: 'openai',
          endpoint: 'responses',
          model: 'test-model',
          parameters: {}
        },
        attempts: [
          {
            attempt: 1,
            outcome: 'failure',
            providerCalls: 1,
            immutablePrefix: [],
            appendOnlyLog: [],
            messages: [],
            toolSchemas: [],
            repairs: [],
            tools: [],
            usage: [],
            cache: [],
            latencyMs: [100],
            rateLimits: [],
            error: {
              code: 'PROVIDER_TRANSIENT',
              message: 'Provider unavailable.',
              retryable: true
            }
          }
        ],
        evidence: {},
        failure: {
          code: 'PROVIDER_TRANSIENT',
          message: 'Provider unavailable.',
          retryable: true
        },
        replay: { status: 'not-applicable', operations: 0 },
        metrics: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          latencyMs: 100,
          retries: 0,
          rateLimits: []
        },
        warnings: []
      }
    ]
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    const { useUiStore } = await import('../../src/renderer/src/stores/uiStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })
    useUiStore.getState().openAgentWorkspace({
      runId: 'provider-run',
      agentName: 'Provider Agent',
      tab: 'runs'
    })

    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)
    expect((await view.findAllByText('Provider unavailable.')).length).toBe(2)
    expect(
      (view.container.querySelector('.agent-runs__timeline-failure details') as HTMLDetailsElement)
        .open
    ).toBe(true)

    fireEvent.click(view.getByRole('button', { name: 'Open preset' }))
    expect(useUiStore.getState()).toMatchObject({
      agentWorkspaceOpen: false,
      settingsOpen: true,
      settingsSection: 'preset'
    })
  })

  // Agent Lab (Slice B). Reuse one Agent summary + definition; vary the cases the Lab tab lists.
  const labAgentSummary = {
    id: 'a1',
    name: 'Agent One',
    sourceKind: 'user-authored' as const,
    sourceKey: 'user:a1',
    sourceVersion: '1',
    sourcePresent: true,
    enabled: true,
    upgradeAvailable: false,
    blocksNextTurn: false,
    resultMode: 'text' as const,
    promptMessages: 1,
    promptChars: 5,
    roles: []
  }
  const labDefinition = {
    format: 'rpt-agent' as const,
    formatVersion: 1 as const,
    name: 'Agent One',
    prompt: [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'Work.' }] }],
    inputSchema: { type: 'object' as const },
    result: { mode: 'text' as const },
    tools: [],
    defaults: {
      required: false,
      maxSteps: 1,
      maxRetryAttempts: 3,
      retryDelayMs: 3000,
      blocksNextTurn: false,
      toolResultMaxTokens: 10000,
      notification: 'failure' as const
    }
  }
  const capturedCase = {
    id: 'case-1',
    agentId: 'a1',
    agentName: 'Agent One',
    name: 'Captured case',
    createdAt: '2026-07-21T00:00:00.000Z',
    agentHash: 'abcdef1234567890',
    sourceInvocationId: 'run-src',
    hasSource: true,
    runs: [
      {
        invocationId: 'run-y',
        chatId: 'smoke-chat-1',
        mode: 'live' as const,
        startedAt: '2026-07-21T01:00:00.000Z',
        status: 'succeeded'
      }
    ]
  }
  const authoredCase = {
    id: 'case-2',
    agentId: 'a1',
    agentName: 'Agent One',
    name: 'Authored case',
    createdAt: '2026-07-21T02:00:00.000Z',
    hasSource: false,
    runs: []
  }

  async function openLabTab(cases: unknown[]): Promise<ReturnType<typeof render>> {
    await seedActiveSession()
    apiOverrides.listAgentCatalog = async () => [labAgentSummary]
    apiOverrides.getAgentDefinition = async () => labDefinition
    apiOverrides.listAgentLabCases = async () => cases
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })
    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)
    fireEvent.click(await view.findByRole('button', { name: /Agent One/i }))
    fireEvent.click(await view.findByRole('button', { name: 'Lab' }))
    return view
  }

  it('Lab tab lists saved cases for the selected Agent', async () => {
    const view = await openLabTab([capturedCase])
    expect(await view.findByText('Captured case')).toBeTruthy()
    expect(view.getByText(/Captured against/)).toBeTruthy()
  })

  it('disables Replay for an authored case with no captured source', async () => {
    const view = await openLabTab([authoredCase])
    await view.findByText('Authored case')
    const replay = view.getByRole('button', { name: 'Replay' }) as HTMLButtonElement
    expect(replay.disabled).toBe(true)
  })

  it('gates Run live behind a spend confirmation before dispatching', async () => {
    let liveCalls = 0
    apiOverrides.runAgentLabCaseLive = async () => {
      liveCalls += 1
      return { ok: true, invocationId: 'run-live', status: 'succeeded' }
    }
    const view = await openLabTab([capturedCase])
    await view.findByText('Captured case')
    fireEvent.click(view.getByRole('button', { name: 'Run live' }))
    const dialog = view
      .getByText('Run “Captured case” live?')
      .closest('.modal-panel') as HTMLElement
    expect(within(dialog).getByText(/spends real tokens/)).toBeTruthy()
    expect(liveCalls).toBe(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run live' }))
    await vi.waitFor(() => expect(liveCalls).toBe(1))
  })

  it('captures a run as a Lab case from the run detail', async () => {
    await seedActiveSession()
    apiOverrides.listAgentCatalog = async () => [labAgentSummary]
    apiOverrides.getAgentDefinition = async () => labDefinition
    apiOverrides.listAgentRuns = async () => [
      {
        invocationId: 'run-capture',
        chatId: 'smoke-chat-1',
        agentName: 'Agent One',
        status: 'succeeded',
        floor: 1,
        startedAt: '2026-07-21T10:00:00.000Z',
        finishedAt: '2026-07-21T10:00:00.100Z',
        metrics: { retries: 0 },
        attempts: [],
        warnings: []
      }
    ]
    let captureArgs: unknown[] = []
    apiOverrides.captureAgentLabCase = async (...args: unknown[]) => {
      captureArgs = args
      return { ok: true, case: capturedCase }
    }
    const { useAgentCatalogStore } = await import('../../src/renderer/src/stores/agentCatalogStore')
    useAgentCatalogStore.setState({ agents: [], definitions: {}, bindings: {} })
    const { AgentWorkspace } =
      await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const view = render(<AgentWorkspace profileId="p1" />)
    fireEvent.click(await view.findByRole('button', { name: /Agent One/i }))
    fireEvent.click(await view.findByRole('button', { name: 'Runs' }))
    // Wait for the tab's async refreshRuns() to paint the history row (its unique timestamp).
    await view.findByText('2026-07-21T10:00:00.000Z')

    const history = view.container.querySelector('.agent-runs__list') as HTMLElement
    fireEvent.click(await within(history).findByRole('button', { name: /Agent One/ }))
    const detail = view.container.querySelector('.agent-runs__detail') as HTMLElement
    fireEvent.click(within(detail).getByRole('button', { name: 'Save as Lab case' }))

    // The inline name panel is prefilled with a default name; confirm captures without a modal.
    fireEvent.click(await view.findByRole('button', { name: 'Save case' }))
    await vi.waitFor(() => expect(captureArgs[0]).toBe('p1'))
    expect(captureArgs[1]).toBe('smoke-chat-1')
    expect(captureArgs[2]).toBe('run-capture')
    expect(typeof captureArgs[3]).toBe('string')
  })

  it('AgentsPanel shows an explicit Default for both unbound roles', async () => {
    await seedActiveSession()
    const { AgentsPanel } = await import('../../src/renderer/src/components/AgentsPanel')
    const { container, getAllByRole } = render(<AgentsPanel profileId="p1" />)
    expect(container).toBeTruthy()
    const roleBindings = getAllByRole('combobox') as HTMLSelectElement[]
    expect(roleBindings).toHaveLength(2)
    expect(roleBindings.map((select) => select.value)).toEqual(['', ''])
    expect(roleBindings.map((select) => select.selectedOptions[0]?.textContent)).toEqual([
      'Default',
      'Default'
    ])
  })

  // Session 10 "Required tests": role replacement before disable/delete. The panel must not let the
  // user disable or delete an Agent that is still bound to a role — they have to reassign the role
  // first (enforced as disabled controls with an explanatory title). Only render-mountable now.
  it('AgentsPanel disables Disable/Delete for a role-bound Agent, enables them once unbound', async () => {
    await seedActiveSession()
    const summary = (roles: string[]): unknown => ({
      id: 'a1',
      name: 'memory.curator',
      sourceKind: 'builtin',
      sourceKey: 'builtin:memory.curator',
      sourceVersion: '1',
      sourcePresent: true,
      enabled: true,
      upgradeAvailable: false,
      blocksNextTurn: false,
      resultMode: 'text',
      promptMessages: 1,
      promptChars: 10,
      roles
    })
    const { AgentsPanel } = await import('../../src/renderer/src/components/AgentsPanel')

    apiOverrides.listAgentCatalog = async () => [summary(['classic.narrator'])]
    apiOverrides.getAgentRoleBindings = async () => ({ 'classic.narrator': 'a1' })
    const bound = render(<AgentsPanel profileId="p1" />)
    // findBy* waits for the post-mount refresh() promise to resolve and the list to paint.
    const disableBtn = await bound.findByText(
      (_t, el) => el?.tagName === 'BUTTON' && /Disable/i.test(el.textContent ?? '')
    )
    const deleteBtn = bound.getByText(
      (_t, el) => el?.tagName === 'BUTTON' && /Delete/i.test(el.textContent ?? '')
    )
    expect((disableBtn as HTMLButtonElement).disabled).toBe(true)
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    apiOverrides.listAgentCatalog = async () => [summary([])]
    apiOverrides.getAgentRoleBindings = async () => ({})
    const unbound = render(<AgentsPanel profileId="p1" />)
    const disable2 = await unbound.findByText(
      (_t, el) => el?.tagName === 'BUTTON' && /Disable/i.test(el.textContent ?? '')
    )
    const delete2 = unbound.getByText(
      (_t, el) => el?.tagName === 'BUTTON' && /Delete/i.test(el.textContent ?? '')
    )
    expect((disable2 as HTMLButtonElement).disabled).toBe(false)
    expect((delete2 as HTMLButtonElement).disabled).toBe(false)

    let deleteCalls = 0
    apiOverrides.deleteAgent = async () => {
      deleteCalls += 1
      return { ok: true }
    }
    fireEvent.click(delete2)
    const deleteDialog = unbound
      .getByText('Delete “memory.curator”?')
      .closest('.modal-panel') as HTMLElement
    expect(within(deleteDialog).getByText(/profile-local settings/)).toBeTruthy()
    expect(deleteCalls).toBe(0)
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))
    await vi.waitFor(() => expect(deleteCalls).toBe(1))

    // Restore the shared defaults for later tests.
    apiOverrides.listAgentCatalog = async () => []
    apiOverrides.getAgentRoleBindings = async () => ({})
  })
})
