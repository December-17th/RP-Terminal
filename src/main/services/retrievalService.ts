import { Settings } from '../types/models'
import { getEntries, MemoryEntry } from './memoryStore'
import { estimateTokens } from './promptBuilder'
import { utilityEmbed, cosine } from './embeddingService'

/**
 * Memory READER (docs/episodic-memory-design.md §8). Before a turn, select the relevant memories
 * and format them into a tail block. Handles `stream` collections with `keyword` / `vector` /
 * `hybrid` ranking (events) and `entity` collections with `always` recall (characters/locations,
 * included when the entity is in scope this turn). vector/hybrid embed the scan text once per turn
 * and rank by cosine (hybrid fuses with keyword via reciprocal-rank fusion); both fall back to
 * keyword when no embedding connection is set. The ranking/formatting helpers are pure and
 * unit-tested; only the `getEntries` read + the scan-text embed touch the outside world.
 */

/** Reserve a couple of slots for the most-recent memories (continuity across compaction). */
const RECENT_SLOTS = 2

/** Keyword overlap: how many of a memory's keywords appear in the scan text (case-insensitive). */
export const keywordScore = (entry: MemoryEntry, scanText: string): number => {
  if (!entry.keywords.length) return 0
  const hay = scanText.toLowerCase()
  let score = 0
  for (const k of entry.keywords) {
    const kw = k.trim().toLowerCase()
    if (kw && hay.includes(kw)) score++
  }
  return score
}

/** Keep entries until the token budget is reached; always keep at least the first. */
const trimToBudget = (
  entries: MemoryEntry[],
  tokenBudget: number,
  cost: (e: MemoryEntry) => number = (e) => estimateTokens(`- ${e.summary}`)
): MemoryEntry[] => {
  if (tokenBudget <= 0) return entries
  const out: MemoryEntry[] = []
  let used = 0
  for (const e of entries) {
    const c = cost(e)
    if (out.length && used + c > tokenBudget) break
    out.push(e)
    used += c
  }
  return out
}

