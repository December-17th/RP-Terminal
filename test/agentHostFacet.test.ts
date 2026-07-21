import { describe, expect, it, vi } from 'vitest'

import {
  createAgentHostFacet,
  type AgentFloorPort,
  type AgentInvocationPort,
  type AgentToolPort,
  type AgentToolRequest
} from '../src/shared/thRuntime/agentHostFacet'
import { cardAgentTransportFixture as fixture } from './fixtures/cardAgentTransport'

const outcome = {
  invocationId: 'inv-1',
  status: 'succeeded' as const,
  sourceRestarts: 0,
  required: true
}

const ports = () => {
  let toolRequest: ((request: AgentToolRequest) => void) | undefined
  let toolAbort: ((requestId: string) => void) | undefined
  let floorCommit: Parameters<AgentFloorPort['subscribe']>[0] | undefined
  const invocation: AgentInvocationPort = {
    run: vi.fn(async () => outcome),
    runPlan: vi.fn(async () => ({ planId: 'plan-1', status: 'succeeded', outcomes: [] })),
    cancel: vi.fn()
  }
  const tools: AgentToolPort<string> = {
    register: vi.fn(async () => 'lease-1'),
    unregister: vi.fn(),
    complete: vi.fn(),
    onRequest: vi.fn((handler) => {
      toolRequest = handler
      return () => {
        toolRequest = undefined
      }
    }),
    onAbort: vi.fn((handler) => {
      toolAbort = handler
      return () => {
        toolAbort = undefined
      }
    })
  }
  const floors: AgentFloorPort = {
    subscribe: vi.fn((handler) => {
      floorCommit = handler
      return () => {
        floorCommit = undefined
      }
    })
  }
  return {
    invocation,
    tools,
    floors,
    toolRequest: () => toolRequest,
    toolAbort: () => toolAbort,
    floorCommit: () => floorCommit
  }
}

describe('Agent Host Facet', () => {
  it('correlates invocation cancellation and keeps AbortSignal out of transport commands', async () => {
    const p = ports()
    let finish!: (value: typeof outcome) => void
    vi.mocked(p.invocation.run).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const host = createAgentHostFacet(p)
    const controller = new AbortController()

    const running = host.runAgent(fixture.name, {
      input: fixture.input,
      floor: fixture.floor,
      signal: controller.signal
    })
    const command = vi.mocked(p.invocation.run).mock.calls[0][0]
    expect(command).toEqual({
      kind: 'run',
      requestId: expect.any(String),
      name: fixture.name,
      options: { input: fixture.input, floor: fixture.floor }
    })

    controller.abort()
    expect(p.invocation.cancel).toHaveBeenCalledWith(command.requestId)
    finish(outcome)
    await expect(running).resolves.toEqual(outcome)
  })

  it('waits for tool readiness and owns correlated handler cancellation', async () => {
    const p = ports()
    let ready!: (lease: string) => void
    vi.mocked(p.tools.register).mockImplementationOnce(
      () => new Promise((resolve) => (ready = resolve))
    )
    const host = createAgentHostFacet(p)
    const handler = vi.fn(async (_input, context) => {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true })
      )
      throw new Error('aborted')
    })
    const dispose = host.registerAgentTool(fixture.tool, handler)

    const running = host.runAgent(fixture.name)
    expect(p.invocation.run).not.toHaveBeenCalled()
    ready('lease-1')
    await running

    p.toolRequest()?.({
      requestId: 'tool-1',
      name: fixture.tool.name,
      input: { days: 1 }
    })
    await Promise.resolve()
    p.toolAbort()?.('tool-1')
    await Promise.resolve()
    expect(p.tools.complete).not.toHaveBeenCalled()

    dispose()
    await vi.waitFor(() =>
      expect(p.tools.unregister).toHaveBeenCalledWith(fixture.tool.name, 'lease-1')
    )
    expect(p.toolRequest()).toBeUndefined()
    expect(p.toolAbort()).toBeUndefined()
  })

  it('surfaces a tool registration failure on the next runAgent (the double-mount poison the registry now avoids)', async () => {
    const p = ports()
    const duplicate = Object.assign(new Error('duplicate'), { code: 'CARD_TOOL_DUPLICATE' })
    vi.mocked(p.tools.register).mockRejectedValueOnce(duplicate)
    const host = createAgentHostFacet(p)
    host.registerAgentTool(fixture.tool, vi.fn())
    // A rejected registration parks the error and every subsequent runAgent rethrows it — this is exactly
    // the double-mount poisoning that CardToolRegistry.register now sidesteps via last-registration-wins.
    await expect(host.runAgent(fixture.name)).rejects.toBe(duplicate)
    expect(p.invocation.run).not.toHaveBeenCalled()
  })

  it('shares one floor subscription across public handlers', () => {
    const p = ports()
    const host = createAgentHostFacet(p)
    const first = vi.fn()
    const second = vi.fn()

    const disposeFirst = host.onFloorCommitted(first)
    const disposeSecond = host.onFloorCommitted(second)
    p.floorCommit()?.(fixture.commit)

    expect(p.floors.subscribe).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith(fixture.commit)
    expect(second).toHaveBeenCalledWith(fixture.commit)
    disposeFirst()
    expect(p.floorCommit()).toBeDefined()
    disposeSecond()
    expect(p.floorCommit()).toBeUndefined()
  })
})
