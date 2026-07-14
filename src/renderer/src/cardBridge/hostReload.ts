import { useProfileStore } from '../stores/profileStore'
import { useCharacterStore } from '../stores/characterStore'
import { useChatStore } from '../stores/chatStore'
import { useRegexStore } from '../stores/regexStore'

/** Refresh renderer state after a card-side write. Regex writers use the same host reload signal as chat writers. */
export const refreshWcvHostState = async (chatId: string): Promise<void> => {
  const chat = useChatStore.getState()
  const profileId = useProfileStore.getState().activeProfile?.id
  if (!profileId || chatId !== chat.activeChatId) return

  const cardId = useCharacterStore.getState().activeCharacter?.id ?? null
  await Promise.all([
    chat.refreshFloors(profileId, chatId),
    useRegexStore.getState().load(profileId, { cardId, chatId })
  ])
}
