import { ChatMessage, estimateTokens } from './promptBuilder'
import { cacheHitPct } from '../../shared/usageCost'
import { TurnMetric, CumulativeMetric, FloorMetrics } from '../../shared/usageTypes'
import { Usage } from '../../shared/usageTypes'

export type { Usage } from '../../shared/usageTypes'

/** One recorded turn's metrics (proxy + optional live usage). */
export interface TurnStat {
  msgs: number
  promptTokens: number
  stablePrefixMsgs: number
  stablePrefixTokens: number
  usage: Usage | null
}

/** Aggregated per-session report. */
export interface CacheReport {
  turns: number
  avgStablePrefixPct: number
  totalPromptTokens: number
  usage: Usage | null
}

/**
 * Deterministic cache proxy: the length of the leading run of byte-identical
 * messages shared by two consecutive assembled prompts. This is the theoretical
 * cache-read ceiling (caches are a prefix match), computed without sending
 * anything — so prompt-build strategies can be A/B'd on identical inputs.
 * Message-granular (role + content), which matches how provider content blocks cache.
 */
export const stablePrefixTokens = (
  prev: ChatMessage[],
  curr: ChatMessage[]
): { messages: number; tokens: number } => {
  const len = Math.min(prev.length, curr.length)
  let messages = 0
  let tokens = 0
  while (
    messages < len &&
    prev[messages].role === curr[messages].role &&
    prev[messages].content === curr[messages].content
  ) {
    tokens += estimateTokens(curr[messages].content)
    messages++
  }
  return { messages, tokens }
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)

/**
 * Normalize a provider's raw usage object into the common shape. Anthropic reports
 * cache read/write directly; OpenAI and Gemini report a cached subset of the prompt
 * tokens (no explicit write), so `input` is the uncached remainder. Returns null when
 * the provider sent no usable usage.
 */
export const normalizeUsage = (provider: string, raw: unknown): Usage | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  if (provider === 'anthropic') {
    return {
      cacheRead: num(r.cache_read_input_tokens),
      cacheWrite: num(r.cache_creation_input_tokens),
      input: num(r.input_tokens),
      output: num(r.output_tokens)
    }
  }
  if (provider === 'google' || provider === 'gemini') {
    const cached = num(r.cachedContentTokenCount)
    return {
      cacheRead: cached,
      cacheWrite: 0,
      input: Math.max(0, num(r.promptTokenCount) - cached),
      output: num(r.candidatesTokenCount)
    }
  }
  // OpenAI-compatible
  const cached = num(r.prompt_tokens_details?.cached_tokens)
  return {
    cacheRead: cached,
    cacheWrite: 0,
    input: Math.max(0, num(r.prompt_tokens) - cached),
    output: num(r.completion_tokens)
  }
}

/** Aggregate a session's turns into a single report. */
export const summarize = (turns: TurnStat[]): CacheReport => {
  if (turns.length === 0) {
    return { turns: 0, avgStablePrefixPct: 0, totalPromptTokens: 0, usage: null }
  }
  let pctSum = 0
  let totalPromptTokens = 0
  const u: Usage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
  let anyUsage = false
  for (const t of turns) {
    pctSum += t.promptTokens > 0 ? (t.stablePrefixTokens / t.promptTokens) * 100 : 0
    totalPromptTokens += t.promptTokens
    if (t.usage) {
      anyUsage = true
      u.cacheRead += t.usage.cacheRead
      u.cacheWrite += t.usage.cacheWrite
      u.input += t.usage.input
      u.output += t.usage.output
    }
  }
  return {
    turns: turns.length,
    avgStablePrefixPct: pctSum / turns.length,
    totalPromptTokens,
    usage: anyUsage ? u : null
  }
}

const sumUsage = (
  a: { cacheRead: number; cacheWrite: number; input: number; output: number } | null,
  b: { cacheRead: number; cacheWrite: number; input: number; output: number } | null
): { cacheRead: number; cacheWrite: number; input: number; output: number } | null => {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return {
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    input: a.input + b.input,
    output: a.output + b.output
  }
}

/**
 * Build one floor's metrics: its own turn numbers (the deterministic stable-prefix proxy +
 * optional real usage) plus a cumulative snapshot derived from the previous floor's cumulative
 * (so each floor is a self-contained, truncation-safe graph point). Averages are running means.
 */
export const buildFloorMetrics = (args: {
  messages: ChatMessage[]
  prevMessages: ChatMessage[] | null
  usage: { cacheRead: number; cacheWrite: number; input: number; output: number } | null
  provider: string
  model: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  ts: string
  responseText: string
  prevCumulative: CumulativeMetric | null
}): FloorMetrics => {
  const proxy = args.prevMessages
    ? stablePrefixTokens(args.prevMessages, args.messages)
    : { messages: 0, tokens: 0 }
  const promptTokens = args.messages.reduce((n, msg) => n + estimateTokens(msg.content), 0)
  const outputTokens = args.usage ? args.usage.output : estimateTokens(args.responseText)
  const turn: TurnMetric = {
    ts: args.ts,
    provider: args.provider,
    model: args.model,
    cacheLevel: args.cacheLevel,
    l1Mode: args.l1Mode,
    promptTokens,
    proxyTokens: proxy.tokens,
    proxyPct: promptTokens > 0 ? (proxy.tokens / promptTokens) * 100 : 0,
    outputTokens,
    usage: args.usage
  }

  const c = args.prevCumulative
  const prevTurns = c?.turns ?? 0
  const prevUsageTurns = c?.usageTurns ?? 0
  const turns = prevTurns + 1
  const hadUsage = !!args.usage
  const usageTurns = prevUsageTurns + (hadUsage ? 1 : 0)
  const totalPromptTokens = (c?.totalPromptTokens ?? 0) + promptTokens
  const totalProxyTokens = (c?.totalProxyTokens ?? 0) + proxy.tokens
  const totalOutputTokens = (c?.totalOutputTokens ?? 0) + outputTokens
  const avgProxyPct = ((c?.avgProxyPct ?? 0) * prevTurns + turn.proxyPct) / turns
  const avgCacheHitPct = hadUsage
    ? ((c?.avgCacheHitPct ?? 0) * prevUsageTurns + cacheHitPct(args.usage!)) / usageTurns
    : (c?.avgCacheHitPct ?? 0)

  const cumulative: CumulativeMetric = {
    turns,
    usageTurns,
    totalPromptTokens,
    totalProxyTokens,
    totalOutputTokens,
    usage: sumUsage(c?.usage ?? null, args.usage),
    avgPromptTokens: totalPromptTokens / turns,
    avgOutputTokens: totalOutputTokens / turns,
    avgProxyPct,
    avgCacheHitPct
  }
  return { turn, cumulative }
}
