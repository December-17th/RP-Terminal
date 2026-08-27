import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

const h = vi.hoisted(() => ({
  settings: {
    api: {
      provider: 'openai',
      endpoint: 'https://saved.example/v1',
      api_key: 'stored-secret',
      model: 'saved-model'
    },
    ui: { locale: 'en' }
  },
  getSettings: vi.fn(),
  listModels: vi.fn()
}))

vi.mock('../src/main/services/profileService', () => ({
  getProfiles: vi.fn(),
  createProfile: vi.fn(),
  wipeProfile: vi.fn()
}))
vi.mock('../src/main/services/settingsService', () => ({
  getSettings: h.getSettings,
  maskedSettings: vi.fn((settings) => settings),
  saveSettings: vi.fn()
}))
vi.mock('../src/main/services/apiService', () => ({ listModels: h.listModels }))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))
vi.mock('../src/main/appExit', () => ({ setExitDialogLocale: vi.fn() }))

import { registerProfileIpc } from '../src/main/ipc/profileIpc'
import { setGuardMainWindow } from '../src/main/ipc/ipcGuards'

const handlers = new Map<string, (...args: any[]) => any>()
const appUrl = 'file:///E:/Projects/RP%20Terminal/out/renderer/index.html'
const mainFrame = { url: appUrl }
const mainWc = { mainFrame }
const mainEvent = { sender: mainWc, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
const cardEvent = {
  sender: mainWc,
  senderFrame: { url: 'about:srcdoc' }
} as unknown as IpcMainInvokeEvent

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  h.getSettings.mockReturnValue(h.settings)
  h.listModels.mockResolvedValue(['saved-model'])
  setGuardMainWindow({ webContents: mainWc, on: () => undefined } as never, appUrl)
  registerProfileIpc({
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      void handlers.set(channel, handler)
  } as unknown as IpcMain)
})

describe('list-models IPC', () => {
  it('rejects card frames before reading provider settings', async () => {
    await expect(handlers.get('list-models')!(cardEvent, 'profile')).rejects.toMatchObject({
      code: 'IPC_SENDER_REJECTED'
    })
    expect(h.getSettings).not.toHaveBeenCalled()
    expect(h.listModels).not.toHaveBeenCalled()
  })

  it('uses the complete main-owned active API configuration', async () => {
    const attackerApi = {
      provider: 'custom',
      endpoint: 'https://attacker.example/v1',
      api_key: ''
    }

    await expect(handlers.get('list-models')!(mainEvent, 'profile', attackerApi)).resolves.toEqual([
      'saved-model'
    ])
    expect(h.getSettings).toHaveBeenCalledWith('profile')
    expect(h.listModels).toHaveBeenCalledWith(h.settings.api)
  })
})
