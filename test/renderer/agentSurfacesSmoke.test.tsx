// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

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
  useUiStore.setState({ agentWorkspaceOpen: true })
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
    expect(
      view.container.querySelector('.tstrip-spacer > #agent-run-status-strip')
    ).toBeTruthy()
    expect(view.container.querySelector('.tstrip-agent-runs__popover')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('memory.curator')).toBeNull()
  })

  it('AgentWorkspace popup mounts (flat library + editor surface)', async () => {
    await seedActiveSession()
    const { AgentWorkspace } = await import('../../src/renderer/src/components/agents/AgentWorkspace')
    const { container } = render(<AgentWorkspace profileId="p1" />)
    expect(container.textContent).toBeTruthy()
  })

  it('AgentsPanel (Settings → Agents) mounts', async () => {
    await seedActiveSession()
    const { AgentsPanel } = await import('../../src/renderer/src/components/AgentsPanel')
    const { container } = render(<AgentsPanel profileId="p1" />)
    expect(container).toBeTruthy()
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
    const disableBtn = await bound.findByText((_t, el) => el?.tagName === 'BUTTON' && /Disable/i.test(el.textContent ?? ''))
    const deleteBtn = bound.getByText((_t, el) => el?.tagName === 'BUTTON' && /Delete/i.test(el.textContent ?? ''))
    expect((disableBtn as HTMLButtonElement).disabled).toBe(true)
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    apiOverrides.listAgentCatalog = async () => [summary([])]
    apiOverrides.getAgentRoleBindings = async () => ({})
    const unbound = render(<AgentsPanel profileId="p1" />)
    const disable2 = await unbound.findByText((_t, el) => el?.tagName === 'BUTTON' && /Disable/i.test(el.textContent ?? ''))
    const delete2 = unbound.getByText((_t, el) => el?.tagName === 'BUTTON' && /Delete/i.test(el.textContent ?? ''))
    expect((disable2 as HTMLButtonElement).disabled).toBe(false)
    expect((delete2 as HTMLButtonElement).disabled).toBe(false)

    // Restore the shared defaults for later tests.
    apiOverrides.listAgentCatalog = async () => []
    apiOverrides.getAgentRoleBindings = async () => ({})
  })
})
