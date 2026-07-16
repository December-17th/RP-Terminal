import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The REAL provider call. apiService value-imports logService (which imports electron); vitest's
// global `electron` alias (see vitest.config.ts) makes that import resolvable under Node, so we can
// import streamProvider directly — no per-test electron mock needed. This is the ONLY place the real
// streamProvider is injected into the pure P0 pipeline.
import { streamProvider, rpmEndpointKey } from '../../../src/main/services/apiService'
import { acquireRpmSlot, acquireConcurrencySlot } from '../../../src/main/services/rpmLimiter'
import type { Settings } from '../../../src/main/types/models'
import type { PresetParameters } from '../../../src/main/types/preset'

import { fixtureContext } from '../../../src/shared/yuzu/p0/fixtureContext'
import {
  runP0Batch,
  type ProviderSpec,
  type RunRecord
} from '../../../src/shared/yuzu/p0/runP0Batch'
import { formatReadout } from '../../../src/shared/yuzu/p0/metrics'

/**
 * Env-gated real-provider harness (Project Yuzu WP-P0). SKIPPED in the normal suite. To collect the
 * readout across your real providers:
 *
 *   RUN_YUZU_P0=1 YUZU_P0_RUNS=20 npx vitest run test/yuzu/p0/p0-real-run.harness.test.ts
 *
 * Provider keys come from test/yuzu/p0/providers.local.json (gitignored). See the README in this dir.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(HERE, 'results')
const LOCAL_PROVIDERS = join(HERE, 'providers.local.json')

/** ApiPreset-shaped entry from providers.local.json. */
interface LocalProvider {
  name: string
  provider: string
  endpoint: string
  api_key: string
  model: string
  rpm_limit?: number
  max_concurrent?: number
}

/** Build a minimal Settings whose `.api` is what streamProvider actually reads. rpm/concurrency are
 *  zeroed here because pacing is done externally via acquireSlot (below) to avoid double-gating. */
const settingsFor = (p: LocalProvider): Settings =>
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

describe.skipIf(!process.env.RUN_YUZU_P0)('Project Yuzu P0 — real-provider readout', () => {
  it(
    'runs the scene pipeline across the configured providers and writes a readout',
    async () => {
      if (!existsSync(LOCAL_PROVIDERS)) {
        throw new Error(
          `Missing ${LOCAL_PROVIDERS}. Copy providers.example.json to providers.local.json and fill in your real keys (see README.md).`
        )
      }
      const local = JSON.parse(readFileSync(LOCAL_PROVIDERS, 'utf-8')) as LocalProvider[]
      expect(Array.isArray(local) && local.length > 0).toBe(true)

      const runsPerProvider = Number(process.env.YUZU_P0_RUNS ?? 20)
      const params: PresetParameters = {
        temperature: Number(process.env.YUZU_P0_TEMP ?? 0.8),
        max_tokens: Number(process.env.YUZU_P0_MAX_TOKENS ?? 1500)
      }

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

      const abort = new AbortController()
      const acquireSlot = async (
        spec: ProviderSpec<Settings, PresetParameters>
      ): Promise<() => void> => {
        const b = budgets.get(spec.name)!
        if (b.rpm > 0) await acquireRpmSlot(b.key, b.rpm, abort.signal)
        return acquireConcurrencySlot(b.key, b.max, abort.signal)
      }

      mkdirSync(RESULTS_DIR, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const jsonlPath = join(RESULTS_DIR, `${stamp}.jsonl`)
      const readoutPath = join(RESULTS_DIR, `${stamp}.readout.txt`)

      const onRecord = (r: RunRecord): void => {
        appendFileSync(jsonlPath, JSON.stringify(r) + '\n', 'utf-8')
      }

      const { readout } = await runP0Batch<Settings, PresetParameters>({
        ctx: fixtureContext,
        providers,
        runsPerProvider,
        callProvider: (settings, messages, p, onDelta, signal) =>
          streamProvider(settings, messages, p, onDelta, signal),
        acquireSlot,
        onRecord,
        signal: abort.signal
      })

      const text = formatReadout(readout)
      writeFileSync(readoutPath, text + '\n', 'utf-8')
      console.log(`\n${text}\n\nRecords: ${jsonlPath}\nReadout: ${readoutPath}\n`)

      expect(readout.total).toBe(providers.length * runsPerProvider)
    },
    20 * 60 * 1000
  )
})
