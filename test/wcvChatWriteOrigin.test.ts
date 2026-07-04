import { describe, it, expect, vi, beforeEach } from 'vitest'

// Contract: card-initiated chat mutations (setChatMessages / deleteChatMessages / saveChat) echo their
// re-folded vars to siblings/host with the WRITER EXCLUDED and origin 'card-write' — so the writing
// card's own MVU variable events don't re-fire and loop (the setChatMessages twin of the WS-3 fix).
// See src/main/ipc/wcvIpc.ts pushVars / afterChatMutation.

vi.mock('../src/main/services/wcvManager', () => ({
  contextFor: vi.fn(),
  pushHostVars: vi.fn(),
  notifyVarsChanged: vi.fn(),
  pushHostReload: vi.fn()
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
import * as chatWriteService from '../src/main/services/chatWriteService'
import { registerWcvIpc } from '../src/main/ipc/wcvIpc'

const handlers = new Map<string, (...args: any[]) => any>()
const ipcMain = {
  on: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn),
  handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn)
} as any

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerWcvIpc(ipcMain)
  vi.mocked(wcvManager.contextFor).mockReturnValue({
    profileId: 'p',
    chatId: 'c',
    characterId: 'ch',
    slotId: 's'
  } as any)
  vi.mocked(chatWriteService.setChatMessages).mockReturnValue(1)
  vi.mocked(chatWriteService.deleteChatMessages).mockReturnValue(true)
  vi.mocked(chatWriteService.saveChat).mockReturnValue(true)
  vi.mocked(chatWriteService.afterChatMutation).mockReturnValue({
    variables: { stat_data: { hp: 1 } }
  } as any)
})

const evt = { sender: { id: 7 } }

describe('wcvIpc card-write origin + writer exclusion', () => {
  it('wcv-host-set-chat-messages echoes card-write, writer excluded', () => {
    handlers.get('wcv-host-set-chat-messages')!(evt, [{ message_id: 0, message: 'x' }])
    expect(wcvManager.notifyVarsChanged).toHaveBeenCalledWith('c', { hp: 1 }, 7, 'card-write')
    expect(wcvManager.pushHostVars).toHaveBeenCalled()
  })

  it('wcv-host-delete-chat-messages echoes card-write, writer excluded', () => {
    handlers.get('wcv-host-delete-chat-messages')!(evt, [0])
    expect(wcvManager.notifyVarsChanged).toHaveBeenCalledWith('c', { hp: 1 }, 7, 'card-write')
    expect(wcvManager.pushHostVars).toHaveBeenCalled()
  })

  it('wcv-host-save-chat echoes card-write, writer excluded', () => {
    handlers.get('wcv-host-save-chat')!(evt, [{ is_user: false, mes: 'x' }])
    expect(wcvManager.notifyVarsChanged).toHaveBeenCalledWith('c', { hp: 1 }, 7, 'card-write')
    expect(wcvManager.pushHostVars).toHaveBeenCalled()
  })
})
