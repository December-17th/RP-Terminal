import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  runtimeRun: vi.fn(),
  profilesByChat: new Map<string, string>(),
  floors: new Map<string, Array<{ floor: number }>>(),
  invocationConfig: {} as { apiPresetId?: string }
}))

vi.mock('../../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    get() {
      return { invocationConfig: hoisted.invocationConfig }
    }
  },
  syncAgentFolder: vi.fn(),
  resolveAgentFolder: vi.fn()
}))

vi.mock('../../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: () => ({ run: hoisted.runtimeRun })
}))

vi.mock('../../src/main/services/agentRuntime/memoryMaintenanceSlot', () => ({
  MEMORY_MAINTENANCE_AGENT_NAME: 'Memory Maintenance',
  memoryMaintenanceBridge: () => ({ planDispatch: () => ({}) })
}))

vi.mock('../../src/main/services/sessionDbService', () => ({
  resolveProfileId: (chatId: string) => hoisted.profilesByChat.get(chatId) ?? null
}))

vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: (_profileId: string, chatId: string) => hoisted.floors.get(chatId) ?? []
}))

import type { IpcMainInvokeEvent } from 'electron'
import { registerAgentCatalogIpc } from '../../src/main/ipc/agentCatalogIpc'
import { setGuardMainWindow } from '../../src/main/ipc/ipcGuards'
import { AGENT_CATALOG_CHANNELS } from '../../src/shared/agentRuntime'

describe('Agent Catalog IPC manual run', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const mainFrame = { url: 'app://top' }
  const mainWc = { mainFrame } as unknown as IpcMainInvokeEvent['sender']
  const topEvent = { sender: mainWc, senderFrame: mainFrame }

  beforeEach(() => {
    handlers.clear()
    hoisted.profilesByChat = new Map([['c1', 'p1']])
    hoisted.floors = new Map([['c1', [{ floor: 4 }]]])
    hoisted.invocationConfig = { apiPresetId: 'preset-maintenance' }
    hoisted.runtimeRun.mockReset()
    hoisted.runtimeRun.mockResolvedValue({
      invocationId: 'run-1',
      status: 'succeeded',
      result: 'ok'
    })
    setGuardMainWindow({ webContents: mainWc, on: () => undefined } as never)
    registerAgentCatalogIpc({
      handle: (channel: string, handler: (...args: any[]) => unknown) =>
        void handlers.set(channel, handler)
    } as never)
  })

  it('passes the Agent profile-local API preset to a manual Memory Maintenance run', async () => {
    await handlers.get(AGENT_CATALOG_CHANNELS.run)?.(
      topEvent,
      'p1',
      'c1',
      'Memory Maintenance',
      { requestedBy: 'workspace' }
    )

    expect(hoisted.runtimeRun).toHaveBeenCalledWith({
      profileId: 'p1',
      chatId: 'c1',
      floor: 4,
      agent: 'Memory Maintenance',
      options: {
        input: { requestedBy: 'workspace' },
        apiPresetId: 'preset-maintenance'
      }
    })
  })
})
