import { describe, it, expect } from 'vitest'

import { fixtureContext } from '../../../src/shared/yuzu/p0/fixtureContext'
import { runP0Batch } from '../../../src/shared/yuzu/p0/runP0Batch'
import { inlineStrategy } from '../../../src/shared/yuzu/p0/pipeline'
import type { Settings } from '../../../src/main/types/models'
import type { PresetParameters } from '../../../src/main/types/preset'
import {
  buildProviderSpecs,
  callProvider,
  loadLocalProviders,
  makeResultSink,
  paramsFromEnv,
  runsPerProviderFromEnv,
  writeReadout
} from './_harnessProviders'

/**
 * Env-gated real-provider harness (Project Yuzu WP-P0), INLINE (YSS) wire format — the A/B counterpart
 * to p0-real-run.harness.test.ts. It is byte-for-byte the same run, differing ONLY by passing
 * `strategy: inlineStrategy` to `runP0Batch`, so the two readouts are directly comparable. SKIPPED in
 * the normal suite. To collect the inline readout across your real providers:
 *
 *   RUN_YUZU_P0=1 YUZU_P0_RUNS=20 npx vitest run test/yuzu/p0/p0-inline-run.harness.test.ts
 *
 * Results land in test/yuzu/p0/results/<timestamp>-inline.jsonl + <timestamp>-inline.readout.txt.
 */

describe.skipIf(!process.env.RUN_YUZU_P0)(
  'Project Yuzu P0 — real-provider readout (inline)',
  () => {
    it(
      'runs the inline (YSS) scene pipeline across the configured providers and writes a readout',
      async () => {
        const local = loadLocalProviders()
        expect(Array.isArray(local) && local.length > 0).toBe(true)

        const runsPerProvider = runsPerProviderFromEnv()
        const params = paramsFromEnv()

        const abort = new AbortController()
        const { providers, acquireSlot } = buildProviderSpecs(local, params, abort.signal)
        const { jsonlPath, readoutPath, onRecord } = makeResultSink('-inline')

        const { readout } = await runP0Batch<Settings, PresetParameters>({
          ctx: fixtureContext,
          providers,
          runsPerProvider,
          strategy: inlineStrategy,
          callProvider,
          acquireSlot,
          onRecord,
          signal: abort.signal
        })

        writeReadout(readoutPath, jsonlPath, readout)
        expect(readout.total).toBe(providers.length * runsPerProvider)
      },
      20 * 60 * 1000
    )
  }
)
