import type { BudgetClass, ChatMessage } from './promptTypes'
import { estimateTokens } from '../../shared/tokenEstimate'

// Re-exported so existing main-side consumers keep importing it from here.
export { estimateTokens }

const messageTokens = (message: ChatMessage): number => estimateTokens(message.content) + 4

/**
 * Trim oldest explicit history messages until the prompt fits, retaining the
 * latest history turn and every pinned message. Without an explicit policy,
 * retain the leading system prefix and final message.
 */
export const fitToBudget = (
  messages: ChatMessage[],
  maxTokens: number,
  budgetClasses?: BudgetClass[]
): { messages: ChatMessage[]; dropped: number; budgetClasses?: BudgetClass[] } => {
  const total = messages.reduce((sum, message) => sum + messageTokens(message), 0)
  if (total <= maxTokens) {
    return { messages, dropped: 0, ...(budgetClasses ? { budgetClasses } : {}) }
  }

  const remove = new Set<number>()
  const historyIndexes = budgetClasses
    ? messages.map((_, index) => index).filter((index) => budgetClasses[index] === 'history')
    : []

  if (historyIndexes.length > 0) {
    let running = total
    for (const index of historyIndexes.slice(0, -1)) {
      if (running <= maxTokens) break
      remove.add(index)
      running -= messageTokens(messages[index])
    }
  } else {
    const conversationStart = messages.findIndex((message) => message.role !== 'system')
    if (conversationStart !== -1) {
      let running = total
      for (
        let index = conversationStart;
        running > maxTokens && index < messages.length - 1;
        index++
      ) {
        remove.add(index)
        running -= messageTokens(messages[index])
      }
    }
  }

  if (remove.size === 0) {
    return { messages, dropped: 0, ...(budgetClasses ? { budgetClasses } : {}) }
  }
  return {
    messages: messages.filter((_, index) => !remove.has(index)),
    dropped: remove.size,
    ...(budgetClasses
      ? { budgetClasses: budgetClasses.filter((_, index) => !remove.has(index)) }
      : {})
  }
}
