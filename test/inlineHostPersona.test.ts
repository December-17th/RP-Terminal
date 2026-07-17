import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  settings: {
    persona: { name: 'Lyra', description: 'A quiet cartographer', inject: false }
  },
  loadLibrary: vi.fn(),
  loadSession: vi.fn()
}))

vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ floors: [], chats: [] }) }
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
  useSettingsStore: { getState: () => ({ settings: h.settings }) }
}))
vi.mock('../src/renderer/src/stores/composerStore', () => ({
  useComposerStore: { getState: () => ({}) }
}))
vi.mock('../src/renderer/src/stores/lorebookStore', () => ({
  useLorebookStore: {
    getState: () => ({
      library: [],
      sessionLorebooks: [],
      loadLibrary: h.loadLibrary,
      loadSession: h.loadSession
    })
  }
}))
vi.mock('../src/renderer/src/cardBridge/cardHostEvents', () => ({
  onCardHostEvent: vi.fn()
}))
vi.mock('../src/renderer/src/cardBridge/playTheme', () => ({
  applyRuntimeTheme: vi.fn(),
  getEffectivePlayTheme: vi.fn()
}))

import { createInlineHost } from '../src/renderer/src/cardBridge/host'

describe('createInlineHost persona transport', () => {
  it('returns the active description when injection is disabled', () => {
    const host = createInlineHost({
      profileId: 'profile-a',
      chatId: 'chat-a',
      characterId: 'character-a'
    })

    expect(host.personaDescription()).toBe('A quiet cartographer')
  })
})
