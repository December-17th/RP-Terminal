import { callModel } from './callModel'
import { GenContext } from './types'
import { ChatMessage } from '../promptBuilder'
import { PresetParameters } from '../../types/preset'
import { DeltaCallback } from '../apiService'
import { NodeRunFailure } from '../nodes/types'
import { log } from '../logService'

/**
 * Spec §10 failure-handling primitives around one model call, applied in the spec's order:
 *  1. auto-retry (fixed delay) — class A (request never went through); honors 429 via the RPM queue
 *  2. fallback connection      — a second api_preset tried after the primary's attempts exhaust
 *  3. validator + corrective   — class B (bad output); re-asks with the failure injected as a nudge
 * Give-up throws NodeRunFailure carrying the class + burned attempts, which the engine routes on
 * the node's `error` port (wired) or surfaces as the turn's failure (unwired).
 *
 * With an empty config this is exactly one `callModel` call — the default graph's behavior is
 * unchanged. An abort (user Stop) is never retried: it returns null immediately, like callModel.
 */
export interface ResilienceConfig {
  /** Max auto-retries per connection after the first attempt (default 0 = off). */
  retries?: number
  /** Fixed wait before each retry, in SECONDS (owner-specified semantics: "try again after
   *  X seconds, at most X times"). Default 5s. */
  retry_delay_s?: number
  /** api_preset id tried (with the same budgets) after the primary connection gives up. */
  fallback_preset_id?: string
  /** Output check; a failure triggers the corrective retry, then a class-B give-up. */
  validator?: 'none' | 'non_empty' | 'regex' | 'json'
  /** Regex source for validator: 'regex' (dotall). */
  validator_pattern?: string
  /** Corrective re-asks per connection when the validator fails (default 1). */
  validator_retries?: number
  /** Custom nudge text; the validation error is appended either way. */
  corrective_nudge?: string
}

type CallResult = { raw: string; rawUsage: unknown; stopped: boolean }

const DEFAULT_RETRY_DELAY_S = 5
const DEFAULT_NUDGE =
  'Your previous reply failed validation. Reply again and satisfy the required format exactly.'

