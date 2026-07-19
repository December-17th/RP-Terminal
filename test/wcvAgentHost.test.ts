import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WCV_AGENT_CHANNELS } from '../src/shared/thRuntime/wcvChannelSpec'
import { cardAgentTransportFixture as fixture } from './fixtures/cardAgentTransport'

const h = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => void>()
  return {
    listeners,
    sendSync: vi.fn(() => ({})),
    invoke: vi.fn(async () => ({
      invocationId: 'inv-1',
      status: 'succeeded',
      sourceRestarts: 0,
      required: true
    })),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: (...args: any[]) => void) =>
      listeners.set(channel, listener)
    ),
    removeListener: vi.fn((channel: string) => listeners.delete(channel))
  }
})
vi.mock('electron', () => ({ ipcRenderer: h }))

import { createWcvHost } from '../src/preload/wcvHost'

const host = () =>
  createWcvHost({
    ctx: { profileId: '', chatId: '', characterId: '' },
    evalTemplate: () => '',
    evalTemplateError: () => null,
    prepareContext: () => ({})
  })

beforeEach(() => {
  h.listeners.clear()
  h.sendSync.mockClear()
  h.invoke.mockReset().mockResolvedValue({
    invocationId: 'inv-1',
    status: 'succeeded',
    sourceRestarts: 0,
    required: true
  })
  h.send.mockClear()
  h.on.mockClear()
  h.removeListener.mockClear()
})

describe('WCV AgentHost transport', () => {
  it('round-trips direct JSON input without caller-supplied scope and cancels by correlated request id', async () => {
    let finish!: (value: unknown) => void
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const pending = host().runAgent(fixture.name, {
      input: fixture.input,
      floor: fixture.floor,
      signal: controller.signal
    })
    const [, request] = h.invoke.mock.calls[0]
    expect(h.invoke.mock.calls[0][0]).toBe(WCV_AGENT_CHANNELS.run)
    expect(request).toEqual({
      requestId: expect.any(String),
      name: fixture.name,
      options: { input: fixture.input, floor: fixture.floor }
    })
    expect(request).not.toHaveProperty('profileId')
    controller.abort()
    expect(h.invoke).toHaveBeenCalledWith(WCV_AGENT_CHANNELS.cancel, request.requestId)
    finish({ invocationId: 'inv-1', status: 'cancelled', sourceRestarts: 0, required: true })
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('executes the shared declarative plan fixture without caller-supplied scope', async () => {
    await host().runAgentPlan(fixture.plan)
    expect(h.invoke).toHaveBeenCalledWith(WCV_AGENT_CHANNELS.runPlan, {
      requestId: expect.any(String),
      plan: fixture.plan
    })
  })
  it('registers a card tool, returns correlated results, and aborts the handler on main request', async () => {
    const handler = vi.fn(async (_input, context) => {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true })
      )
      throw new Error('aborted')
    })
    const dispose = host().registerAgentTool(
      {
        name: 'clock',
        inputSchema: { type: 'object' },
        transactionMode: 'transactional',
        parallelSafe: false
      },
      handler
    )
    expect(h.invoke).toHaveBeenCalledWith(WCV_AGENT_CHANNELS.registerTool, {
      name: 'clock',
      inputSchema: { type: 'object' },
      transactionMode: 'transactional',
      parallelSafe: false
    })
    h.listeners.get('wcv-agent-tool-request')?.(
      {},
      {
        requestId: 'req-1',
        sequence: 1,
        name: 'clock',
        input: { days: 1 },
        transactionMode: 'transactional'
      }
    )
    await Promise.resolve()
    h.listeners.get('wcv-agent-tool-abort')?.({}, { requestId: 'req-1' })
    await Promise.resolve()
    expect(h.send).not.toHaveBeenCalledWith(
      WCV_AGENT_CHANNELS.toolResult,
      expect.objectContaining({ requestId: 'req-1' })
    )
    dispose()
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenLastCalledWith(WCV_AGENT_CHANNELS.unregisterTool, 'clock')
    )
  })

  it('waits for tool registration acknowledgement before an immediate run preflight', async () => {
    let acknowledge!: () => void
    h.invoke.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acknowledge = () => resolve(true)
        })
    )
    const cardHost = host()
    cardHost.registerAgentTool(
      {
        name: 'clock',
        inputSchema: { type: 'object' },
        transactionMode: 'transactional',
        parallelSafe: false
      },
      vi.fn()
    )

    const running = cardHost.runAgent(fixture.name, { floor: fixture.floor })
    expect(h.invoke).toHaveBeenCalledTimes(1)
    acknowledge()
    await running
    expect(h.invoke).toHaveBeenLastCalledWith(WCV_AGENT_CHANNELS.run, expect.any(Object))
  })

  it('subscribes and disposes floor commit events', () => {
    const callback = vi.fn()
    const dispose = host().onFloorCommitted(callback)
    expect(h.invoke).toHaveBeenCalledWith(WCV_AGENT_CHANNELS.floorSubscribe)
    const event = fixture.commit
    h.listeners.get(WCV_AGENT_CHANNELS.floorCommitted)?.({}, event)
    expect(callback).toHaveBeenCalledWith(event)
    dispose()
    expect(h.invoke).toHaveBeenLastCalledWith(WCV_AGENT_CHANNELS.floorUnsubscribe)
  })
})
