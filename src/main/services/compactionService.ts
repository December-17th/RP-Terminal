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
  resolveEntityKey,
  getEmbeddable,
  setEmbedding
} from './memoryStore'
import { utilityEmbed } from './embeddingService'
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
  /**
   * Whether the reply parsed into a JSON object at all. `false` = a soft failure (prose / no JSON
   * body) → the caller defers and retries. `true` even when the object yields zero items ("nothing
   * worth remembering here") → the caller advances the pointer so the floors aren't re-extracted.
   */
  parsed: boolean
  streams: Record<string, ParsedMemory[]>
  entities: Record<string, ParsedEntity[]>
}

/**
 * Parse the combined extraction reply into per-collection items (stream memories / entity updates),
 * keyed by collection id. Tolerant — unknown keys ignored, malformed items dropped. Pure.
 */
export const parseCompaction = (raw: string, collections: MemoryCollection[]): ParsedCompaction => {
  const out: ParsedCompaction = { parsed: false, streams: {}, entities: {} }
  const json = extractJson(raw)
  if (!json) return out
  let obj: Record<string, unknown>
  try {
    const value = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out
    obj = value as Record<string, unknown>
  } catch {
    return out
  }
  out.parsed = true
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
          model: conn.model,
          rpm_limit: conn.rpm_limit,
          max_concurrent: conn.max_concurrent
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
// utility call. This guard serializes compaction per chat. Time-stamped with an expiry so a chain
// that dies between the decomposed nodes (aborted graph, crash) can't lock a chat out forever.
const compacting = new Map<string, number>()
const COMPACTION_GUARD_MS = 120_000 // 2× the utility timeout — a stuck chain self-heals here

/** Claim the per-chat compaction slot; false while another compaction is in flight (unexpired). */
export const tryBeginCompaction = (chatId: string): boolean => {
  const started = compacting.get(chatId)
  if (started !== undefined && Date.now() - started < COMPACTION_GUARD_MS) return false
  compacting.set(chatId, Date.now())
  return true
}

/** Release the per-chat compaction slot (call from the LAST stage — or the failing one). */
export const endCompaction = (chatId: string): void => {
  compacting.delete(chatId)
}

/** Everything one checkpoint processes: the due floor range + the collections extracting from it. */
export interface CompactionBatch {
  colls: MemoryCollection[]
  floors: FloorFile[]
  range: { start: number; end: number }
}

/**
 * GATE stage (workflow spec D5 `memory.gate`): is a checkpoint due for this chat? Returns the
 * batch (collections + the aged-out floors), or null when memory is off / no collection uses
 * checkpoints / no full batch has aged past keep_recent. Pure reads; claims nothing.
 */
export const compactionDue = (profileId: string, chatId: string): CompactionBatch | null => {
  const settings = getSettings(profileId)
  const mem = settings.memory
  if (!mem?.enabled) return null
  // All enabled checkpoint collections share one pointer + one structured extraction call:
  // stream collections (events) append; entity collections (characters/locations) upsert.
  const colls = mem.collections.filter((c) => c.enabled && c.write.trigger === 'checkpoint')
  if (!colls.length) return null

  const chat = getChat(profileId, chatId)
  if (!chat) return null
  const state = getMemoryState(profileId, chatId)
  const range = compactionRange(
    chat.floor_count,
    state.last_compacted_floor,
    mem.keep_recent,
    mem.checkpoint_turns
  )
  if (!range) return null

  const floors = getAllFloors(profileId, chatId, chat.floor_count).filter(
    (f) => f.floor >= range.start && f.floor < range.end
  )
  if (!floors.length) return null
  return { colls, floors, range }
}

/**
 * EXTRACT stage (spec D5 `memory.extract`): one structured utility-LLM call over the batch.
 * Throws on a call failure (the caller decides fail-open vs error-branch); an unparseable reply
 * comes back as `parsed: false` — a soft failure the caller defers WITHOUT advancing the pointer.
 */
export const extractCompaction = async (
  profileId: string,
  batch: CompactionBatch
): Promise<ParsedCompaction> => {
  const reply = await utilityComplete(profileId, {
    system: buildExtractionPrompt(batch.colls),
    user: floorsToTranscript(batch.floors),
    maxTokens: 1000
  })
  return parseCompaction(reply, batch.colls)
}

/**
 * WRITE stage (spec D5 `memory.write`): apply the parsed extraction atomically — event appends +
 * entity upserts + the pointer advance in ONE transaction (a mid-way failure rolls back fully, so
 * no duplicates on the retry) — then notify + embed. Returns how many updates landed.
 */
export const writeCompaction = async (
  profileId: string,
  chatId: string,
  batch: CompactionBatch,
  parsed: ParsedCompaction
): Promise<number> => {
  const { floors } = batch
  const turnStart = floors[0].floor
  const turnEnd = floors[floors.length - 1].floor
  const turnLabel = turnStart === turnEnd ? `${turnStart}` : `${turnStart}-${turnEnd}`
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

    // The reply parsed cleanly, so these floors are processed — advance the pointer even when the
    // model found nothing worth remembering (n === 0). Re-extracting them would just waste calls;
    // a genuine call/parse failure returned earlier without advancing.
    setMemoryState(profileId, chatId, { last_compacted_floor: turnEnd })
    return n
  })

  if (wrote > 0) {
    log('info', `memory: compacted floors ${turnLabel} → ${wrote} update(s)`)
    notifyMemoryChanged(chatId)
    await embedPending(profileId, chatId)
  } else {
    log('info', `memory: floors ${turnLabel} had no extractable updates (pointer advanced)`)
  }
  return wrote
}

