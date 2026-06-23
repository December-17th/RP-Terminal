/** Provider-neutral cache usage for one turn. */
export interface Usage {
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
}

/** One generated turn's own metrics. */
export interface TurnMetric {
  ts: string
  provider: string
  model: string
  cacheLevel: number
  l1Mode: 'partition' | 'diff'
  promptTokens: number
  proxyTokens: number
  proxyPct: number
  outputTokens: number
  usage: Usage | null
}

/** Running tally over all generated floors up to and including this one. */
export interface CumulativeMetric {
  turns: number
  usageTurns: number
  totalPromptTokens: number
  totalProxyTokens: number
  totalOutputTokens: number
  usage: Usage | null
  avgPromptTokens: number
  avgOutputTokens: number
  avgProxyPct: number
  avgCacheHitPct: number
}

/** Persisted on each generated floor (floors.metrics). */
export interface FloorMetrics {
  turn: TurnMetric
  cumulative: CumulativeMetric
}

/** $ per 1,000,000 tokens, per token class. */
export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