/** Abort-aware sleep: resolves early on abort so the next callModel sees the aborted signal. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Tolerant JSON check: plain parse, then a ```json fence, then the outermost {…}/[…] slice. */
const parsesAsJson = (raw: string): boolean => {
  const tryParse = (s: string): boolean => {
    try {
      JSON.parse(s)
      return true
    } catch {
      return false
    }
  }
  const t = raw.trim()
  if (!t) return false
  if (tryParse(t)) return true
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && tryParse(fence[1].trim())) return true
  const start = t.search(/[[{]/)
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  return start !== -1 && end > start && tryParse(t.slice(start, end + 1))
}

type Verdict = { ok: true } | { ok: false; reason: string }

export const validateOutput = (raw: string, cfg: ResilienceConfig): Verdict => {
  switch (cfg.validator) {
    case undefined:
    case 'none':
      return { ok: true }
    case 'non_empty':
      return raw.trim() ? { ok: true } : { ok: false, reason: 'output is empty' }
    case 'regex': {
      let re: RegExp
      try {
        re = new RegExp(cfg.validator_pattern ?? '', 's')
      } catch {
        return { ok: false, reason: `invalid validator pattern: ${cfg.validator_pattern}` }
      }
      return re.test(raw)
        ? { ok: true }
        : { ok: false, reason: `output does not match /${cfg.validator_pattern}/` }
    }
    case 'json':
      return parsesAsJson(raw) ? { ok: true } : { ok: false, reason: 'output is not valid JSON' }
  }
}

/** The corrective re-ask: the failed reply echoed as the assistant turn + the nudge as a user turn
 *  (keeps role alternation provider-correct; mirrors the memory system's self-correcting writes). */
const correctiveMessages = (
  base: ChatMessage[],
  failedRaw: string,
  reason: string,
  cfg: ResilienceConfig
): ChatMessage[] => [
  ...base,
  { role: 'assistant', content: failedRaw },
  {
    role: 'user',
    content: `${cfg.corrective_nudge?.trim() || DEFAULT_NUDGE}\n\nValidation error: ${reason}`
  }
]

/** A GenContext whose live connection is the given saved preset (rpm_limit included). */
const withPreset = (gen: GenContext, presetId: string): GenContext | null => {
  const p = gen.settings.api_presets.find((x) => x.id === presetId)
  if (!p) return null
  return {
    ...gen,
    settings: {
      ...gen.settings,
      api: {
        provider: p.provider,
        endpoint: p.endpoint,
        api_key: p.api_key,
        model: p.model,
        rpm_limit: p.rpm_limit
      }
    }
  }
}

export const callModelResilient = async (
  gen: GenContext,
  sendMessages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal: AbortSignal,
  cfg: ResilienceConfig = {}
): Promise<CallResult | null> => {
  const maxA = 1 + Math.max(0, cfg.retries ?? 0)
  const vBudget = Math.max(0, cfg.validator_retries ?? 1)
  const retryDelayMs = Math.max(0, cfg.retry_delay_s ?? DEFAULT_RETRY_DELAY_S) * 1000

  const connections: GenContext[] = [gen]
  if (cfg.fallback_preset_id) {
    const fb = withPreset(gen, cfg.fallback_preset_id)
    if (fb) connections.push(fb)
    else log('error', `resilientCall: fallback preset '${cfg.fallback_preset_id}' not found`)
  }

  // Retry attempts stream live ONLY while nothing has reached the chat yet — once partial text
  // has streamed, later attempts fill silently and the final text lands via the committed floor
  // (no duplicated prose in the live view).
  let streamedChars = 0
  const liveDelta: DeltaCallback = (d) => {
    streamedChars += d.length
    onDelta(d)
  }
  const silent: DeltaCallback = () => {}
  const deltaSink = (): DeltaCallback => (streamedChars > 0 ? silent : liveDelta)

  let attempts = 0
  let lastError: unknown

  for (const conn of connections) {
    for (let a = 0; a < maxA; a++) {
      if (attempts > 0) await sleep(retryDelayMs, signal) // fixed X-second wait before each retry
      attempts++
      let result: CallResult | null
      try {
        result = await callModel(conn, sendMessages, params, deltaSink(), signal)
      } catch (err) {
        lastError = err // class A — retry (this connection, then the fallback)
        continue
      }
      if (result === null) return null // user Stop with nothing to keep — never retried

      // Class B: validate, then corrective re-asks against this same connection.
      let verdict = validateOutput(result.raw, cfg)
      let correctiveThrew = false
      for (let v = 0; !verdict.ok && v < vBudget; v++) {
        attempts++
        try {
          const again = await callModel(
            conn,
            correctiveMessages(sendMessages, result.raw, verdict.reason, cfg),
            params,
            silent, // full text already produced once; corrections never re-stream
            signal
          )
          if (again === null) return null
          result = again
          verdict = validateOutput(result.raw, cfg)
        } catch (err) {
          lastError = err
          correctiveThrew = true
          break
        }
      }
      if (verdict.ok) return result
      if (correctiveThrew) continue // the correction died as class A — spend this connection's retry budget
      // Validator genuinely exhausted here — move to the fallback connection (or give up).
      lastError = new NodeRunFailure(
        'B',
        `validator (${cfg.validator}) failed: ${verdict.reason}`,
        attempts,
        'validator'
      )
      break
    }
  }

  if (lastError instanceof NodeRunFailure) {
    lastError.attempts = attempts
    throw lastError
  }
  throw new NodeRunFailure(
    'A',
    lastError instanceof Error ? lastError.message : String(lastError ?? 'model call failed'),
    attempts
  )
}
