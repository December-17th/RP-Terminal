import { streamProvider, DeltaCallback, UsageCallback } from '../apiService'
import { ChatMessage } from '../promptBuilder'
import { PresetParameters } from '../../types/preset'
import { log } from '../logService'
import { GenContext } from './types'

/**
 * Call the provider and classify the outcome. Moved verbatim out of `generate()` (Phase 2b-1a) —
 * same `streamProvider` call, same try/catch, same abort/stopped classification. The
 * `AbortController` lifecycle (creation + `activeControllers` registration) stays in `generate()`
 * (shared with `generateRaw`/`abortGeneration`); this only consumes the signal. Returns `null` for
 * the abort-with-empty-text case (matching the original `return null` paths) so `generate()` can
 * early-return; otherwise returns the raw text + usage + stopped flag.
 */
export const callModel = async (
  ctx: GenContext,
  sendMessages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal: AbortSignal
): Promise<{ raw: string; rawUsage: unknown; stopped: boolean } | null> => {
  let rawUsage: unknown = null
  const onUsage: UsageCallback = (u) => {
    rawUsage = u
  }

  let raw: string
  try {
    raw = await streamProvider(ctx.settings, sendMessages, params, onDelta, signal, onUsage)
  } catch (err: any) {
    if (signal.aborted) {
      log('info', '⏹ generation stopped by user')
      return null
    }
    log('error', `✗ provider call failed`, err?.message || String(err))
    throw err
  }

  const stopped = signal.aborted
  // Stopped with nothing generated: don't persist an empty floor.
  if (stopped && !raw.trim()) {
    log('info', '⏹ generation stopped (no text)')
    return null
  }

  log('response', `← ${raw.length} chars${stopped ? ' (stopped)' : ''}`, raw)

  return { raw, rawUsage, stopped }
}