/** Keyword-relevance order: matched memories by score desc, salience desc (recency stable-tiebreak). Pure. */
export const keywordRanked = (entries: MemoryEntry[], scanText: string): MemoryEntry[] =>
  entries
    .map((e) => ({ e, score: keywordScore(e, scanText) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.salience - a.e.salience)
    .map((x) => x.e)

/** Cosine-similarity order vs the query vector; skips memories without a same-dim embedding. Pure. */
export const vectorRanked = (entries: MemoryEntry[], query: number[]): MemoryEntry[] =>
  entries
    .map((e) => ({ e, score: e.embedding ? cosine(e.embedding, query) : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e)

/** Reciprocal-rank fusion of the keyword and vector orderings (rank-based, no score calibration). Pure. */
export const hybridRanked = (
  entries: MemoryEntry[],
  query: number[],
  scanText: string
): MemoryEntry[] => {
  const K = 60
  const score = new Map<string, number>()
  const fuse = (ranked: MemoryEntry[]): void =>
    ranked.forEach((e, i) => score.set(e.id, (score.get(e.id) ?? 0) + 1 / (K + i)))
  fuse(keywordRanked(entries, scanText))
  fuse(vectorRanked(entries, query))
  const byId = new Map(entries.map((e) => [e.id, e]))
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((e): e is MemoryEntry => !!e)
}

/**
 * Choose up to `count` memories, reserving slots so recall feels intentional: pinned (all) →
 * most-recent → the provided relevance `ranked` order. `entries` must be newest-first. Pure.
 */
export const slotted = (
  entries: MemoryEntry[],
  count: number,
  tokenBudget: number,
  ranked: MemoryEntry[]
): MemoryEntry[] => {
  const chosen: MemoryEntry[] = []
  const seen = new Set<string>()
  const take = (e: MemoryEntry): void => {
    if (!seen.has(e.id)) {
      seen.add(e.id)
      chosen.push(e)
    }
  }
  for (const e of entries) if (e.pinned) take(e) // 1. pinned (always present)
  for (const e of entries.slice(0, RECENT_SLOTS)) take(e) // 2. most-recent (newest-first)
  for (const e of ranked) take(e) // 3. relevance-ranked
  return trimToBudget(chosen.slice(0, Math.max(0, count)), tokenBudget)
}

/** Keyword-mode selection (pinned → recent → keyword-ranked). Pure. */
export const selectFromEntries = (
  entries: MemoryEntry[],
  scanText: string,
  count: number,
  tokenBudget: number
): MemoryEntry[] => slotted(entries, count, tokenBudget, keywordRanked(entries, scanText))

/** Format a collection's chosen memories into a labelled tail block (empty when none). */
export const formatBlock = (label: string, entries: MemoryEntry[]): string => {
  if (!entries.length) return ''
  return `[${label}]\n${entries.map((e) => `- ${e.summary}`).join('\n')}`
}

/** Whether an entity is "in scope" this turn — its key or any alias appears in the scan text. Pure. */
export const entityInScope = (entry: MemoryEntry, scanText: string): boolean => {
  const hay = scanText.toLowerCase()
  return [entry.entityKey ?? '', ...entry.entities].some((n) => {
    const v = n.trim().toLowerCase()
    return v.length > 1 && hay.includes(v)
  })
}

/** Entity records whose entity is mentioned this turn, capped at `count` and the token budget. Pure. */
export const selectEntitiesInScope = (
  entries: MemoryEntry[],
  scanText: string,
  count: number,
  tokenBudget: number
): MemoryEntry[] => {
  const inScope = entries.filter((e) => entityInScope(e, scanText))
  return trimToBudget(inScope.slice(0, Math.max(0, count)), tokenBudget, (e) =>
    estimateTokens(`- ${e.entityKey}: ${e.summary}`)
  )
}

/** Format in-scope entity sheets into a labelled tail block (`name: current-state digest`). Pure. */
export const formatEntityBlock = (label: string, entries: MemoryEntry[]): string => {
  if (!entries.length) return ''
  return `[${label}]\n${entries.map((e) => `- ${e.entityKey}: ${e.summary}`).join('\n')}`
}

/**
 * Select recalled-memory text for this turn across all enabled collections, plus the chosen rows
 * (for logging). Async because vector/hybrid collections embed the scan text once (lazily — keyword
 * and entity recall stay synchronous and pay no embedding cost). Empty when memory is off or nothing
 * matches.
 */
export const selectMemories = async (
  profileId: string,
  chatId: string,
  scanText: string,
  settings: Settings
): Promise<{ block: string; rows: MemoryEntry[] }> => {
  const mem = settings.memory
  if (!mem?.enabled) return { block: '', rows: [] }

  // Lazily embed the scan text the first time a vector/hybrid collection needs it (cached for the
  // rest of this call). null = no embedding connection / embed failed → those collections fall back
  // to keyword.
  let queryVec: number[] | null | undefined
  const queryVector = async (): Promise<number[] | null> => {
    if (queryVec !== undefined) return queryVec
    if (!mem.embedding_api_preset_id) return (queryVec = null)
    try {
      const r = await utilityEmbed(profileId, [scanText])
      queryVec = r?.vectors?.[0] ?? null
    } catch {
      queryVec = null
    }
    return queryVec
  }

  const blocks: string[] = []
  const rows: MemoryEntry[] = []
  const maxTokens = mem.max_tokens || 0
  let used = 0
  for (const coll of mem.collections) {
    if (!coll.enabled) continue
    const mode = coll.retrieval.mode
    const isStream =
      coll.shape === 'stream' && (mode === 'keyword' || mode === 'vector' || mode === 'hybrid')
    const isEntity = coll.shape === 'entity' && mode === 'always'
    if (!isStream && !isEntity) continue // llm — deferred (no read)

    const entries = getEntries(profileId, chatId, coll.id)
    if (!entries.length) continue
    const { count, tokenBudget } = coll.retrieval

    let chosen: MemoryEntry[]
    let block: string
    if (isEntity) {
      chosen = selectEntitiesInScope(entries, scanText, count, tokenBudget)
      block = formatEntityBlock(coll.inject.label, chosen)
    } else {
      const qv = mode === 'keyword' ? null : await queryVector()
      // vector/hybrid with a query vector; otherwise (keyword, or embed unavailable) keyword recall.
      const ranked =
        qv && mode === 'vector'
          ? vectorRanked(entries, qv)
          : qv && mode === 'hybrid'
            ? hybridRanked(entries, qv, scanText)
            : keywordRanked(entries, scanText)
      chosen = slotted(entries, count, tokenBudget, ranked)
      block = formatBlock(coll.inject.label, chosen)
    }
    if (!block) continue

    // Global tail cap: always keep the first block, then stop once max_tokens is reached
    // (collections are ordered by priority — events, characters, locations).
    const cost = estimateTokens(block)
    if (maxTokens > 0 && blocks.length > 0 && used + cost > maxTokens) continue
    blocks.push(block)
    rows.push(...chosen)
    used += cost
  }
  return { block: blocks.join('\n\n'), rows }
}
