import { describe, expect, it, vi } from 'vitest'

import { AgentHostSession } from '../../src/main/services/agentRuntime/AgentHostSession'
import { createCardToolRegistry } from '../../src/main/services/agentRuntime/tools/CardToolRegistry'
import { cardAgentTransportFixture as fixture } from '../fixtures/cardAgentTransport'

const invocation = () => {
  const run = Object.assign(new Promise(() => undefined), { invocationId: 'inv-1' })
  const plan = Object.assign(new Promise(() => undefined), { planId: 'plan-1' })
  return {
    run: vi.fn(() => run),
    runPlan: vi.fn(() => plan),
    cancelInvocation: vi.fn(() => true),
    cancelPlan: vi.fn(() => true)
  }
}

const toolRegistry = () => ({
  register: vi.fn(),
  resolve: vi.fn(),
  complete: vi.fn(() => true),
  unregister: vi.fn(() => true),
  unregisterSender: vi.fn(() => 1)
})

const session = (
  cancelInvocationsOnClose: boolean,
  resolveInvocationConfig?: (agentName: string) => { apiPresetId?: string } | undefined
) => {
  const runtime = invocation()
  const tools = toolRegistry()
  const host = new AgentHostSession({
    scope: { profileId: 'profile', chatId: 'chat', characterId: 'card' },
    senderId: 7,
    runtime: runtime as never,
    tools,
    latestFloor: () => fixture.floor,
    sendTool: vi.fn(),
    toolAuthority: 'completion-capability',
    cancelInvocationsOnClose,
    ...(resolveInvocationConfig ? { resolveInvocationConfig } : {})
  })
  return { host, runtime, tools }
}

describe('Agent Host Session', () => {
  it('owns request correlation while preserving transport-selected close cancellation', () => {
    const retained = session(false)
    void retained.host.run({ requestId: 'inline-run', name: fixture.name })
    retained.host.close()
    expect(retained.runtime.cancelInvocation).not.toHaveBeenCalled()

    const cancelled = session(true)
    void cancelled.host.run({ requestId: 'wcv-run', name: fixture.name })
    void cancelled.host.runPlan({ requestId: 'wcv-plan', plan: fixture.plan })
    cancelled.host.close()
    expect(cancelled.runtime.cancelInvocation).toHaveBeenCalledWith('inv-1')
    expect(cancelled.runtime.cancelPlan).toHaveBeenCalledWith('plan-1')
  })

  it('keeps completion capabilities inside the owning session', () => {
    const { host, tools } = session(false)
    const registration = host.registerTool(fixture.tool)
    expect(registration).toMatchObject({ completionCapability: expect.any(String) })

    expect(
      host.completeTool({
        requestId: 'tool-1',
        result: { ok: false },
        completionCapability: 'foreign'
      })
    ).toBe(false)
    expect(tools.complete).not.toHaveBeenCalled()

    const completionCapability = (registration as { completionCapability: string })
      .completionCapability
    expect(
      host.completeTool({
        requestId: 'tool-1',
        result: { ok: true },
        completionCapability
      })
    ).toBe(true)
    expect(tools.complete).toHaveBeenCalledWith({
      senderId: 7,
      scope: { profileId: 'profile', chatId: 'chat', characterId: 'card' },
      requestId: 'tool-1',
      result: { ok: true },
      completionCapability
    })
  })

  it('strips card-supplied apiPresetId/model and lets the user per-Agent binding win on run', () => {
    const { host, runtime } = session(false, (name) =>
      name === fixture.name ? { apiPresetId: 'user-preset' } : undefined
    )
    void host.run({
      requestId: 'r1',
      name: fixture.name,
      options: {
        input: fixture.input,
        maxRetryAttempts: 4,
        apiPresetId: 'card-preset',
        model: 'card-model'
      } as never
    })
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: fixture.name,
        floor: fixture.floor,
        options: { input: fixture.input, maxRetryAttempts: 4, apiPresetId: 'user-preset' }
      })
    )
  })

  it('strips card-supplied preset/model even when no user binding exists', () => {
    const { host, runtime } = session(false)
    void host.run({
      requestId: 'r2',
      name: fixture.name,
      options: { maxRetryAttempts: 2, apiPresetId: 'card-preset', model: 'card-model' } as never
    })
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({ options: { maxRetryAttempts: 2 } })
    )
    const passed = runtime.run.mock.calls[0][0].options
    expect(passed).not.toHaveProperty('apiPresetId')
    expect(passed).not.toHaveProperty('model')
  })

  it('sanitizes plan step calls: strips preset/model and applies the per-agent binding', () => {
    const { host, runtime } = session(false, (name) =>
      name === fixture.name ? { apiPresetId: 'user-preset' } : undefined
    )
    void host.runPlan({
      requestId: 'p1',
      plan: {
        floor: 12,
        steps: [
          { agent: fixture.name, input: { month: 7 }, apiPresetId: 'card-preset', model: 'card-model' },
          { parallel: [{ agent: 'other', apiPresetId: 'card-preset' }] }
        ]
      }
    })
    expect(runtime.runPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: {
          floor: 12,
          steps: [
            { agent: fixture.name, input: { month: 7 }, apiPresetId: 'user-preset' },
            { parallel: [{ agent: 'other' }] }
          ]
        }
      })
    )
  })

  it('lets two live mounts of the same card register the same tool and both keep running', () => {
    const registry = createCardToolRegistry()
    const boundScope = { profileId: 'profile', chatId: 'chat', characterId: 'card' }
    const mount = (senderId: number) => {
      const runtime = invocation()
      const host = new AgentHostSession({
        scope: boundScope,
        senderId,
        runtime: runtime as never,
        tools: registry,
        latestFloor: () => fixture.floor,
        sendTool: vi.fn(),
        toolAuthority: 'sender',
        cancelInvocationsOnClose: true
      })
      return { host, runtime }
    }
    const first = mount(11)
    const second = mount(22)
    expect(first.host.registerTool(fixture.tool)).toBe(true)
    // A second live mount (new sender, same card scope) takes over the identical tool without the
    // CARD_TOOL_DUPLICATE that used to poison every subsequent runAgent on the second facade.
    expect(() => second.host.registerTool(fixture.tool)).not.toThrow()
    void first.host.run({ requestId: 'a', name: fixture.name })
    void second.host.run({ requestId: 'b', name: fixture.name })
    expect(first.runtime.run).toHaveBeenCalledTimes(1)
    expect(second.runtime.run).toHaveBeenCalledTimes(1)
  })

  it('delivers floors only while subscribed and within the bound chat', () => {
    const { host } = session(false)
    const send = vi.fn()
    host.subscribeFloors(send)
    host.deliverFloor('profile', 'other-chat', fixture.commit)
    host.deliverFloor('profile', 'chat', fixture.commit)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(fixture.commit)
    host.unsubscribeFloors()
    host.deliverFloor('profile', 'chat', fixture.commit)
    expect(send).toHaveBeenCalledOnce()
  })
})
