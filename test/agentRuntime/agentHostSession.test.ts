import { describe, expect, it, vi } from 'vitest'

import { AgentHostSession } from '../../src/main/services/agentRuntime/AgentHostSession'
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

const session = (cancelInvocationsOnClose: boolean) => {
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
    cancelInvocationsOnClose
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