/**
 * Compact aged-out floors into `events` memories if a checkpoint is due. Safe to call after every
 * turn — a no-op when memory is off, the collection is absent, no full batch has aged out, or a
 * compaction is already running for this chat. Never throws (fail-open): summarization failures are
 * logged and retried next turn. Composed from the D5 stages above; the decomposed workflow nodes
 * (`memory.gate` / `memory.extract` / `memory.write`) call the same stages.
 */
export const maybeCompact = async (profileId: string, chatId: string): Promise<void> => {
  if (!tryBeginCompaction(chatId)) return
  try {
    const batch = compactionDue(profileId, chatId)
    if (!batch) return

    let parsed: ParsedCompaction
    try {
      parsed = await extractCompaction(profileId, batch)
    } catch (err) {
      log('info', `memory: compaction deferred (utility call failed: ${errMsg(err)})`)
      return
    }
    if (!parsed.parsed) {
      // Unparseable reply (prose / no JSON body) — a soft failure. Leave the floors verbatim and
      // retry next checkpoint; do NOT advance the pointer (that would silently drop these floors).
      log('info', 'memory: compaction deferred (unparseable reply)')
      return
    }
    await writeCompaction(profileId, chatId, batch, parsed)
  } catch (err) {
    // Last-resort guard: memory work must never break a turn.
    log('error', `memory: compaction error — ${errMsg(err)}`)
  } finally {
    endCompaction(chatId)
  }
}

/** Max summaries embedded per collection per pass; the rest catch up on the next compaction. */
const EMBED_BATCH = 64

/**
 * Embed memories in vector/hybrid collections that lack a current-model embedding — background,
 * fail-open. No-op when memory is off or no embedding connection is configured. Also catches up on
 * existing rows (e.g. after the user enables vector mid-session), a batch at a time.
 */
export const embedPending = async (profileId: string, chatId: string): Promise<void> => {
  try {
    const settings = getSettings(profileId)
    const mem = settings.memory
    if (!mem?.enabled) return
    const conn = mem.embedding_api_preset_id
      ? settings.api_presets.find((p) => p.id === mem.embedding_api_preset_id)
      : undefined
    if (!conn) return // vector recall disabled — no embedding connection
    const vectorColls = mem.collections.filter(
      (c) => c.enabled && (c.retrieval.mode === 'vector' || c.retrieval.mode === 'hybrid')
    )
    if (!vectorColls.length) return

    let embedded = 0
    for (const coll of vectorColls) {
      const pending = getEmbeddable(profileId, chatId, coll.id, conn.model).slice(0, EMBED_BATCH)
      if (!pending.length) continue
      const result = await utilityEmbed(
        profileId,
        pending.map((p) => p.summary)
      )
      if (!result) return
      for (let i = 0; i < pending.length; i++) {
        const vec = result.vectors[i]
        if (vec && vec.length) {
          setEmbedding(profileId, chatId, pending[i].id, vec, result.model)
          embedded++
        }
      }
    }
    if (embedded > 0) {
      log('info', `memory: embedded ${embedded} memor${embedded === 1 ? 'y' : 'ies'}`)
      notifyMemoryChanged(chatId)
    }
  } catch (err) {
    log('info', `memory: embedding deferred (${errMsg(err)})`)
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
