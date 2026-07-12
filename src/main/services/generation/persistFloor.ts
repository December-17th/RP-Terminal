import { appendFloor } from '../chatService'
import { saveGlobals } from '../templateService'
import { ChatMessage } from '../promptBuilder'
import { RPEvent } from '../../parsers/contentParser'
import { FloorMetrics } from '../../../shared/usageTypes'
import { FloorFile } from '../../types/chat'
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
    ...(args.plot_block ? { plot_block: args.plot_block } : {})
  }

  appendFloor(ctx.profileId, ctx.chatId, floor)
  return floor
}
