import { transact } from './db'
import { getSettings } from './settingsService'
import { getActivePreset } from './presetService'
import { getChat, getMemoryState, setMemoryState } from './chatService'
import { getAllFloors } from './floorService'
import {
  appendEntries,
  getEntries,
  getEntity,
  upsertEntity,
  mergeEntitySheet,
  resolveEntityKey
} from './memoryStore'
import { streamProvider } from './apiService'
import { stripThinking } from '../parsers/contentParser'
import { notifyMemoryChanged } from './memoryEvents'
import { log } from './logService'
import type { EntitySheet } from './memoryStore'
import type { ChatMessage } from './promptBuilder'
import type { FloorFile } from '../types/chat'
import type { MemoryCollection } from '../types/models'

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

const parseMemoryItem = (item: unknown): ParsedMemory | null => {
  const m = item as { summary?: unknown; keywords?: unknown; salience?: unknown }
  if (typeof m?.summary !== 'string' || !m.summary.trim()) return null
  return {
    summary: m.summary.trim(),
    keywords: Array.isArray(m.keywords)
      ? m.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    salience: typeof m.salience === 'number' ? clamp01(m.salience) : 1
  }
}

/**
 * Parse a stream reply into validated memories. Accepts `{"memories":[…]}` or a bare array; drops
 * entries without a non-empty summary; clamps salience to [0,1]. Returns [] on parse failure. Pure.
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
  return arr.map(parseMemoryItem).filter((x): x is ParsedMemory => x !== null)
}

/** An entity update parsed from the structured reply (a character / location). */
export interface ParsedEntity {
  name: string
  aliases: string[]
  fields: Record<string, string>
  note: string
}

const parseEntityItem = (item: unknown): ParsedEntity | null => {
  const e = item as { name?: unknown; aliases?: unknown; fields?: unknown; note?: unknown }
  if (typeof e?.name !== 'string' || !e.name.trim()) return null
  const fields: Record<string, string> = {}
  if (e.fields && typeof e.fields === 'object') {
    for (const [k, v] of Object.entries(e.fields as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) fields[k] = v.trim()
      else if (typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v)
    }
  }
  return {
    name: e.name.trim(),
    aliases: Array.isArray(e.aliases)
      ? e.aliases.filter((a): a is string => typeof a === 'string')
      : [],
    fields,
    note: typeof e.note === 'string' ? e.note.trim() : ''
  }
}

/** The structured extraction result, keyed by collection id (stream items vs entity updates). */
export interface ParsedCompaction {
  streams: Record<string, ParsedMemory[]>
  entities: Record<string, ParsedEntity[]>
}

/**
 * Parse the combined extraction reply into per-collection items (stream memories / entity updates),
 * keyed by collection id. Tolerant — unknown keys ignored, malformed items dropped. Pure.
 */
export const parseCompaction = (raw: string, collections: MemoryCollection[]): ParsedCompaction => {
  const out: ParsedCompaction = { streams: {}, entities: {} }
  const json = extractJson(raw)
  if (!json) return out
  let obj: Record<string, unknown>
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    obj = parsed as Record<string, unknown>
  } catch {
    return out
  }
  for (const c of collections) {
    const arr = Array.isArray(obj[c.id]) ? (obj[c.id] as unknown[]) : []
    if (c.shape === 'stream') {
      out.streams[c.id] = arr.map(parseMemoryItem).filter((x): x is ParsedMemory => x !== null)
    } else {
      out.entities[c.id] = arr.map(parseEntityItem).filter((x): x is ParsedEntity => x !== null)
    }
  }
  return out
}

/** Build the combined extractor system prompt from the enabled checkpoint collections. Pure. */
export const buildExtractionPrompt = (collections: MemoryCollection[]): string => {
  const lines = [
    'You maintain a roleplay memory store. From the transcript below, extract updates as a single',
    'JSON object and nothing else. Include a key only when it has content. Do NOT restate numeric',
    'stats, inventory, or scores (those are tracked separately).',
    ''
  ]
  for (const c of collections) {
    lines.push(
      c.shape === 'stream'
        ? `"${c.id}": [{"summary": "one sentence", "keywords": ["proper nouns / topics"], "salience": 0.0-1.0}] — ${c.write.prompt}`
        : `"${c.id}": [{"name": "canonical name", "aliases": ["other names used"], "fields": {"<field>": "<value>"}, "note": "what changed this span"}] — ${c.write.prompt}`
    )
  }
  return lines.join('\n')
}

