import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  records: [] as any[],
  listeners: [] as Array<(event: unknown) => void>,
  floorListeners: [] as Array<(profileId: string, chatId: string, event: unknown) => void>,
  cancel: vi.fn((invocationId: string) => ({ invocationId, cancelled: true })),
  runtimeCancel: vi.fn(() => true),
  runtimeCancelPlan: vi.fn(() => true),
  runtimeRun: vi.fn(),
  runtimeRunPlan: vi.fn(),
  toolRegister: vi.fn(),
  toolComplete: vi.fn(),
  toolUnregisterSender: vi.fn(),
  sent: [] as Array<{ channel: string; event: unknown }>,
  profilesByChat: new Map<string, string>(),
  chats: new Map<string, { character_id: string }>(),
  floors: new Map<string, Array<{ floor: number }>>()
}))

vi.mock('../../src/main/services/agentRuntime/runs/AgentRunStore', () => ({
  agentRunStore: {
    list: () => hoisted.records,
    get: (_chatId: string, invocationId: string) =>
      hoisted.records.find((record) => record.invocationId === invocationId) ?? null,
    cancel: hoisted.cancel,
    subscribe: (listener: (event: unknown) => void) => {
      hoisted.listeners.push(listener)
      return () => undefined
    }
  }
}))

vi.mock('../../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: () => ({
    run: hoisted.runtimeRun,
    runPlan: hoisted.runtimeRunPlan,
    cancelInvocation: hoisted.runtimeCancel,
    cancelPlan: hoisted.runtimeCancelPlan
  }),
  liveCardToolRegistry: () => ({
    register: hoisted.toolRegister,
    complete: hoisted.toolComplete,
    unregisterSender: hoisted.toolUnregisterSender
  })
}))

vi.mock('../../src/main/services/sessionDbService', () => ({
  resolveProfileId: (chatId: string) => hoisted.profilesByChat.get(chatId) ?? null
}))

vi.mock('../../src/main/services/chatService', () => ({
  getChat: (_profileId: string, chatId: string) => hoisted.chats.get(chatId) ?? null
}))

vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: (_profileId: string, chatId: string) => hoisted.floors.get(chatId) ?? []
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, event: unknown) => hoisted.sent.push({ channel, event })
        }
      }
    ]
  }
}))

import type { IpcMainInvokeEvent } from 'electron'
import { registerAgentRunIpc } from '../../src/main/ipc/agentRunIpc'
import { IpcSenderRejectedError, setGuardMainWindow } from '../../src/main/ipc/ipcGuards'
import { CARD_AGENT_CHANNELS } from '../../src/shared/agentRuntime'

