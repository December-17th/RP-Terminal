import { getSettings } from './settingsService'
import { getActivePreset } from './presetService'
import { getChat, getMemoryState, setMemoryState } from './chatService'
import { getAllFloors } from './floorService'
import { appendEntries, NewMemory } from './memoryStore'
import { streamProvider } from './apiService'
import { ChatMessage } from './promptBuilder'
import { stripThinking } from '../parsers/contentParser'
import { FloorFile } from '../types/chat'
import { log } from './logService'

/**
 * Memory WRITER (docs/episodic-memory-design.md §7). At a turn-count checkpoint, fold the
 * oldest floors that have aged past the verbatim `keep_recent` window into `events` memories
 * via a cheap utility-model call. Runs OFF the hot path (after the floor is persisted) and is
 * FAIL-OPEN — any failure leaves history verbatim and is retried next turn. The scheduling /
 * parsing helpers are pure and unit-tested; only the LLM call + DB I/O are side-effecting.
 */

/** A memory as parsed from the utility model's JSON reply. */
export interface ParsedMemory {
  summary: string
  keywords: string[]
  salience: number
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * The half-open floor range [start, end) to compact this checkpoint, or null if there isn't
 * yet a full `checkpointTurns` batch of floors past the `keepRecent` verbatim window. Pure.
 */
export const compactionRange = (
  floorCount: number,
  lastCompacted: number,
  keepRecent: number,
  checkpointTurns: number
): { start: number; end: number } | null => {
  const start = lastCompacted + 1
  const end = floorCount - keepRecent
  if (end - start < checkpointTurns) return null
  return { start, end }
}

/** Pull the JSON body out of a model reply (tolerates ```json fences / surrounding prose). */
const extractJson = (raw: string): string | null => {
  if (!raw) return null
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : raw
  const start = body.search(/[[{]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

/**
 * Parse the utility model's reply into validated memories. Accepts `{"memories":[…]}` or a bare
 * array; drops entries without a non-empty summary; clamps salience to [0,1]. Returns [] on any
 * parse failure (caller treats that as "defer"). Pure.
 */
export const parseMemories = (raw: string): ParsedMemory[] => {
  const json = extractJson(raw)
  if (!json) return []
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    return []
  }
  const arr: unknown[] = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { memories?: unknown[] })?.memories)
      ? (obj as { memories: unknown[] }).memories
      : []
  const out: ParsedMemory[] = []
  for (const item of arr) {
    const m = item as { summary?: unknown; keywords?: unknown; salience?: unknown }
    if (typeof m?.summary !== 'string' || !m.summary.trim()) continue
    out.push({
      summary: m.summary.trim(),
      keywords: Array.isArray(m.keywords)
        ? m.keywords.filter((k): k is string => typeof k === 'string')
        : [],
      salience: typeof m.salience === 'number' ? clamp01(m.salience) : 1
    })
  }
  return out
}

/** Render floors as a plain transcript for the summarizer (thinking stripped, blanks skipped). Pure. */
export const floorsToTranscript = (floors: FloorFile[]): string =>
  floors
    .map((f) => {
      const u = (f.user_message?.content || '').trim()
      const a = stripThinking(f.response?.content || '').trim()
      return [u ? `User: ${u}` : '', a ? `Assistant: ${a}` : ''].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n\n')

/**
 * One-shot completion on the memory utility connection (`memory.utility_api_preset_id`, falling
 * back to the active connection). Non-streaming; sampler params ride the active preset.
 */
export const utilityComplete = async (
  profileId: string,
  opts: { system?: string; user: string; maxTokens?: number }
): Promise<string> => {
  const settings = getSettings(profileId)
  const presetId = settings.memory?.utility_api_preset_id
  const conn = presetId ? settings.api_presets.find((p) => p.id === presetId) : undefined
  const apiSettings = conn
    ? {
        ...settings,
        api: {
          provider: conn.provider,
          endpoint: conn.endpoint,
          api_key: conn.api_key,
          model: conn.model
        }
      }
    : settings

  const messages: ChatMessage[] = []
  if (opts.system) messages.push({ role: 'system', content: opts.system })
  messages.push({ role: 'user', content: opts.user })

  const params = {
    ...getActivePreset(profileId).parameters,
    temperature: 0.3,
    max_tokens: opts.maxTokens ?? 800
  }
  return streamProvider(apiSettings, messages, params, () => {})
}

/**
 * Compact aged-out floors into `events` memories if a checkpoint is due. Safe to call after every
 * turn — a no-op when memory is off, the collection is absent, or no full batch has aged out.
 * Never throws (fail-open): summarization failures are logged and retried next turn.
 */
export const maybeCompact = async (profileId: string, chatId: string): Promise<void> => {
  try {
    const settings = getSettings(profileId)
    const mem = settings.memory
    if (!mem?.enabled) return
    // Core: the single `events` stream collection on a checkpoint trigger. Multiple stream
    // collections would each need their own pointer — deferred.
    const coll = mem.collections.find(
      (c) => c.enabled && c.shape === 'stream' && c.write.trigger === 'checkpoint'
    )
    if (!coll) return

    const chat = getChat(profileId, chatId)
    if (!chat) return
    const state = getMemoryState(profileId, chatId)
    const range = compactionRange(
      chat.floor_count,
      state.last_compacted_floor,
      mem.keep_recent,
      mem.checkpoint_turns
    )
    if (!range) return

    const floors = getAllFloors(profileId, chatId, chat.floor_count).filter(
      (f) => f.floor >= range.start && f.floor < range.end
    )
    if (!floors.length) return

    let reply: string
    try {
      reply = await utilityComplete(profileId, {
        system: coll.write.prompt,
        user: floorsToTranscript(floors),
        maxTokens: coll.write.maxItemsPerCheckpoint ? coll.write.maxItemsPerCheckpoint * 120 : 800
      })
    } catch (err) {
      log('info', `memory: compaction deferred (utility call failed: ${errMsg(err)})`)
      return
    }

    const memories = parseMemories(reply)
    if (!memories.length) {
      log('info', 'memory: compaction produced no parseable memories (deferred)')
      return
    }

    const turnStart = floors[0].floor
    const turnEnd = floors[floors.length - 1].floor
    const rows: NewMemory[] = memories.map((m) => ({ ...m, turnStart, turnEnd }))
    appendEntries(profileId, chatId, coll.id, rows)
    setMemoryState(profileId, chatId, { last_compacted_floor: turnEnd })
    log('info', `memory: compacted floors ${turnStart}–${turnEnd} → ${memories.length} event(s)`)
  } catch (err) {
    // Last-resort guard: memory work must never break a turn.
    log('error', `memory: compaction error — ${errMsg(err)}`)
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
