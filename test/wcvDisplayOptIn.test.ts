import { describe, it, expect, vi, beforeEach } from 'vitest'

// Contract: the main-side DisplayHost opt-in lifecycle in registerWcvIpc (ADR 0023). A WCV panel opts
// itself into transformed streaming frames via the `setDisplayStreamEnabled` Host channel; main tracks the
// opt-in per sender and relays the SET of watched chats to the renderer. A slot teardown drops the opt-in
// and re-relays; a renderer reload (`display-broker-ready`) re-relays the set AND re-seeds the revision.
// See src/main/ipc/wcvIpc.ts "DisplayHost render broker".

const h = vi.hoisted(() => ({
  sendToMain: vi.fn(),
  contextFor: vi.fn(),
  chatScopeFor: vi.fn(() => null),
  // registerWcvIpc registers a slot-destroy listener; capture its callback so a test can fire it.
  slotDestroyedCb: undefined as ((webContentsId: number) => void) | undefined
}))

vi.mock('../src/main/services/wcvManager', () => ({
  contextFor: h.contextFor,
  pushHostVars: vi.fn(),
  notifyVarsChanged: vi.fn(),
  pushHostReload: vi.fn(),
  sendToMain: h.sendToMain,
  chatScopeFor: h.chatScopeFor,
  onSlotDestroyed: (cb: (webContentsId: number) => void) => {
    h.slotDestroyedCb = cb
    return () => {}
  }
}))
vi.mock('../src/main/services/duelPreviewService', () => ({ computeDuelPreview: vi.fn() }))
vi.mock('../src/main/services/chatCardVarsService', () => ({
  getChatCardVars: vi.fn(),
  setChatCardVars: vi.fn()
}))
vi.mock('../src/main/services/floorService', () => ({
  getAllFloors: vi.fn(() => []),
  saveFloor: vi.fn()
}))
vi.mock('../src/main/services/generationService', () => ({
  applyVariableOps: vi.fn(),
  reevaluateVariables: vi.fn(),
  generateRaw: vi.fn()
}))
vi.mock('../src/main/services/lorebookService', () => ({}))
vi.mock('../src/main/services/chatService', () => ({
  getChat: vi.fn(),
  truncateFloors: vi.fn(),
  getChatLorebookIds: vi.fn()
}))
vi.mock('../src/main/services/chatWriteService', () => ({
  setChatMessages: vi.fn(),
  deleteChatMessages: vi.fn(),
  saveChat: vi.fn(),
  afterChatMutation: vi.fn()
}))
vi.mock('../src/main/services/scriptApiService', () => ({}))
vi.mock('../src/main/services/regexService', () => ({}))
vi.mock('../src/main/services/pluginStorageService', () => ({}))
vi.mock('../src/main/services/pluginService', () => ({ getVars: vi.fn(), pluginVars: vi.fn() }))
vi.mock('../src/main/services/settingsService', () => ({}))
vi.mock('../src/main/services/worldAssetService', () => ({ assetUrlForWorld: vi.fn() }))
vi.mock('../src/main/services/presetService', () => ({ getActivePresetId: vi.fn() }))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import * as wcvManager from '../src/main/services/wcvManager'
import { registerWcvIpc } from '../src/main/ipc/wcvIpc'
import { WCV_CHANNEL_SPEC } from '../src/shared/thRuntime/wcvChannelSpec'

const STREAM_ENABLED_CHANNEL = WCV_CHANNEL_SPEC.setDisplayStreamEnabled.channel

const handlers = new Map<string, (...args: any[]) => any>()
const ipcMain = {
  on: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn),
  handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn)
} as any

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  h.slotDestroyedCb = undefined
  registerWcvIpc(ipcMain)
})

describe('DisplayHost opt-in lifecycle (main side)', () => {
  it('relays the enabled-chat set when a panel opts in', () => {
    h.contextFor.mockReturnValue({ profileId: 'p', chatId: 'c1', characterId: 'ch', slotId: 's' })
    handlers.get(STREAM_ENABLED_CHANNEL)!({ sender: { id: 7 } }, true)
    expect(wcvManager.sendToMain).toHaveBeenCalledWith('display-stream-enabled-chats', ['c1'])
  })

  it('re-relays an empty set when the opted-in slot is destroyed', () => {
    h.contextFor.mockReturnValue({ profileId: 'p', chatId: 'c1', characterId: 'ch', slotId: 's' })
    handlers.get(STREAM_ENABLED_CHANNEL)!({ sender: { id: 7 } }, true)
    h.sendToMain.mockClear()
    // The teardown callback registered via wcvManager.onSlotDestroyed drops sender 7's opt-in.
    h.slotDestroyedCb!(7)
    expect(wcvManager.sendToMain).toHaveBeenCalledWith('display-stream-enabled-chats', [])
  })

  it('re-relays the enabled set AND re-seeds the cached revision on broker-ready', () => {
    // Prime state: one watched chat + a pushed revision the reloaded renderer must resume from.
    h.contextFor.mockReturnValue({ profileId: 'p', chatId: 'c1', characterId: 'ch', slotId: 's' })
    handlers.get(STREAM_ENABLED_CHANNEL)!({ sender: { id: 7 } }, true)
    handlers.get('display-revision-changed')!({}, 5)
    h.sendToMain.mockClear()

    handlers.get('display-broker-ready')!({})
    expect(wcvManager.sendToMain).toHaveBeenCalledWith('display-stream-enabled-chats', ['c1'])
    expect(wcvManager.sendToMain).toHaveBeenCalledWith('display-revision-seed', 5)
  })
})
