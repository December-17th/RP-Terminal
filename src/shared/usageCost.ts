import { Usage, ModelRates } from './usageTypes'

/** Real per-turn cache hit: fraction of input tokens served from cache (0 when no input). */
export const cacheHitPct = (u: Usage): number => {
  const denom = u.cacheRead + u.cacheWrite + u.input
  return denom > 0 ? (u.cacheRead / denom) * 100 : 0
}

/** Estimated $ for a turn from its real usage + per-model rates. Null when either is absent. */
export const costFor = (usage: Usage | null, rates: ModelRates | undefined): number | null => {
  if (!usage || !rates) return null
  return (
    (usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite +
      usage.input * rates.input +
      usage.output * rates.output) /
    1e6
  )
}
