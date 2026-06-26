import { Settings } from '../types/models'
import { getEntries, MemoryEntry } from './memoryStore'
import { estimateTokens } from './promptBuilder'

/**
 * Memory READER (docs/episodic-memory-design.md §8). Before a turn, select the relevant memories
 * and format them into a tail block. Handles `stream` collections with `keyword` ranking (events,
 * relevance-ranked) and `entity` collections with `always` recall (characters/locations, included
 * when the entity is in scope this turn). vector/hybrid/llm modes are deferred. The selection /
 * formatting helpers are pure and unit-tested; only the `getEntries` read touches the DB.
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

/**
 * Choose up to `count` memories from a stream collection, reserving slots so recall feels
 * intentional: pinned (all) → most-recent → keyword-ranked. `entries` must be newest-first.
 * Pure — no DB.
 */
export const selectFromEntries = (
  entries: MemoryEntry[],
  scanText: string,
  count: number,
  tokenBudget: number
): MemoryEntry[] => {
  const chosen: MemoryEntry[] = []
  const seen = new Set<string>()
  const take = (e: MemoryEntry): void => {
    if (!seen.has(e.id)) {
      seen.add(e.id)
      chosen.push(e)
    }
  }

  // 1. pinned (user/card override — always present)
  for (const e of entries) if (e.pinned) take(e)
  // 2. most-recent (entries are newest-first)
  for (const e of entries.slice(0, RECENT_SLOTS)) take(e)
  // 3. keyword-ranked (score desc, then salience desc; recency is the stable-sort tiebreak)
  const ranked = entries
    .map((e) => ({ e, score: keywordScore(e, scanText) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.salience - a.e.salience)
  for (const { e } of ranked) take(e)

  return trimToBudget(chosen.slice(0, Math.max(0, count)), tokenBudget)
}

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
 * Select recalled-memory text for this turn across all enabled collections, plus the chosen
 * rows (for logging). Returns an empty block when memory is off or nothing matches.
 */
export const selectMemories = (
  profileId: string,
  chatId: string,
  scanText: string,
  settings: Settings
): { block: string; rows: MemoryEntry[] } => {
  const mem = settings.memory
  if (!mem?.enabled) return { block: '', rows: [] }

  const blocks: string[] = []
  const rows: MemoryEntry[] = []
  const maxTokens = mem.max_tokens || 0
  let used = 0
  for (const coll of mem.collections) {
    if (!coll.enabled) continue
    const isStream = coll.shape === 'stream' && coll.retrieval.mode === 'keyword'
    const isEntity = coll.shape === 'entity' && coll.retrieval.mode === 'always'
    if (!isStream && !isEntity) continue // vector / hybrid / llm — deferred (no read)

    const entries = getEntries(profileId, chatId, coll.id)
    if (!entries.length) continue
    const { count, tokenBudget } = coll.retrieval
    const chosen = isStream
      ? selectFromEntries(entries, scanText, count, tokenBudget)
      : selectEntitiesInScope(entries, scanText, count, tokenBudget)
    const block = isStream
      ? formatBlock(coll.inject.label, chosen)
      : formatEntityBlock(coll.inject.label, chosen)
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
