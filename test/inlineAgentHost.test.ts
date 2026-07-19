import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cardAgentTransportFixture as fixture } from './fixtures/cardAgentTransport'

const h = vi.hoisted(() => ({
  loadLibrary: vi.fn(),
  loadSession: vi.fn(),
  run: vi.fn(),
  runPlan: vi.fn(),
  cancel: vi.fn(),
  registerTool: vi.fn(async () => ({ completionCapability: 'cap-1' })),
  unregisterTool: vi.fn(async () => true),
  toolResult: vi.fn(),
  toolRequest: undefined as undefined | ((request: any) => void),
  toolAbort: undefined as undefined | ((request: { requestId: string }) => void),
  floorCommit: undefined as undefined | ((payload: any) => void)
}))

vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ floors: [], chats: [] }), subscribe: () => () => undefined }
}))
vi.mock('../src/renderer/src/stores/characterStore', () => ({
  useCharacterStore: { getState: () => ({ activeCharacter: null }) }
}))
vi.mock('../src/renderer/src/stores/presetStore', () => ({
  usePresetStore: { getState: () => ({ preset: null, presets: [], activeId: null, load: vi.fn() }) }
}))
vi.mock('../src/renderer/src/stores/regexStore', () => ({
  useRegexStore: { getState: () => ({ rules: [], apply: (text: string) => text }) }
}))
vi.mock('../src/renderer/src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { persona: {} } }) }
}))
vi.mock('../src/renderer/src/stores/composerStore', () => ({
  useComposerStore: { getState: () => ({}) }
}))
vi.mock('../src/renderer/src/stores/lorebookStore', () => ({
  useLorebookStore: {
    getState: () => ({
      library: [],
      sessionIds: [],
      loadLibrary: h.loadLibrary,
      loadSession: h.loadSession
    })
  }
}))
vi.mock('../src/renderer/src/cardBridge/cardHostEvents', () => ({
  onCardHostEvent: vi.fn(() => () => undefined)
}))
vi.mock('../src/renderer/src/cardBridge/playTheme', () => ({
  applyRuntimeTheme: vi.fn(),
  getEffectivePlayTheme: vi.fn()
}))

import { createInlineHost } from '../src/renderer/src/cardBridge/host'
import { createThRuntime } from '../src/shared/thRuntime'

const ctx = { profileId: 'profile', chatId: 'chat', characterId: 'card' }

beforeEach(() => {
  vi.clearAllMocks()
  h.run.mockResolvedValue({
    invocationId: 'inv-1',
    status: 'succeeded',
    sourceRestarts: 0,
    required: true
  })
  h.runPlan.mockResolvedValue({ planId: 'plan-1', status: 'succeeded', outcomes: [] })
  h.toolRequest = undefined
  h.toolAbort = undefined
  h.floorCommit = undefined
  vi.stubGlobal('window', {
    api: {
      cardAgentRun: h.run,
      cardAgentRunPlan: h.runPlan,
      cardAgentCancel: h.cancel,
      cardAgentRegisterTool: h.registerTool,
      cardAgentUnregisterTool: h.unregisterTool,
      cardAgentToolResult: h.toolResult,
      onCardAgentToolRequest: (cb: typeof h.toolRequest) => {
        h.toolRequest = cb
        return () => {
          h.toolRequest = undefined
        }
      },
      onCardAgentToolAbort: (cb: typeof h.toolAbort) => {
        h.toolAbort = cb
        return () => {
          h.toolAbort = undefined
        }
      },
      onCardFloorCommitted: (cb: typeof h.floorCommit) => {
        h.floorCommit = cb
        return () => {
          h.floorCommit = undefined
        }
      }
    }
  })
})

describe('inline Card AgentHost transport', () => {
  it('executes the shared direct-JSON run and plan fixture under the bound scope', async () => {
    const agents = (createThRuntime(createInlineHost(ctx)) as any).rpt.agents
    await agents.run(fixture.name, { input: fixture.input, floor: fixture.floor })
    await agents.runPlan(fixture.plan)

    expect(h.run).toHaveBeenCalledWith({
      ...ctx,
      requestId: expect.any(String),
      name: fixture.name,
      options: { input: fixture.input, floor: fixture.floor }
    })
    expect(h.runPlan).toHaveBeenCalledWith({
      ...ctx,
      requestId: expect.any(String),
      plan: fixture.plan
    })
    expect(typeof h.run.mock.calls[0][0].options.input).toBe('object')
  })

  it('routes scoped tools and floor commits, then cleans up registration', async () => {
    const agents = (createThRuntime(createInlineHost(ctx)) as any).rpt.agents
    const handler = vi.fn(async () => ({ result: { advanced: true } }))
    const disposeTool = agents.registerTool(fixture.tool, handler)
    expect(h.registerTool).toHaveBeenCalledWith({ ...ctx, binding: fixture.tool })
    await Promise.resolve()

    h.toolRequest?.({
      ...ctx,
      scope: ctx,
      requestId: 'req-1',
      name: fixture.tool.name,
      input: { days: 1 }
    })
    await vi.waitFor(() =>
      expect(h.toolResult).toHaveBeenCalledWith({
        ...ctx,
        completionCapability: 'cap-1',
        requestId: 'req-1',
        result: { advanced: true }
      })
    )

    const onFloor = vi.fn()
    const disposeFloor = agents.onFloorCommitted(onFloor)
    h.floorCommit?.({ profileId: ctx.profileId, chatId: ctx.chatId, event: fixture.commit })
    expect(onFloor).toHaveBeenCalledWith(fixture.commit)

    disposeFloor()
    disposeTool()
    await vi.waitFor(() =>
      expect(h.unregisterTool).toHaveBeenCalledWith({ ...ctx, name: fixture.tool.name })
    )
  })
  it('waits for tool registration acknowledgement before an immediate run preflight', async () => {
    let acknowledge!: () => void
    h.registerTool.mockImplementationOnce(
      () =>
        new Promise<{ completionCapability: string }>((resolve) => {
          acknowledge = () => resolve({ completionCapability: 'cap-1' })
        })
    )
    const agents = (createThRuntime(createInlineHost(ctx)) as any).rpt.agents
    agents.registerTool(fixture.tool, vi.fn())

    const running = agents.run(fixture.name, { floor: fixture.floor })
    await Promise.resolve()
    expect(h.run).not.toHaveBeenCalled()
    acknowledge()
    await running
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('runtime teardown unregisters every tool and floor subscription', async () => {
    const runtime = createThRuntime(createInlineHost(ctx)) as any
    runtime.rpt.agents.registerTool(fixture.tool, vi.fn())
    runtime.rpt.agents.onFloorCommitted(vi.fn())
    await Promise.resolve()

    runtime.__rptDispose()
    await vi.waitFor(() =>
      expect(h.unregisterTool).toHaveBeenCalledWith({
        ...ctx,
        name: fixture.tool.name
      })
    )
    expect(h.floorCommit).toBeUndefined()
    expect(h.toolRequest).toBeUndefined()
    expect(h.toolAbort).toBeUndefined()
  })
})
