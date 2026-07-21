import type { CardFloorCommit } from '../../../shared/agentRuntime'

type CardFloorCommitListener = (profileId: string, chatId: string, event: CardFloorCommit) => void

const listeners = new Set<CardFloorCommitListener>()

export const onCardFloorCommitted = (listener: CardFloorCommitListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const emitCardFloorCommitted = (
  profileId: string,
  chatId: string,
  event: CardFloorCommit
): void => {
  const snapshot = structuredClone(event)
  for (const listener of listeners) {
    try {
      listener(profileId, chatId, structuredClone(snapshot))
    } catch {
      // A card transport listener must never break floor persistence.
    }
  }
}
