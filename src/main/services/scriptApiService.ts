/**
 * Read/CRUD bridge for the card-script + plugin runtime (TH-3): lorebook (worldbook),
 * character card, preset, and regex APIs over the existing services. Permission gating
 * happens in the renderer dispatcher; this layer is pure data access.
 *
 * Clean-room: our own API surface, reimplemented from the public Tavern-Helper docs.
 */
import { getCharacter, getAvatarPath } from './characterService'
import { getChat } from './chatService'
import { getLorebookById, listLorebooks, saveLorebookById } from './lorebookService'
import { getActivePreset, listPresets } from './presetService'
import { getRenderRules, applyRegex } from './regexService'
import { getGrants } from './pluginService'
import { log } from './logService'
import { ScopeContext } from '../../shared/artifactScope'
import { LorebookEntry, LorebookEntrySchema } from '../types/character'

/** card.getData — the active/owning card's `data` block. */
export const getCharData = (
  profileId: string,
  chatId: string,
  cardId?: string
): Record<string, unknown> | null => {
  const id = cardId || getChat(profileId, chatId)?.character_id
  return id ? (getCharacter(profileId, id)?.data ?? null) : null
}

/** card.getAvatarPath — absolute path to the card's avatar PNG (may not exist). */
export const getCharAvatarPath = (
  profileId: string,
  chatId: string,
  cardId?: string
): string | null => {
  const id = cardId || getChat(profileId, chatId)?.character_id
  return id ? getAvatarPath(id) : null
}

// A lorebook id defaults to the active card's own book (id == characterId).
const resolveBookId = (
  profileId: string,
  chatId: string,
  id?: string,
  cardId?: string
): string | null => id || cardId || getChat(profileId, chatId)?.character_id || null

/** worldbook list — { id, name } for every lorebook in the library. */
export const listWorldbooks = (profileId: string): Array<{ id: string; name: string }> =>
  listLorebooks(profileId).map((b) => ({ id: b.id, name: b.name }))

/** worldbook get — a book's entries (defaults to the active card's own book). */
export const getWorldbook = (
  profileId: string,
  chatId: string,
  id?: string,
  cardId?: string
): { id: string; name: string; entries: LorebookEntry[] } | null => {
  const bookId = resolveBookId(profileId, chatId, id, cardId)
  if (!bookId) return null
  const book = getLorebookById(profileId, bookId)
  return book ? { id: bookId, name: book.name, entries: book.entries } : null
}

/** worldbook write — replace a book's entries (TH replaceWorldbookEntries). Untrusted
 *  entry shapes are coerced to valid entries via the Zod schema (defaults fill gaps). */
export const setWorldbookEntries = (
  profileId: string,
  chatId: string,
  id: string | undefined,
  entries: unknown,
  cardId?: string
): boolean => {
  const bookId = resolveBookId(profileId, chatId, id, cardId)
  if (!bookId) return false
  const book = getLorebookById(profileId, bookId)
  if (!book) return false
  const arr = Array.isArray(entries) ? entries : []
  book.entries = arr.map((e) => LorebookEntrySchema.parse(e ?? {}))
  saveLorebookById(profileId, bookId, book)
  return true
}

/** preset.get — the active preset's name + sampler parameters. */
export const getPresetInfo = (
  profileId: string
): { name: string; parameters: Record<string, unknown> } => {
  const p = getActivePreset(profileId)
  return { name: p.name, parameters: p.parameters as Record<string, unknown> }
}

/** preset.list — every preset's name. */
export const listPresetNames = (profileId: string): string[] =>
  listPresets(profileId).map((p) => p.name)

/** regex.format — apply the active display (markdown) regex to an arbitrary string
 *  (TH formatAsTavernRegexedString). */
export const formatWithRegex = (
  profileId: string,
  ctx: ScopeContext | undefined,
  text: unknown,
  macroCtx?: { user?: string; char?: string }
): string => applyRegex(String(text ?? ''), getRenderRules(profileId, ctx), 2, macroCtx || {})

/** regex.list — the active display regex scripts (find/replace summaries). */
export const listRegexes = (
  profileId: string,
  ctx?: ScopeContext
): Array<{ find: string; replace: string }> =>
  getRenderRules(profileId, ctx).map((r) => ({ find: r.source, replace: r.replace }))

/**
 * Host-mediated text fetch for the sandbox `.load()` / remote-UI path. The fetch runs in
 * the main process (Node — no browser CORS/opaque-origin wall), but is gated by the same
 * per-world `remoteScripts` grant the renderer prompts for, and restricted to https +
 * a size cap. This is what lets a frontend card pull its UI from a CDN.
 */
export const fetchRemoteText = async (
  profileId: string,
  cardId: string | undefined,
  url: string
): Promise<string> => {
  if (!cardId) throw new Error('no active world to attach the network grant to')
  if (getGrants(profileId, cardId).remoteScripts !== true) {
    throw new Error('remote loading is not granted for this world')
  }
  const u = String(url)
  if (!/^https:\/\//i.test(u)) throw new Error('only https URLs are allowed')
  const res = await fetch(u, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const text = await res.text()
  if (text.length > 8_000_000) throw new Error('remote response too large (>8MB)')
  log('info', `⚙ remote fetch ok (${text.length} bytes) — ${u}`)
  return text
}
