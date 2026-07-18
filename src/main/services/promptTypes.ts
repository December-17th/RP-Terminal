export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Explicit per-message budget policy carried alongside an assembled prompt.
 * `history` entries may be trimmed oldest-first; `pinned` entries are retained.
 */
export type BudgetClass = 'pinned' | 'history'

/** Wire messages plus their aligned budget policy. */
export interface BuildPromptResult {
  messages: ChatMessage[]
  budgetClasses: BudgetClass[]
}
