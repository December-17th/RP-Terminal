import { selectMemories } from '../retrievalService'
import { notifyMemoryRecalled } from '../memoryEvents'
import { log } from '../logService'
import { MemoryEntry } from '../memoryStore'
import { GenContext } from './types'

/**
 * Episodic memory (docs/episodic-memory-design.md §8): recall relevant past memories into the
 * ephemeral tail. No-op when memory is disabled; at cache level 0 it just adds tail context.
 * Fail-open like the writer — a retrieval error must never break a turn; we just skip the block.
 * Moved verbatim out of `generate()` (Phase 2b-1a) — same service calls, same behavior.
 */
export const recallMemory = async (
  ctx: GenContext
): Promise<{ block: string; rows: MemoryEntry[] }> => {
  const memory = await selectMemories(ctx.profileId, ctx.chatId, ctx.scanText, ctx.settings).catch(
    (err) => {
      log('error', `memory: recall failed, continuing without it — ${err?.message || String(err)}`)
      return { block: '', rows: [] }
    }
  )
  if (memory.rows.length) {
    log('info', `memory: ${memory.rows.length} recalled (${memory.block.length} chars) → tail`)
  }
  // Tell the Memory view which memories this turn pulled in (transient "why recalled" highlight).
  if (ctx.settings.memory?.enabled) {
    notifyMemoryRecalled(
      ctx.chatId,
      memory.rows.map((r) => r.id)
    )
  }
  return memory
}
