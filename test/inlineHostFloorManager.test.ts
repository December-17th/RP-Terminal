import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  chat: { activeChatId: 'chat-a' } as { activeChatId: string | null },
  openFloorManager: vi.fn()
}))

vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ ...h.chat, floors: [], chats: [] }) }
}))
vi.mock('../src/renderer/src/stores/characterStore', () => ({
  useCharacterStore: { getState: () => ({ activeCharacter: null }) }
}))
vi.mock('../src/renderer/src/stores/presetStore', () => ({
  usePresetStore: { getState: () => ({ preset: null, presets: [] }) }
}))
vi.mock('../src/renderer/src/stores/regexStore', () => ({
  useRegexStore: { getState: () => ({ rules: [], apply: (text: string) => text }) }
}))
vi.mock('../src/renderer/src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) }
}))
vi.mock('../src/renderer/src/stores/composerStore', () => ({
  useComposerStore: { getState: () => ({}) }
}))
vi.mock('../src/renderer/src/stores/lorebookStore', () => ({
  useLorebookStore: {
    getState: () => ({ library: [], sessionLorebooks: [], loadLibrary: vi.fn(), loadSession: vi.fn() })
  }
}))
vi.mock('../src/renderer/src/stores/uiStore', () => ({
  useUiStore: { getState: () => ({ openFloorManager: h.openFloorManager }) }
}))
vi.mock('../src/renderer/src/cardBridge/cardHostEvents', () => ({
  onCardHostEvent: vi.fn()
}))
vi.mock('../src/renderer/src/cardBridge/playTheme', () => ({
  applyRuntimeTheme: vi.fn(),
  getEffectivePlayTheme: vi.fn()
}))

import { createInlineHost } from '../src/renderer/src/cardBridge/host'

const host = (chatId: string) =>
  createInlineHost({ profileId: 'profile-a', chatId, characterId: 'character-a' })

beforeEach(() => {
  vi.clearAllMocks()
  h.chat.activeChatId = 'chat-a'
})

// Transport parity: the WCV path drops the push in App.tsx when the chatId is not the active one, so
// the inline path must refuse the same requests. FloorManagerModal always lists the ACTIVE chat's
// floors, so opening it for a stale panel would aim a floor cut at a chat nobody asked about.
describe('createInlineHost openFloorManager', () => {
  it('opens the app modal for a panel bound to the active chat', () => {
    host('chat-a').openFloorManager()

    expect(h.openFloorManager).toHaveBeenCalledTimes(1)
  })

  it('drops the request from a panel whose chat is no longer active', () => {
    host('chat-b').openFloorManager()

    expect(h.openFloorManager).not.toHaveBeenCalled()
  })

  it('drops the request when no chat is active at all', () => {
    h.chat.activeChatId = null
    host('chat-a').openFloorManager()

    expect(h.openFloorManager).not.toHaveBeenCalled()
  })
})
