import {
  compactionDue,
  extractCompaction,
  writeCompaction,
  tryBeginCompaction,
  endCompaction,
  CompactionBatch,
  ParsedCompaction
} from '../../compactionService'
import { GenContext } from '../../generation/types'
import { NodeImpl, NodeRunFailure } from '../types'

/**
 * Decomposed memory-compaction nodes (spec D5): `memory.gate` → `memory.extract` →
 * `memory.write`, wrapping the same stage functions `maybeCompact` composes — so the coarse
 * `memory.compact` node and this chain behave identically, but the chain is authorable and its
 * failures are wire-able (spec §6 reference error wiring: extract/write errors → util.log).
 *
 * Serialization: the gate claims the per-chat compaction slot when it fires; the write stage
 * (or a failing extract) releases it. A chain that dies in between self-heals via the guard's
 * 2-minute expiry — worst case one skipped checkpoint, never a lockout.
 */

/** Fires `due` (+ emits the batch) when a full checkpoint batch has aged out (spec D5). */
export const memoryGate: NodeImpl = {
  type: 'memory.gate',
  title: 'Memory Gate',
  inputs: [
    { name: 'gen', type: 'Context' },
    // Ordering only: wired from output.writeFloor so the gate reads the floor count AFTER the
    // turn is persisted (same contract the coarse memory.compact carries).
    { name: 'floor', type: 'Any' }
  ],
  outputs: [
    { name: 'due', type: 'Signal' },
    { name: 'batch', type: 'Any' }
  ],
  run: (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    if (!tryBeginCompaction(gen.chatId)) return { outputs: {} } // another compaction in flight
    const batch = compactionDue(gen.profileId, gen.chatId)
    if (!batch) {
      endCompaction(gen.chatId) // nothing due — release immediately
      return { outputs: {} }
    }
    return { outputs: { batch }, signals: ['due'] }
  }
}

/** One structured utility-LLM extraction over the gated batch. Fails onto its error port; an
 *  unparseable reply is a soft class-B failure (pointer untouched — the batch retries next
 *  checkpoint, exactly like maybeCompact's defer). */
export const memoryExtract: NodeImpl = {
  type: 'memory.extract',
  title: 'Extract Memories',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'batch', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'memories', type: 'Any' },
    { name: 'batch', type: 'Any' },
    // Gates memory.write: fires only on a usable extraction, so a routed error (or a skip)
    // can never reach the write stage with undefined data.
    { name: 'done', type: 'Signal' },
    { name: 'error', type: 'Error' }
  ],
  run: async (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    const batch = inputs.batch as CompactionBatch
    let parsed: ParsedCompaction
    try {
      parsed = await extractCompaction(gen.profileId, batch)
    } catch (err) {
      endCompaction(gen.chatId)
      throw new NodeRunFailure(
        'A',
        `memory extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        1
      )
    }
    if (!parsed.parsed) {
      endCompaction(gen.chatId)
      throw new NodeRunFailure('B', 'memory extraction deferred: unparseable reply', 1, 'parse')
    }
    return { outputs: { memories: parsed, batch }, signals: ['done'] }
  }
}

/** Applies the extraction atomically (appends + upserts + pointer advance) and releases the
 *  compaction slot. Runs only when extract fired `done`. */
export const memoryWrite: NodeImpl = {
  type: 'memory.write',
  title: 'Write Memories',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'batch', type: 'Any' },
    { name: 'memories', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'count', type: 'Any' },
    { name: 'error', type: 'Error' }
  ],
  run: async (_ctx, inputs) => {
    const gen = inputs.gen as GenContext
    try {
      const count = await writeCompaction(
        gen.profileId,
        gen.chatId,
        inputs.batch as CompactionBatch,
        inputs.memories as ParsedCompaction
      )
      return { outputs: { count } }
    } finally {
      endCompaction(gen.chatId)
    }
  }
}