/** A one-line current-state digest of an entity sheet, for the catalogue / injection. Pure. */
export const entitySummary = (sheet: EntitySheet): string => {
  const fields = Object.entries(sheet.fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
  return fields || sheet.log[sheet.log.length - 1]?.note || ''
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
  // Bound the background call so a hung summarizer can't dangle forever (fail-open handles the
  // resulting rejection — the checkpoint just retries next turn).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UTILITY_TIMEOUT_MS)
  try {
    return await streamProvider(apiSettings, messages, params, () => {}, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Hard ceiling for a single background summarizer call. */
const UTILITY_TIMEOUT_MS = 60_000

// Chats with an in-flight compaction. The writer is fire-and-forget (voided after each turn), so a
// rapid next turn could fire a second checkpoint that reads the SAME last_compacted_floor and
// re-summarizes the same range before the first advances the pointer → duplicate memories + a wasted
// utility call. This guard serializes compaction per chat.
const compacting = new Set<string>()

/**
 * Compact aged-out floors into `events` memories if a checkpoint is due. Safe to call after every
 * turn — a no-op when memory is off, the collection is absent, no full batch has aged out, or a
 * compaction is already running for this chat. Never throws (fail-open): summarization failures are
 * logged and retried next turn.
 */
export const maybeCompact = async (profileId: string, chatId: string): Promise<void> => {
  if (compacting.has(chatId)) return
  compacting.add(chatId)
  try {
    const settings = getSettings(profileId)
    const mem = settings.memory
    if (!mem?.enabled) return
    // All enabled checkpoint collections share one pointer + one structured extraction call:
    // stream collections (events) append; entity collections (characters/locations) upsert.
    const colls = mem.collections.filter((c) => c.enabled && c.write.trigger === 'checkpoint')
    if (!colls.length) return

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
        system: buildExtractionPrompt(colls),
        user: floorsToTranscript(floors),
        maxTokens: 1000
      })
    } catch (err) {
      log('info', `memory: compaction deferred (utility call failed: ${errMsg(err)})`)
      return
    }

    const parsed = parseCompaction(reply, colls)
    const turnStart = floors[0].floor
    const turnEnd = floors[floors.length - 1].floor
    const turnLabel = turnStart === turnEnd ? `${turnStart}` : `${turnStart}-${turnEnd}`
    // Apply all writes atomically: event appends + entity upserts + the pointer advance in ONE
    // transaction, so a mid-way failure rolls back fully (no memories written without the pointer
    // moving → no duplicates on the next retry).
    const wrote = transact(() => {
      let n = 0

      // Stream collections (events): append the new memories.
      for (const [id, memories] of Object.entries(parsed.streams)) {
        if (!memories.length) continue
        appendEntries(
          profileId,
          chatId,
          id,
          memories.map((m) => ({ ...m, turnStart, turnEnd }))
        )
        n += memories.length
      }

      // Entity collections (characters/locations): resolve the canonical key (T1), merge the
      // delta into the existing sheet (T2), upsert. Re-read existing each time so multiple updates
      // to one entity in a batch compose correctly.
      for (const [id, ents] of Object.entries(parsed.entities)) {
        for (const ent of ents) {
          const existing = getEntries(profileId, chatId, id).map((e) => ({
            entityKey: e.entityKey ?? '',
            aliases: e.entities
          }))
          const key = resolveEntityKey(ent.name, ent.aliases, existing)
          const current = getEntity(profileId, chatId, id, key)
          const sheet = mergeEntitySheet((current?.payload as EntitySheet | undefined) ?? null, {
            aliases: [ent.name, ...ent.aliases].filter(
              (a) => a.trim().toLowerCase() !== key.trim().toLowerCase()
            ),
            fields: ent.fields,
            note: ent.note,
            turn: turnLabel
          })
          upsertEntity(profileId, chatId, id, key, entitySummary(sheet), sheet)
          n++
        }
      }

      if (n > 0) setMemoryState(profileId, chatId, { last_compacted_floor: turnEnd })
      return n
    })

    if (!wrote) {
      log('info', 'memory: compaction produced no parseable updates (deferred)')
      return
    }

    log('info', `memory: compacted floors ${turnLabel} → ${wrote} update(s)`)
    notifyMemoryChanged(chatId)
  } catch (err) {
    // Last-resort guard: memory work must never break a turn.
    log('error', `memory: compaction error — ${errMsg(err)}`)
  } finally {
    compacting.delete(chatId)
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
