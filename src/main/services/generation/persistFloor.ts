import { appendFloor } from '../chatService'
import { saveGlobals } from '../templateService'
import { saveExecutionRecord } from '../executionRecordStore'
import { resolveExecutionRecordRetention } from '../settingsService'
import { ChatMessage } from '../promptBuilder'
import { RPEvent } from '../../parsers/contentParser'
import { FloorMetrics } from '../../../shared/usageTypes'
import { FloorFile, YuzuGateTrace } from '../../types/chat'
import { GenContext } from './types'

/**
 * Persist this turn's globals + the finished floor. Moved verbatim out of `generate()`
 * (Phase 2b-1a): saves the running globals, builds the `FloorFile` (lossless response,
 * the full request, parsed events, folded variables, cache metrics), appends it, and
 * returns it.
 */
export const persistFloor = (
  ctx: GenContext,
  args: {
    userAction: string
    raw: string
    sendMessages: ChatMessage[]
    events: RPEvent[]
    variables: Record<string, unknown>
    metrics: FloorMetrics
    /** Optional display-only plot block (plot-recall data layer); persisted only when present. */
    plot_block?: string
    /** Project Yuzu WP-S2 (ADR 0009 §3): the VN acceptance-gate trace; persisted only for VN floors. */
    yuzu_trace?: YuzuGateTrace
  }
): FloorFile => {
  saveGlobals(ctx.profileId, ctx.globals)

  const now = new Date().toISOString()
  const floor: FloorFile = {
    floor: ctx.chat.floor_count,
    chat_id: ctx.chatId,
    timestamp: now,
    user_message: { content: args.userAction, timestamp: now },
    // Lossless: the complete AI output (incl. <thinking>, <UpdateVariable>, etc.) is stored.
    response: {
      content: args.raw,
      model: ctx.settings.api.model,
      provider: ctx.settings.api.provider
    },
    // The complete prompt that produced it, for full-fidelity inspection/replay.
    request: args.sendMessages,
    events: args.events,
    variables: args.variables,
    metrics: args.metrics,
    // Display-only (plot-recall data layer): stored losslessly only when recall produced one.
    ...(args.plot_block ? { plot_block: args.plot_block } : {}),
    // Project Yuzu (ADR 0009 §3): the acceptance-gate trace, stored only for VN floors (absent → the field
    // is not written, so classic floors stay byte-identical).
    ...(args.yuzu_trace ? { yuzu_trace: args.yuzu_trace } : {})
  }

  appendFloor(ctx.profileId, ctx.chatId, floor)

  // Persist the forensic Execution Record for this generation (issue 09). The assemble stage stamped it
  // onto the shared `gen`; it is stored WITHOUT its `wire` (that duplicates the floor's `request` just
  // written above — executionRecordStore rehydrates it on read) and pruned to the rolling retention
  // window (settings.records.retention, default 50). Best-effort: a graph whose assemble→write path
  // doesn't share `gen` leaves this undefined and simply persists no record.
  if (ctx.executionRecord) {
    saveExecutionRecord(
      ctx.chatId,
      floor.floor,
      ctx.executionRecord,
      resolveExecutionRecordRetention(ctx.settings)
    )
  }

  return floor
}
