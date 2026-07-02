import { z } from 'zod'
import {
  compactionDue,
  extractCompaction,
  writeCompaction,
  tryBeginCompaction,
  endCompaction,
  CompactionBatch,
  ParsedCompaction
} from '../../compactionService'
import { getEntries } from '../../memoryStore'
import {
  selectFromEntries,
  formatBlock,
  selectEntitiesInScope,
  formatEntityBlock
} from '../../retrievalService'
import { MemoryCollection } from '../../../types/models'
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

const queryConfig = z.object({
  count: z.number().int().min(1).max(20).optional(),
  token_budget: z.number().int().min(50).max(4000).optional(),
  collections: z.string().optional()
})

/** Which collections `memory.query` reads: mirrors `selectMemories`'s predicates
 *  (`retrievalService.ts` ~189-196) — `stream` collections ranked keyword/vector/hybrid (v1
 *  DOWNGRADES vector/hybrid to keyword ranking here; this node never embeds) and `entity`
 *  collections with `mode: 'always'`. Anything else (notably `mode: 'llm'`) is skipped
 *  entirely, exactly like the standard recall. */
const isQueryable = (c: MemoryCollection): boolean =>
  (c.shape === 'stream' && ['keyword', 'vector', 'hybrid'].includes(c.retrieval.mode)) ||
  (c.shape === 'entity' && c.retrieval.mode === 'always')

/** Recalls memories against an ARBITRARY wired query (a planner's question, a side job's
 *  topic) instead of the current turn's chat scan — the query-driven counterpart to the
 *  standard per-turn recall (`memory.recall`/`selectMemories`). Deliberately keyword-ranking
 *  only in v1: no query embedding, so vector/hybrid stream collections are downgraded to
 *  keyword. Custom-prompt reranking is just another authored branch — wire `rows`/`block` into
 *  `prompt.messages` → `llm.sample` (components-not-features).
 *  A blank/whitespace query returns empty outputs WITHOUT touching the store (no `getEntries`
 *  call) — the same "nothing to recall" contract memory.recall gives an empty scan text.
 *  `count`/`token_budget` are PER COLLECTION, matching selectMemories' semantics. `collections`
 *  (comma-separated ids) narrows which collections are read; unset reads every `c.enabled`
 *  collection (still subject to the mode filter above). */
export const memoryQuery: NodeImpl = {
  type: 'memory.query',
  title: 'Query Memories',
  inputs: [
    { name: 'gen', type: 'Context' },
    { name: 'query', type: 'Text' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'block', type: 'Text' },
    { name: 'rows', type: 'Any' }
  ],
  configSchema: queryConfig,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof queryConfig>
    const query = typeof inputs.query === 'string' ? inputs.query : ''
    if (!query.trim()) return { outputs: { block: '', rows: [] } }
    const gen = inputs.gen as GenContext
    const count = cfg.count ?? 5
    const tokenBudget = cfg.token_budget ?? 600
    const ids = cfg.collections
      ? cfg.collections
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null
    const all = gen.settings.memory?.collections ?? []
    const selected = (
      ids ? all.filter((c) => ids.includes(c.id)) : all.filter((c) => c.enabled)
    ).filter(isQueryable)

    const blocks: string[] = []
    const rows: unknown[] = []
    for (const coll of selected) {
      const entries = getEntries(gen.profileId, gen.chatId, coll.id)
      let chosen: ReturnType<typeof selectFromEntries>
      let block: string
      if (coll.shape === 'entity') {
        chosen = selectEntitiesInScope(entries, query, count, tokenBudget)
        block = formatEntityBlock(coll.inject.label, chosen)
      } else {
        chosen = selectFromEntries(entries, query, count, tokenBudget)
        block = formatBlock(coll.inject.label, chosen)
      }
      if (!block) continue
      blocks.push(block)
      rows.push(...chosen)
    }
    return { outputs: { block: blocks.join('\n\n'), rows } }
  }
}
