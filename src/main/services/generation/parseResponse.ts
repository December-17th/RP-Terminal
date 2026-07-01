import { parseContent, stripThinking } from '../../parsers/contentParser'
import { parseMvuCommands } from '../../parsers/mvuParser'
import { buildFloorMetrics, normalizeUsage } from '../promptCacheMetrics'
import { ChatMessage } from '../promptBuilder'
import { log } from '../logService'
import { FloorMetrics } from '../../../shared/usageTypes'
import { GenContext } from './types'

/**
 * Post-process the raw model response into cleaned text + parsed rpt-events + MVU commands/patches.
 * Moved verbatim out of `generate()` (Phase 2b-1a). The FULL raw response is stored (lossless) —
 * reasoning/state strips + display regex are applied at VIEW time, never baked into storage. We only
 * clean a COPY here to drive state extraction (drop <thinking> first so a stray "<UpdateVariable>"
 * mention in the reasoning can't make the MVU stripper eat the narrative).
 */
export const parseResponse = (
  raw: string
): {
  cleaned: string
  parsed: ReturnType<typeof parseContent>
  mvu: ReturnType<typeof parseMvuCommands>
} => {
  const cleaned = stripThinking(raw)
  const parsed = parseContent(cleaned)
  // MVU (Track R): parse <UpdateVariable> commands into stat_data, recording this turn's
  // deltas. Reads the cleaned copy for extraction only — the FULL response is what's stored.
  const mvu = parseMvuCommands(parsed.text)
  return { cleaned, parsed, mvu }
}

/**
 * Cache meter: compute this turn's metrics (proxy + provider usage) + the cumulative snapshot,
 * chaining from the previous floor (its stored `request` is the proxy anchor; its cumulative is
 * the prior tally). Moved verbatim out of `generate()` (Phase 2b-1a); persisted on the floor by
 * the caller, both UI surfaces derive from it.
 */
export const computeMetrics = (
  ctx: GenContext,
  sendMessages: ChatMessage[],
  raw: string,
  rawUsage: unknown
): FloorMetrics => {
  const turnMetrics = buildFloorMetrics({
    messages: sendMessages,
    prevMessages: (ctx.lastFloor?.request as ChatMessage[] | undefined) ?? null,
    usage: normalizeUsage(ctx.settings.api.provider, rawUsage),
    provider: ctx.settings.api.provider,
    model: ctx.settings.api.model,
    cacheLevel: ctx.cacheLevel,
    l1Mode: ctx.l1Mode,
    ts: new Date().toISOString(),
    responseText: raw,
    prevCumulative: ctx.lastFloor?.metrics?.cumulative ?? null
  })
  log(
    'info',
    `cache — stable prefix ${turnMetrics.turn.proxyTokens}/${turnMetrics.turn.promptTokens} tok (${Math.round(turnMetrics.turn.proxyPct)}%)`
  )
  return turnMetrics
}
