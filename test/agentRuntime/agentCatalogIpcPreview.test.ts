import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  preview: vi.fn(),
  profilesByChat: new Map<string, string>(),
  floors: new Map<string, Array<{ floor: number }>>(),
  catalogAgent: null as null | { invocationConfig: { apiPresetId?: string } }
}))

vi.mock('../../src/main/services/agentRuntime/catalog', () => ({
  AgentCatalog: class {
    get() {
      return hoisted.catalogAgent
    }
  },
  syncAgentFolder: vi.fn(),
  resolveAgentFolder: vi.fn()
}))

vi.mock('../../src/main/services/agentRuntime/InvocationRuntimeService', () => ({
  invocationRuntime: () => ({ run: vi.fn() })
}))

vi.mock('../../src/main/services/agentRuntime/preview/promptPreview', () => ({
  agentPromptPreview: () => hoisted.preview
}))

vi.mock('../../src/main/services/agentRuntime/memoryMaintenanceSlot', () => ({
  MEMORY_MAINTENANCE_AGENT_NAME: 'Memory Maintenance',
  memoryMaintenanceBridge: () => ({ planDispatch: () => ({}) })
}))

vi.mock('../../src/main/services/sessionDbService', () => ({
  resolveProfileId: (chatId: string) => hoisted.profilesByChat.get(chatId) ?? null
}))

vi.mock('../../src/main/services/floorService', () => ({
  getAllFloors: (_profileId: string, chatId: string) => hoisted.floors.get(chatId) ?? [],
  getLatestFloor: (_profileId: string, chatId: string) =>
    (hoisted.floors.get(chatId) ?? []).at(-1) ?? null
}))

import type { IpcMainInvokeEvent } from 'electron'
import { registerAgentCatalogIpc } from '../../src/main/ipc/agentCatalogIpc'
import { setGuardMainWindow } from '../../src/main/ipc/ipcGuards'
import { AGENT_CATALOG_CHANNELS } from '../../src/shared/agentRuntime'

describe('Agent Catalog IPC prompt preview', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const mainFrame = { url: 'app://top' }
  const mainWc = { mainFrame } as unknown as IpcMainInvokeEvent['sender']
  const topEvent = { sender: mainWc, senderFrame: mainFrame }

  beforeEach(() => {
    handlers.clear()
    hoisted.profilesByChat = new Map([['c1', 'p1']])
    hoisted.floors = new Map([['c1', [{ floor: 4 }]]])
    hoisted.catalogAgent = { invocationConfig: { apiPresetId: 'preset-x' } }
    hoisted.preview.mockReset()
    hoisted.preview.mockResolvedValue({
      ok: true,
      messages: [],
      prefixCount: 0,
      attribution: {},
      warnings: []
    })
    setGuardMainWindow({ webContents: mainWc, on: () => undefined } as never)
    registerAgentCatalogIpc({
      handle: (channel: string, handler: (...args: any[]) => unknown) =>
        void handlers.set(channel, handler)
    } as never)
  })

  const invoke = (agent: string, input?: unknown) =>
    handlers.get(AGENT_CATALOG_CHANNELS.previewPrompt)?.(topEvent, 'p1', 'c1', agent, input)

  it('builds the preview against the latest floor with the profile-local preset', async () => {
    await invoke('Some Agent', { requestedBy: 'workspace' })
    expect(hoisted.preview).toHaveBeenCalledWith({
      profileId: 'p1',
      chatId: 'c1',
      floor: 4,
      agent: hoisted.catalogAgent,
      input: { requestedBy: 'workspace' },
      apiPresetId: 'preset-x'
    })
  })

  it('returns NO_COMMITTED_FLOOR when the chat has no floor', async () => {
    hoisted.floors = new Map()
    expect(await invoke('Some Agent')).toEqual({ ok: false, code: 'NO_COMMITTED_FLOOR' })
    expect(hoisted.preview).not.toHaveBeenCalled()
  })

  it('returns AGENT_NOT_FOUND for an unknown Agent', async () => {
    hoisted.catalogAgent = null
    expect(await invoke('Ghost')).toEqual({ ok: false, code: 'AGENT_NOT_FOUND' })
    expect(hoisted.preview).not.toHaveBeenCalled()
  })

  it('rejects a profile/chat mismatch', async () => {
    hoisted.profilesByChat = new Map([['c1', 'other']])
    expect(await invoke('Some Agent')).toEqual({ ok: false, code: 'INVALID_REQUEST' })
  })
})
