import { buildSceneMessages, type ChatMessage } from './schemaPrompt'
import { buildRepairMessages } from './repair'
import { extractJson } from './extractJson'
import { FailureShape, mapExtractReason, observationsFromApplied, validateScene } from './validate'
import { toProseFallbackScene } from './proseFallback'
import type { P0Context } from './fixtureContext'
import {
  summarize,
  type AttemptRecord,
  type Outcome,
  type Readout,
  type RunRecord
} from './metrics'

export type { AttemptRecord, RunRecord, Outcome, Readout } from './metrics'

/**
 * Project Yuzu WP-P0 — the orchestrator.
 *
 * PURE except for the injected `callProvider`. The provider call is a passed-in dependency, never a
 * hard import — the real `streamProvider` (which value-imports Electron) is injected ONLY by the
 * env-gated harness; the normal suite injects a fake. That injection seam is the whole point of the
 * P0 architecture.
 *
 * Generic over the settings/params types <S, P>: the harness parametrizes with the app's real
 * `Settings` / `PresetParameters` (so those types flow through at the call site) while this pure
 * `src/shared/**` module never imports them from `src/main`.
 */

export type OnDelta = (delta: string) => void

export type CallProvider<S, P> = (
  settings: S,
  messages: ChatMessage[],
  params: P,
  onDelta: OnDelta,
  signal?: AbortSignal
) => Promise<string>

/** A ready-to-call provider: the caller supplies the fully-populated settings + params. */
export interface ProviderSpec<S, P> {
  name: string
  model: string
  settings: S
  params: P
}

export interface RunP0Opts<S, P> {
  providers: ProviderSpec<S, P>[]
  runsPerProvider: number
  ctx: P0Context
  callProvider: CallProvider<S, P>
  /** Optional pacing hook: acquire a rate/concurrency slot before a call; returns a release fn. */
  acquireSlot?: (spec: ProviderSpec<S, P>) => Promise<() => void>
  /** Called for every completed run so the harness can stream records to disk. */
  onRecord?: (record: RunRecord) => void
  signal?: AbortSignal
}

export interface BatchResult {
  records: RunRecord[]
  readout: Readout
}

const noop: OnDelta = () => {}

interface AttemptOutcome {
  rec: AttemptRecord
  /** Human-readable detail (for building the repair re-ask). Empty on success. */
  detail: string
}

/** One provider call + extract + validate. Never throws — a provider error becomes an OTHER failure. */
const runAttempt = async <S, P>(
  spec: ProviderSpec<S, P>,
  messages: ChatMessage[],
  opts: RunP0Opts<S, P>
): Promise<AttemptOutcome> => {
  const release = opts.acquireSlot ? await opts.acquireSlot(spec) : null
  const t0 = Date.now()
  let raw: string
  try {
    raw = await opts.callProvider(spec.settings, messages, spec.params, noop, opts.signal)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return {
      rec: {
        raw: detail,
        latencyMs: Date.now() - t0,
        applied: [],
        ok: false,
        failures: [FailureShape.OTHER]
      },
      detail: `provider call failed: ${detail}`
    }
  } finally {
    release?.()
  }
  const latencyMs = Date.now() - t0

  const ex = extractJson(raw)
  const observations = observationsFromApplied(ex.applied)
  if (!ex.ok) {
    const failures = [...new Set([...observations, mapExtractReason(ex.reason)])]
    return { rec: { raw, latencyMs, applied: ex.applied, ok: false, failures }, detail: ex.error }
  }

  const v = validateScene(ex.value, opts.ctx)
  if (v.ok) {
    return {
      rec: { raw, latencyMs, applied: ex.applied, ok: true, failures: observations },
      detail: ''
    }
  }
  const failures = [...new Set([...observations, ...v.failures])]
  return { rec: { raw, latencyMs, applied: ex.applied, ok: false, failures }, detail: v.detail }
}

const runOnce = async <S, P>(
  spec: ProviderSpec<S, P>,
  opts: RunP0Opts<S, P>
): Promise<RunRecord> => {
  const ts = new Date().toISOString()
  const base = { ts, providerName: spec.name, model: spec.model }

  const first = await runAttempt(spec, buildSceneMessages(opts.ctx), opts)
  if (first.rec.ok) {
    return { ...base, attempt1: first.rec, outcome: 'valid' as Outcome }
  }

  const repairMessages = buildRepairMessages(
    opts.ctx,
    first.rec.raw,
    first.rec.failures,
    first.detail
  )
  const second = await runAttempt(spec, repairMessages, opts)
  if (second.rec.ok) {
    return { ...base, attempt1: first.rec, repair: second.rec, outcome: 'repaired' as Outcome }
  }

  // Both attempts failed — degrade to a prose fallback scene so the story still advances.
  const fallbackScene = toProseFallbackScene(second.rec.raw || first.rec.raw, opts.ctx)
  return {
    ...base,
    attempt1: first.rec,
    repair: second.rec,
    outcome: 'fallback' as Outcome,
    fallbackScene
  }
}

/**
 * Run `runsPerProvider` scene generations against each provider, recording per-run outcomes and
 * returning the aggregate readout. Sequential per provider (pacing is the harness's job via
 * `acquireSlot`). Honors an abort signal between runs.
 */
export const runP0Batch = async <S, P>(opts: RunP0Opts<S, P>): Promise<BatchResult> => {
  const records: RunRecord[] = []
  for (const spec of opts.providers) {
    for (let i = 0; i < opts.runsPerProvider; i++) {
      if (opts.signal?.aborted) break
      const record = await runOnce(spec, opts)
      records.push(record)
      opts.onRecord?.(record)
    }
  }
  return { records, readout: summarize(records) }
}
