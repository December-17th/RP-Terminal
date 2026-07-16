import type { ChatMessage } from './schemaPrompt'
import { jsonStrategy, type PipelineStrategy } from './pipeline'
import { FailureShape } from './validate'
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
export type { PipelineStrategy, ParseResult } from './pipeline'

/**
 * Project Yuzu WP-P0 — the orchestrator.
 *
 * PURE except for the injected `callProvider`. The provider call is a passed-in dependency, never a
 * hard import — the real `streamProvider` (which value-imports Electron) is injected ONLY by the
 * env-gated harness; the normal suite injects a fake. That injection seam is the whole point of the
 * P0 architecture.
 *
 * The loop is FORMAT-AGNOSTIC: a `PipelineStrategy` (default `jsonStrategy`) supplies build-messages /
 * parse / build-repair, so the SAME loop and the SAME `validateScene` judge either the atomic-JSON or
 * the inline-YSS wire format — that is what makes the A/B fair.
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
  /** Wire-format strategy. Defaults to `jsonStrategy` (the atomic-JSON path). */
  strategy?: PipelineStrategy
  /** Optional pacing hook: acquire a rate/concurrency slot before a call; returns a release fn. */
  acquireSlot?: (spec: ProviderSpec<S, P>) => Promise<() => void>
  /** Called for every completed run so the harness can stream records to disk. */
  onRecord?: (record: RunRecord) => void
  /** Existing checkpoint records to include and skip when resuming an interrupted batch. */
  priorRecords?: RunRecord[]
  /** Stable configuration fingerprint; only prior records with the same key are resumed. */
  checkpointKey?: string
  /** Called after each new record with cumulative progress, including resumed records. */
  onProgress?: (progress: { completed: number; total: number; record: RunRecord }) => void
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

/** One provider call + parse (extract/fold + validate). Never throws — a provider error becomes OTHER. */
const runAttempt = async <S, P>(
  spec: ProviderSpec<S, P>,
  messages: ChatMessage[],
  strategy: PipelineStrategy,
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
        raw: '',
        providerError: detail,
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

  const pr = strategy.parse(raw, opts.ctx)
  if (pr.ok) {
    return {
      rec: { raw, latencyMs, applied: pr.applied, ok: true, failures: pr.observations },
      detail: ''
    }
  }
  return {
    rec: { raw, latencyMs, applied: pr.applied, ok: false, failures: pr.failures },
    detail: pr.detail
  }
}

const runOnce = async <S, P>(
  spec: ProviderSpec<S, P>,
  strategy: PipelineStrategy,
  opts: RunP0Opts<S, P>
): Promise<RunRecord> => {
  const ts = new Date().toISOString()
  const base = {
    ts,
    providerName: spec.name,
    model: spec.model,
    format: strategy.format,
    checkpointKey: opts.checkpointKey
  }

  const first = await runAttempt(spec, strategy.buildMessages(opts.ctx), strategy, opts)
  if (first.rec.ok) {
    return { ...base, attempt1: first.rec, outcome: 'valid' as Outcome }
  }

  const repairMessages = first.rec.providerError
    ? strategy.buildMessages(opts.ctx)
    : strategy.buildRepair(opts.ctx, first.rec.raw, first.rec.failures, first.detail)
  const second = await runAttempt(spec, repairMessages, strategy, opts)
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
  const strategy = opts.strategy ?? jsonStrategy
  const records: RunRecord[] = []
  const completedByProvider = new Map<string, number>()
  const keyFor = (providerName: string, model: string): string =>
    `${providerName}\0${model}\0${strategy.format}`

  for (const spec of opts.providers) {
    const key = keyFor(spec.name, spec.model)
    const prior = (opts.priorRecords ?? [])
      .filter(
        (record) =>
          keyFor(record.providerName, record.model) === key &&
          (record.format ?? 'json') === strategy.format &&
          (!opts.checkpointKey || record.checkpointKey === opts.checkpointKey)
      )
      .slice(0, opts.runsPerProvider)
    records.push(...prior)
    completedByProvider.set(key, prior.length)
  }

  const total = opts.providers.length * opts.runsPerProvider
  for (const spec of opts.providers) {
    const key = keyFor(spec.name, spec.model)
    const completed = completedByProvider.get(key) ?? 0
    for (let i = completed; i < opts.runsPerProvider; i++) {
      if (opts.signal?.aborted) break
      const record = await runOnce(spec, strategy, opts)
      records.push(record)
      opts.onRecord?.(record)
      opts.onProgress?.({ completed: records.length, total, record })
    }
  }
  return { records, readout: summarize(records) }
}
