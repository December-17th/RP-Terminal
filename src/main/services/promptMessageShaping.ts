import type { ChatMessage } from './promptTypes'

/** Relabel every system message as user content without mutating the input. */
export const systemToUser = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) =>
    message.role === 'system' ? { role: 'user', content: message.content } : message
  )

/** Merge adjacent messages with the same role. */
export const mergeConsecutiveRoles = (messages: ChatMessage[]): ChatMessage[] => {
  const out: ChatMessage[] = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (last && last.role === message.role) last.content += '\n' + message.content
    else out.push({ role: message.role, content: message.content })
  }
  return out
}

/** ST messages may carry fields that protect them from selective squashing. */
export interface SquashMessage extends ChatMessage {
  name?: string
  identifier?: string
}

/**
 * SillyTavern's selective system-message squash: merge only unnamed,
 * non-control system messages and drop empty system messages.
 */
export const squashSystemMessages = (messages: SquashMessage[]): ChatMessage[] => {
  const excludedIdentifiers = new Set(['newMainChat', 'newChat', 'groupNudge'])
  const shouldSquash = (message: SquashMessage): boolean =>
    !excludedIdentifiers.has(message.identifier ?? '') && message.role === 'system' && !message.name

  const out: ChatMessage[] = []
  let last: { message: ChatMessage; source: SquashMessage } | null = null
  for (const source of messages) {
    if (source.role === 'system' && !source.content) continue
    if (shouldSquash(source) && last && shouldSquash(last.source)) {
      last.message.content += '\n' + source.content
    } else {
      const message: ChatMessage = { role: source.role, content: source.content }
      out.push(message)
      last = { message, source }
    }
  }
  return out
}
