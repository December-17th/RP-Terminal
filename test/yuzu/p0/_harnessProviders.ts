import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The REAL provider call + pacing. apiService value-imports logService (which imports electron);
// vitest's global `electron` alias (see vitest.config.ts) makes that import resolvable under Node, so
// the harness can import streamProvider directly — no per-test electron mock needed.
import { streamProvider, rpmEndpointKey } from '../../../src/main/services/apiService'
import { acquireRpmSlot, acquireConcurrencySlot } from '../../../src/main/services/rpmLimiter'
import type { Settings } from '../../../src/main/types/models'
import type { PresetParameters } from '../../../src/main/types/preset'

import type { CallProvider, ProviderSpec, RunRecord } from '../../../src/shared/yuzu/p0/runP0Batch'
import { formatReadout } from '../../../src/shared/yuzu/p0/metrics'
import type { Readout } from '../../../src/shared/yuzu/p0/metrics'

/**
 * Shared, NON-test scaffolding for the env-gated Project Yuzu P0 harnesses (JSON + inline). This file
 * is deliberately NOT named `*.test.ts` so vitest's `test/**\/*.test.ts` include glob won't collect it
 * as a suite — it only holds the provider loading / settings / pacing / results-writing plumbing that
 * both harness suites reuse, keeping the only difference between them the wire-format strategy.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
export const RESULTS_DIR = join(HERE, 'results')
export const LOCAL_PROVIDERS = join(HERE, 'providers.local.json')

/** ApiPreset-shaped entry from providers.local.json. */
export interface LocalProvider {
  name: string
  provider: string
  endpoint: string
  api_key: string
  model: string
  rpm_limit?: number
  max_concurrent?: number
}

/** Read + parse providers.local.json (gitignored). Throws a helpful message if it is missing. */
export const loadLocalProviders = (): LocalProvider[] => {
  if (!existsSync(LOCAL_PROVIDERS)) {
    throw new Error(
      `Missing ${LOCAL_PROVIDERS}. Copy providers.example.json to providers.local.json and fill in your real keys (see README.md).`
    )
  }
  return JSON.parse(readFileSync(LOCAL_PROVIDERS, 'utf-8')) as LocalProvider[]
}

/** Build a minimal Settings whose `.api` is what streamProvider actually reads. rpm/concurrency are
 *  zeroed here because pacing is done externally via acquireSlot (below) to avoid double-gating. */
export const settingsFor = (p: LocalProvider): Settings =>
  ({
    api: {
      provider: p.provider,
      endpoint: p.endpoint,
      api_key: p.api_key,
      model: p.model,
      rpm_limit: 0,
      max_concurrent: 0
    },
    // baseline = no provider-side prompt caching, a clean control for the probe.
    cache: { mode: 'baseline' }
  }) as unknown as Settings

/** Preset parameters from the shared env knobs (identical across both harnesses). */
export const paramsFromEnv = (): PresetParameters => ({
  temperature: Number(process.env.YUZU_P0_TEMP ?? 0.8),
  max_tokens: Number(process.env.YUZU_P0_MAX_TOKENS ?? 1500)
})

export const runsPerProviderFromEnv = (): number => Number(process.env.YUZU_P0_RUNS ?? 20)

/** The real provider call, wrapped as the pipeline's `CallProvider`. */
export const callProvider: CallProvider<Settings, PresetParameters> = (
  settings,
  messages,
  params,
  onDelta,
  signal
) => streamProvider(settings, messages, params, onDelta, signal)

/** Build the provider specs + an externally-paced `acquireSlot` bound to the given abort signal. */
export const buildProviderSpecs = (
  local: LocalProvider[],
  params: PresetParameters,
  signal: AbortSignal
): {
  providers: ProviderSpec<Settings, PresetParameters>[]
  acquireSlot: (spec: ProviderSpec<Settings, PresetParameters>) => Promise<() => void>
} => {
  // Per-provider pacing budgets, keyed by endpoint (presets on one endpoint share a budget).
  const budgets = new Map<string, { key: string; rpm: number; max: number }>()
  const providers: ProviderSpec<Settings, PresetParameters>[] = local.map((p) => {
    const settings = settingsFor(p)
    budgets.set(p.name, {
      key: rpmEndpointKey(settings.api),
      rpm: p.rpm_limit ?? 0,
      max: p.max_concurrent ?? 0
    })
    return { name: p.name, model: p.model, settings, params }
  })

  const acquireSlot = async (
    spec: ProviderSpec<Settings, PresetParameters>
  ): Promise<() => void> => {
    const b = budgets.get(spec.name)!
    if (b.rpm > 0) await acquireRpmSlot(b.key, b.rpm, signal)
    return acquireConcurrencySlot(b.key, b.max, signal)
  }

  return { providers, acquireSlot }
}

/** Open timestamped result writers under RESULTS_DIR. `suffix` distinguishes the two formats. */
export const makeResultSink = (
  suffix = ''
): { jsonlPath: string; readoutPath: string; onRecord: (r: RunRecord) => void } => {
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonlPath = join(RESULTS_DIR, `${stamp}${suffix}.jsonl`)
  const readoutPath = join(RESULTS_DIR, `${stamp}${suffix}.readout.txt`)
  const onRecord = (r: RunRecord): void => {
    appendFileSync(jsonlPath, JSON.stringify(r) + '\n', 'utf-8')
  }
  return { jsonlPath, readoutPath, onRecord }
}

/** Write + echo the formatted readout table. */
export const writeReadout = (readoutPath: string, jsonlPath: string, readout: Readout): void => {
  const text = formatReadout(readout)
  writeFileSync(readoutPath, text + '\n', 'utf-8')
  console.log(`\n${text}\n\nRecords: ${jsonlPath}\nReadout: ${readoutPath}\n`)
}