describe('Agent Run IPC', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const eventHandlers = new Map<string, (...args: any[]) => unknown>()
  const mainFrame = { url: 'app://top' }
  const mainWc = {
    id: 1,
    mainFrame,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn()
  } as unknown as IpcMainInvokeEvent['sender']
  const topEvent = { sender: mainWc, senderFrame: mainFrame }
  const cardEvent = { sender: mainWc, senderFrame: { url: 'about:srcdoc' } }
  const wcvFrame = { url: 'rpt-card://card' }
  const wcvEvent = { sender: { mainFrame: wcvFrame }, senderFrame: wcvFrame }

  beforeEach(() => {
    handlers.clear()
    eventHandlers.clear()
    hoisted.records = [
      { invocationId: 'one', profileId: 'p1', chatId: 'c1' },
      { invocationId: 'other-chat', profileId: 'p1', chatId: 'c2' },
      { invocationId: 'other-profile', profileId: 'p2', chatId: 'c3' }
    ]
    hoisted.profilesByChat = new Map([
      ['c1', 'p1'],
      ['c2', 'p1'],
      ['c3', 'p2']
    ])
    hoisted.chats = new Map([['c1', { character_id: 'card-1' }]])
    hoisted.cancel.mockClear()
    hoisted.runtimeCancel.mockClear()
    hoisted.sent.length = 0
    setGuardMainWindow({ webContents: mainWc, on: () => undefined } as never)
    registerAgentRunIpc({
      handle: (channel: string, handler: (...args: any[]) => unknown) =>
        void handlers.set(channel, handler),
      on: (channel: string, handler: (...args: any[]) => unknown) =>
        void eventHandlers.set(channel, handler)
    } as never)
  })

  it('allows the trusted app top frame to read and cancel within an authoritative chat scope', () => {
    expect(
      handlers.get('agent-runs-list')?.(topEvent, { profileId: 'p1', chatId: 'c1' })
    ).toEqual([hoisted.records[0]])
    expect(
      handlers.get('agent-run-get')?.(topEvent, {
        profileId: 'p1',
        chatId: 'c1',
        invocationId: 'one'
      })
    ).toBe(hoisted.records[0])
    expect(
      handlers.get('agent-run-cancel')?.(topEvent, {
        profileId: 'p1',
        chatId: 'c1',
        invocationId: 'one'
      })
    ).toEqual({
      invocationId: 'one',
      cancelled: true
    })
    expect(hoisted.runtimeCancel).toHaveBeenCalledWith('one')
  })

  it.each([
    ['card subframe', cardEvent],
    ['WCV sender', wcvEvent]
  ])('denies Agent Run records and cancellation to a %s', async (_, event) => {
    for (const [channel, request] of [
      ['agent-runs-list', { profileId: 'p1', chatId: 'c1' }],
      ['agent-run-get', { profileId: 'p1', chatId: 'c1', invocationId: 'one' }],
      ['agent-run-cancel', { profileId: 'p1', chatId: 'c1', invocationId: 'one' }]
    ] as const) {
      const output = handlers.get(channel)?.(event, request)
      await expect(output as Promise<unknown>).rejects.toBeInstanceOf(IpcSenderRejectedError)
    }
    expect(hoisted.runtimeCancel).not.toHaveBeenCalled()
  })

  it('rejects spoofed profile and unknown chat scopes without returning records', async () => {
    for (const request of [
      { profileId: 'p2', chatId: 'c1' },
      { profileId: 'p1', chatId: 'missing' }
    ]) {
      const output = handlers.get('agent-runs-list')?.(topEvent, request)
      await expect(output as Promise<unknown>).rejects.toMatchObject({
        code: 'AGENT_RUN_SCOPE_REJECTED'
      })
    }
  })

  it('does not get or cancel an invocation outside the authoritative chat scope', () => {
    expect(
      handlers.get('agent-run-get')?.(topEvent, {
        profileId: 'p1',
        chatId: 'c1',
        invocationId: 'other-chat'
      })
    ).toBeNull()
    expect(
      handlers.get('agent-run-cancel')?.(topEvent, {
        profileId: 'p1',
        chatId: 'c1',
        invocationId: 'other-chat'
      })
    ).toEqual({ invocationId: 'other-chat', cancelled: false })
    expect(hoisted.runtimeCancel).not.toHaveBeenCalled()
  })

  it('broadcasts typed activity independently of notification policy', () => {
    const event = {
      type: 'started',
      run: {
        invocationId: 'one',
        chatId: 'c1',
        floor: 1,
        agentName: 'quiet.agent',
        status: 'running',
        startedAt: 'now',
        notification: 'none'
      }
    }
    hoisted.listeners[0](event)
    expect(hoisted.sent).toContainEqual({ channel: 'agent-run-event', event })
  })

  it('rejects a sibling inline card spoof while preserving the registered host completion', async () => {
    const scope = { profileId: 'p1', chatId: 'c1', characterId: 'card-1' }
    const registration = await handlers.get(CARD_AGENT_CHANNELS.registerTool)?.(topEvent, {
      ...scope,
      binding: {
        name: 'advance',
        inputSchema: { type: 'object' },
        transactionMode: 'transactional',
        parallelSafe: false
      }
    })
    const completionCapability = (registration as { completionCapability?: unknown })
      .completionCapability
    expect(completionCapability).toEqual(expect.any(String))

    eventHandlers.get(CARD_AGENT_CHANNELS.toolResult)?.(topEvent, {
      ...scope,
      requestId: 'request-1',
      completionCapability: 'sibling-card-spoof',
      result: { advanced: false }
    })
    expect(hoisted.toolComplete).not.toHaveBeenCalled()

    eventHandlers.get(CARD_AGENT_CHANNELS.toolResult)?.(topEvent, {
      ...scope,
      requestId: 'request-1',
      completionCapability,
      result: { advanced: true }
    })
    expect(hoisted.toolComplete).toHaveBeenCalledWith({
      ...scope,
      requestId: 'request-1',
      completionCapability,
      result: { advanced: true },
      senderId: 1,
      scope
    })
  })
})
