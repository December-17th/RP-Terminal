import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  refreshFloors: vi.fn(),
  loadRegex: vi.fn(),
  chat: { activeChatId: 'chat-a' } as { activeChatId: string | null },
  profile: { activeProfile: { id: 'profile-a' } } as { activeProfile: { id: string } | null },
  character: { activeCharacter: { id: 'card-a' } } as { activeCharacter: { id: string } | null }
}))

vi.mock('../src/renderer/src/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ ...h.chat, refreshFloors: h.refreshFloors }) }
}))
vi.mock('../src/renderer/src/stores/profileStore', () => ({
  useProfileStore: { getState: () => h.profile }
}))
vi.mock('../src/renderer/src/stores/characterStore', () => ({
  useCharacterStore: { getState: () => h.character }
}))
vi.mock('../src/renderer/src/stores/regexStore', () => ({
  useRegexStore: { getState: () => ({ load: h.loadRegex }) }
}))

import { refreshWcvHostState } from '../src/renderer/src/cardBridge/hostReload'

beforeEach(() => {
  vi.clearAllMocks()
  h.chat.activeChatId = 'chat-a'
  h.profile.activeProfile = { id: 'profile-a' }
  h.character.activeCharacter = { id: 'card-a' }
})

describe('refreshWcvHostState', () => {
  it('reloads chat floors and active regex rules after a card-side regex write', async () => {
    await refreshWcvHostState('chat-a')

    expect(h.refreshFloors).toHaveBeenCalledWith('profile-a', 'chat-a')
    expect(h.loadRegex).toHaveBeenCalledWith('profile-a', {
      cardId: 'card-a',
      chatId: 'chat-a'
    })
  })

  it('ignores reloads for an inactive chat', async () => {
    await refreshWcvHostState('chat-b')

    expect(h.refreshFloors).not.toHaveBeenCalled()
    expect(h.loadRegex).not.toHaveBeenCalled()
  })
})
