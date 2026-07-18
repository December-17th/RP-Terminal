import type { Scene } from './sceneDraftSchema'
import type { FailureShape } from './validate'

/**
 * Project Yuzu WP-P0 — run records + the aggregate readout.
 *
 * These record types live HERE (not in runP0Batch) so the metrics ↔ orchestrator dependency stays
 * one-way (runP0Batch imports metrics; metrics imports nothing from runP0Batch), keeping the module
 * graph acyclic. runP0Batch re-exports them for convenience.
 */

/** One model call + its extraction/validation outcome. */
export interface AttemptRecord {
  /** The raw model reply. Empty when the provider call itself threw. */
  raw: string
  /** Transport/provider failure detail, kept separate so it cannot become fallback narration. */
  providerError?: string
  latencyMs: number
  /** extractJson transforms that fired: 'think' | 'fence' | 'slice'. */
  applied: string[]
  ok: boolean
  /** FailureShapes observed (includes think/fence/prose observations even when ok). */
  failures: FailureShape[]
}

export type Outcome = 'valid' | 'repaired' | 'fallback'

/** Which wire format produced this run — the A/B dimension. */
export type WireFormat = 'json' | 'inline'

/** One full run of the pipeline for one provider (attempt, optional repair, outcome). */
export interface RunRecord {
  ts: string
  providerName: string
  model: string
  /** Stable non-secret fingerprint of the harness inputs used for safe checkpoint resume. */
  checkpointKey?: string
  /** Wire format used. Optional for back-compat with hand-built records; runP0Batch always sets it. */
  format?: WireFormat
  attempt1: AttemptRecord
  repair?: AttemptRecord
  outcome: Outcome
  /** Present only when outcome === 'fallback': the degraded narration-only scene. */
  fallbackScene?: Scene
}

export interface StatCount {
  n: number
  pct: number
}

export interface ProviderReadout {
  providerName: string
  model: string
  /** Wire format for this provider group (from the group's records; defaults to 'json'). */
  format: WireFormat
  total: number
  validFirstTry: StatCount
  repaired: StatCount
  fallback: StatCount
  /** Count per FailureShape across ALL attempts (attempt1 + repair) of this provider's runs. */
  failureHistogram: Record<string, number>
  latency: { medianMs: number; p90Ms: number }
}

export interface Readout {
  total: number
  providers: ProviderReadout[]
}

const pct = (n: number, total: number): number =>
  total === 0 ? 0 : Math.round((n / total) * 1000) / 10

/** Percentile (nearest-rank, clamped) over a sorted-ascending numeric array. */
const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))
  return sortedAsc[idx]
}

const median = (sortedAsc: number[]): number => {
  if (sortedAsc.length === 0) return 0
  const mid = Math.floor(sortedAsc.length / 2)
  return sortedAsc.length % 2
    ? sortedAsc[mid]
    : Math.round((sortedAsc[mid - 1] + sortedAsc[mid]) / 2)
}

/** Aggregate run records into a per-provider readout. Pure. */
export const summarize = (records: RunRecord[]): Readout => {
  const groups = new Map<string, RunRecord[]>()
  const NUL = String.fromCharCode(0)
  for (const r of records) {
    // NUL separator can't collide with any provider name, model id, or format
    const key = `${r.providerName}${NUL}${r.model}${NUL}${r.format ?? 'json'}`
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }

  const providers: ProviderReadout[] = []
  for (const [, runs] of groups) {
    const total = runs.length
    const count = (o: Outcome): number => runs.filter((r) => r.outcome === o).length
    const nValid = count('valid')
    const nRepaired = count('repaired')
    const nFallback = count('fallback')

    const failureHistogram: Record<string, number> = {}
    const latencies: number[] = []
    for (const r of runs) {
      latencies.push(r.attempt1.latencyMs + (r.repair?.latencyMs ?? 0))
      for (const att of [r.attempt1, r.repair]) {
        if (!att) continue
        for (const f of att.failures) failureHistogram[f] = (failureHistogram[f] ?? 0) + 1
      }
    }
    latencies.sort((a, b) => a - b)

    providers.push({
      providerName: runs[0].providerName,
      model: runs[0].model,
      format: runs[0].format ?? 'json',
      total,
      validFirstTry: { n: nValid, pct: pct(nValid, total) },
      repaired: { n: nRepaired, pct: pct(nRepaired, total) },
      fallback: { n: nFallback, pct: pct(nFallback, total) },
      failureHistogram,
      latency: { medianMs: median(latencies), p90Ms: percentile(latencies, 90) }
    })
  }

  return { total: records.length, providers }
}

const padEnd = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const padStart = (s: string, n: number): string =>
  s.length >= n ? s : ' '.repeat(n - s.length) + s

/** Render a readout as a clean fixed-width text table for the progress log. */
export const formatReadout = (readout: Readout): string => {
  const lines: string[] = []
  lines.push(`Project Yuzu P0 scene-generation readout — ${readout.total} run(s) total`)
  lines.push('')

  const header = [
    padEnd('provider / model', 34),
    padEnd('fmt', 7),
    padStart('runs', 5),
    padStart('valid', 14),
    padStart('repaired', 14),
    padStart('fallback', 14),
    padStart('med ms', 8),
    padStart('p90 ms', 8)
  ].join('  ')
  lines.push(header)
  lines.push('-'.repeat(header.length))

  const stat = (s: StatCount): string => `${s.n} (${s.pct}%)`
  for (const p of readout.providers) {
    lines.push(
      [
        padEnd(`${p.providerName} / ${p.model}`, 34),
        padEnd(p.format, 7),
        padStart(String(p.total), 5),
        padStart(stat(p.validFirstTry), 14),
        padStart(stat(p.repaired), 14),
        padStart(stat(p.fallback), 14),
        padStart(String(p.latency.medianMs), 8),
        padStart(String(p.latency.p90Ms), 8)
      ].join('  ')
    )
    const hist = Object.entries(p.failureHistogram).sort((a, b) => b[1] - a[1])
    if (hist.length) {
      lines.push(`    failure shapes: ${hist.map(([k, v]) => `${k}=${v}`).join(', ')}`)
    } else {
      lines.push('    failure shapes: (none)')
    }
  }

  return lines.join('\n')
}
