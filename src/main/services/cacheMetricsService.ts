import { ChatMessage, estimateTokens } from './promptBuilder'
import { stablePrefixTokens, summarize, TurnStat, Usage, CacheReport } from './promptCacheMetrics'
import { log } from './logService'

interface ChatMetrics {
  prev: ChatMessage[] | null
  turns: TurnStat[]
}

const byChat = new Map<string, ChatMetrics>()

const get = (chatId: string): ChatMetrics => {
  let s = byChat.get(chatId)
  if (!s) {
    s = { prev: null, turns: [] }
    byChat.set(chatId, s)
  }
  return s
}

const promptTokens = (messages: ChatMessage[]): number =>
  messages.reduce((n, msg) => n + estimateTokens(msg.content), 0)

/**
 * Record one turn's assembled prompt (the array actually sent to the provider) plus
 * the provider's normalized usage (or null). Computes the deterministic stable-prefix
 * proxy against the previous turn, stores the stat, advances the anchor, and logs a
 * one-line summary. Returns the recorded stat.
 */
export const recordTurn = (
  chatId: string,
  messages: ChatMessage[],
  usage: Usage | null
): TurnStat => {
  const s = get(chatId)
  const prefix = s.prev ? stablePrefixTokens(s.prev, messages) : { messages: 0, tokens: 0 }
  const total = promptTokens(messages)
  const stat: TurnStat = {
    msgs: messages.length,
    promptTokens: total,
    stablePrefixMsgs: prefix.messages,
    stablePrefixTokens: prefix.tokens,
    usage
  }
  s.turns.push(stat)
  s.prev = messages
  const pct = total > 0 ? Math.round((prefix.tokens / total) * 100) : 0
  const live = usage ? ` · live read ${usage.cacheRead} / write ${usage.cacheWrite}` : ''
  log('info', `cache proxy — stable prefix ${prefix.tokens}/${total} tok (${pct}%)${live}`)
  return stat
}

/** Aggregate report for a chat's session so far. */
export const getReport = (chatId: string): CacheReport => summarize(get(chatId).turns)

/** Drop a chat's metrics + previous-prompt anchor (new chat, truncate, or reset). */
export const resetChat = (chatId: string): void => {
  byChat.delete(chatId)
}
