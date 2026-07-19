import { beforeAll, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  exposed: {} as Record<string, any>,
  invocations: [] as Array<{ channel: string; args: unknown[] }>,
  listeners: new Map<string, (...args: any[]) => void>(),
  removed: [] as Array<{ channel: string; listener: (...args: any[]) => void }>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      hoisted.exposed[name] = value
    }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      hoisted.invocations.push({ channel, args })
      return Promise.resolve(undefined)
    },
    on: (channel: string, listener: (...args: any[]) => void) =>
      void hoisted.listeners.set(channel, listener),
    removeListener: (channel: string, listener: (...args: any[]) => void) =>
      void hoisted.removed.push({ channel, listener }),
    send: () => undefined,
    sendSync: () => undefined
  },
  webUtils: { getPathForFile: () => '' }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

beforeAll(async () => {
  Object.assign(process, { contextIsolated: true })
  await import('../../src/preload/index')
})

describe('Agent Run preload surface', () => {
  it('maps typed read/cancel calls to invocation-scoped IPC channels', async () => {
    await hoisted.exposed.api.listAgentRuns('p1', 'c1')
    await hoisted.exposed.api.getAgentRun('p1', 'c1', 'run-1')
    await hoisted.exposed.api.cancelAgentRun('p1', 'c1', 'run-1')
    expect(hoisted.invocations.slice(-3)).toEqual([
      { channel: 'agent-runs-list', args: [{ profileId: 'p1', chatId: 'c1' }] },
      {
        channel: 'agent-run-get',
        args: [{ profileId: 'p1', chatId: 'c1', invocationId: 'run-1' }]
      },
      {
        channel: 'agent-run-cancel',
        args: [{ profileId: 'p1', chatId: 'c1', invocationId: 'run-1' }]
      }
    ])
  })

  it('delivers activity events and unsubscribes the exact listener', () => {
    const received: unknown[] = []
    const unsubscribe = hoisted.exposed.api.onAgentRunEvent((event: unknown) =>
      received.push(event)
    )
    const listener = hoisted.listeners.get('agent-run-event')!
    const event = { type: 'started', run: { invocationId: 'run-1', notification: 'none' } }
    listener({}, event)
    expect(received).toEqual([event])
    unsubscribe()
    expect(hoisted.removed).toContainEqual({ channel: 'agent-run-event', listener })
  })
})
