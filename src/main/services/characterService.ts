import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir } from './storageService'
import { getDb } from './db'
import { log } from './logService'
import { RPTerminalCard, RPTerminalCardSchema, Lorebook, getRpExt } from '../types/character'
import {
  saveCharacterLorebook,
  deleteCharacterLorebook,
  normalizeLorebookData,
  saveLorebookById,
  getCharacterLorebook
} from './lorebookService'
import * as regexService from './regexService'
import * as scriptService from './scriptService'
import { installBundledPreset } from './presetService'
import { parseStPng } from '../parsers/stPngParser'

const getAvatarsDir = (): string => path.join(getAppDir(), 'avatars')
export const getAvatarPath = (characterId: string): string =>
  path.join(getAvatarsDir(), `${characterId}.png`)

/** The card's avatar PNG as a `data:` URL (for the renderer launcher/img), or null if none. */
export const getAvatarDataUrl = (characterId: string): string | null => {
  try {
    const p = getAvatarPath(characterId)
    if (!fs.existsSync(p)) return null
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')
  } catch {
    return null
  }
}

export const getCharacters = (profileId: string): Array<{ id: string; card: RPTerminalCard }> => {
  const rows = getDb()
    .prepare('SELECT id, card FROM characters WHERE profile_id = ? ORDER BY created_at')
    .all(profileId) as Array<{ id: string; card: string }>

  const out: Array<{ id: string; card: RPTerminalCard }> = []
  for (const row of rows) {
    const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
    if (parsed.success) out.push({ id: row.id, card: parsed.data })
    else log('info', `Skipping invalid card ${row.id}:`, parsed.error.issues?.[0]?.message)
  }
  return out
}

export const getCharacter = (profileId: string, characterId: string): RPTerminalCard | null => {
  const row = getDb()
    .prepare('SELECT card FROM characters WHERE id = ? AND profile_id = ?')
    .get(characterId, profileId) as { card: string } | undefined
  if (!row) return null
  const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
  return parsed.success ? parsed.data : null
}

export const saveCharacter = (
  profileId: string,
  characterId: string,
  card: RPTerminalCard
): void => {
  const parsed = RPTerminalCardSchema.parse(card)
  getDb()
    .prepare(
      `INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET card = excluded.card`
    )
    .run(characterId, profileId, JSON.stringify(parsed), new Date().toISOString())
}

export const deleteCharacter = (profileId: string, characterId: string): void => {
  const db = getDb()
  db.prepare('DELETE FROM characters WHERE id = ? AND profile_id = ?').run(characterId, profileId)
  // Cascade the character's sessions (chats); their floors are FK ON DELETE CASCADE.
  // character_id is a plain column (not an FK), so this isn't automatic — without it the
  // chats are orphaned and a stale activeChatId can re-render a deleted world's frontend cards.
  db.prepare('DELETE FROM chats WHERE character_id = ? AND profile_id = ?').run(
    characterId,
    profileId
  )
  deleteCharacterLorebook(profileId, characterId)
  // Remove the world-scoped regex/scripts this card brought in on import (scope='world',
  // owner=characterId) so a deleted World Card doesn't leave orphans in the managers —
  // mirrors deletePreset's cleanup of its preset-scoped artifacts.
  regexService.deleteScriptsByOwner(profileId, 'world', characterId)
  scriptService.deleteScriptsByOwner(profileId, 'world', characterId)
  const avatar = getAvatarPath(characterId)
  if (fs.existsSync(avatar)) fs.unlinkSync(avatar)
}

/** A card file parsed (losslessly) but not yet persisted. */
export interface ParsedCard {
  card: RPTerminalCard
  /** The normalized embedded lorebook (character_book), routed to the lore store on install. */
  lorebook: Lorebook | null
}

/** What a card bundles — drives the one-click install confirm + summary toast. */
export interface ImportSummary {
  name: string
  isWorldCard: boolean
  regexScripts: number
  loreEntries: number
  scripts: number
  uiWidgets: number
  presets: number
  lorebooks: number
  /** Bundled plugins detected but NOT installed yet (package format/grant flow TBD). */
  pluginsSkipped: number
}

export interface ImportResult {
  id: string
  summary: ImportSummary
}

/**
 * Collect bundled ST regex scripts from both the standard `extensions.regex_scripts`
 * (which SillyTavern also applies) and our `rp_terminal.regex` slot. Each element is
 * one ST regex-script object. Canonical source is `regex_scripts` (§3 of the design).
 */
export const collectBundledRegex = (card: RPTerminalCard): any[] => {
  const rpt = getRpExt(card)
  // `regex_scripts` is the ST-standard key (extensions level, untyped via catchall).
  const fromSt = card.data.extensions?.regex_scripts
  const fromRpt = rpt?.regex
  return [
    ...(Array.isArray(fromSt) ? fromSt : []),
    ...(Array.isArray(fromRpt) ? fromRpt : [])
  ].filter((r) => r && typeof r === 'object')
}

/** Bundled chat-completion presets from `rp_terminal.presets[]` (Track S §3). */
export const collectBundledPresets = (card: RPTerminalCard): any[] => {
  const p = getRpExt(card)?.presets
  return Array.isArray(p) ? p.filter((x) => x && typeof x === 'object') : []
}

/** Extra bundled lorebooks from `rp_terminal.lorebooks[]` (beyond `character_book`). */
export const collectBundledLorebooks = (card: RPTerminalCard): any[] => {
  const b = getRpExt(card)?.lorebooks
  return Array.isArray(b) ? b.filter((x) => x && typeof x === 'object') : []
}

/** Count what a parsed card bundles, for the import confirm + summary toast. */
export const summarizeCardBundle = (parsed: ParsedCard): ImportSummary => {
  const rpt = getRpExt(parsed.card)
  return {
    name: parsed.card.data.name,
    isWorldCard: !!rpt?.world_card,
    regexScripts: collectBundledRegex(parsed.card).length,
    loreEntries: parsed.lorebook?.entries.length || 0,
    scripts: Array.isArray(rpt?.scripts) ? rpt.scripts.length : 0,
    uiWidgets: Array.isArray(rpt?.ui_layout) ? rpt.ui_layout.length : 0,
    presets: collectBundledPresets(parsed.card).length,
    lorebooks: collectBundledLorebooks(parsed.card).length,
    pluginsSkipped: Array.isArray(rpt?.plugins) ? rpt.plugins.length : 0
  }
}

/** True when a card carries enough of a bundle to warrant the install confirm. */
export const hasBundle = (s: ImportSummary): boolean =>
  s.isWorldCard ||
  s.regexScripts > 0 ||
  s.scripts > 0 ||
  s.uiWidgets > 0 ||
  s.presets > 0 ||
  s.lorebooks > 0

/**
 * Parse a card file (PNG/JSON) into a normalized, **lossless** RPTerminalCard
 * without persisting anything. Unlike the old whitelist import, this preserves the
 * *entire* `extensions` object (ST keys like `regex_scripts` + future `rp_terminal`
 * bundle slots) so a World Card round-trips instead of being stripped on import.
 */
export const parseCardFile = (filePath: string): ParsedCard | null => {
  let stData: any = null
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.png') stData = parseStPng(filePath)
    else if (ext === '.json') stData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
  if (!stData) return null

  const isWrapped = stData.spec === 'chara_card_v2' || stData.spec === 'chara_card_v3'
  const src = isWrapped ? stData.data : stData

  const result = RPTerminalCardSchema.safeParse({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: src.name || 'Unknown',
      description: src.description || '',
      personality: src.personality || '',
      scenario: src.scenario || '',
      first_mes: src.first_mes || '',
      mes_example: src.mes_example || '',
      creator_notes: src.creator_notes || '',
      system_prompt: src.system_prompt || '',
      post_history_instructions: src.post_history_instructions || '',
      alternate_greetings: src.alternate_greetings || [],
      tags: src.tags || [],
      creator: src.creator || '',
      character_version: src.character_version || '',
      // Lossless: keep ALL extensions, not just rp_terminal. The schema's catchalls
      // (CardData.extensions + RPTerminalExt) preserve unknown keys.
      extensions: src.extensions || {}
    }
  })
  if (!result.success) return null

  const lorebook = normalizeLorebookData(
    src.character_book || stData.character_book,
    src.name || 'Unknown'
  )
  return { card: result.data, lorebook }
}

/** Inspect a card file's bundle without persisting — used to show the install confirm. */
export const inspectCardFile = (filePath: string): ImportSummary | null => {
  const parsed = parseCardFile(filePath)
  return parsed ? summarizeCardBundle(parsed) : null
}

/**
 * One-click World Card import: persist the (lossless) card + its embedded lorebook,
 * and **extract bundled regex into the profile regex store** (the slot the old
 * importer silently dropped). Returns the new id plus an install summary.
 */
export const importCharacterFromFile = (
  profileId: string,
  filePath: string
): ImportResult | null => {
  try {
    const parsed = parseCardFile(filePath)
    if (!parsed) return null
    const { card, lorebook } = parsed

    const newId = crypto.randomUUID()
    saveCharacter(profileId, newId, card)

    if (lorebook) saveCharacterLorebook(profileId, newId, lorebook)

    // Route each bundled ST regex script into the profile regex store (one file each),
    // scoped to this world so it only fires when this card is loaded (Track S §6).
    let regexScripts = 0
    for (const script of collectBundledRegex(card)) {
      if (regexService.saveRegexScript(profileId, script, 'world', newId)) regexScripts++
    }

    // Route bundled chat-completion presets into the preset store (never made active).
    let presets = 0
    for (const p of collectBundledPresets(card)) {
      if (installBundledPreset(profileId, p)) presets++
    }

    // Route extra bundled lorebooks (beyond character_book) into the lorebook library.
    let lorebooks = 0
    for (const lb of collectBundledLorebooks(card)) {
      const normalized = normalizeLorebookData(lb, lb?.name || 'Bundled Lorebook')
      if (normalized) {
        saveLorebookById(profileId, crypto.randomUUID(), normalized)
        lorebooks++
      }
    }

    if (path.extname(filePath).toLowerCase() === '.png') {
      ensureDir(getAvatarsDir())
      fs.copyFileSync(filePath, getAvatarPath(newId))
    }

    const summary = summarizeCardBundle(parsed)
    summary.regexScripts = regexScripts
    summary.presets = presets
    summary.lorebooks = lorebooks
    return { id: newId, summary }
  } catch (error) {
    log('error', 'Failed to import character:', error)
    return null
  }
}

/**
 * Build a World Card export object (chara_card_v3) — the inverse of import (§7). Folds
 * the card's own lorebook back into `character_book`, this world's regex back into the
 * canonical `extensions.regex_scripts`, and stamps the `world_card` marker. The card's
 * existing `rp_terminal` payload (scripts/ui/data_schema/state_schema/agent/css/…) rides
 * along untouched. Pure + deep-cloned so export never mutates the live card. Re-importing
 * the result reproduces the same world (round-trip invariant).
 *
 * NOTE: presets/extra-lorebooks/plugins aren't exported yet — they have no world-scope
 * binding (S2 scoped regex only), so we can't reliably attribute them to this card.
 */
export const buildWorldCardExport = (
  card: RPTerminalCard,
  characterBook: Lorebook | null,
  worldRegex: any[]
): any => {
  const data: any = JSON.parse(JSON.stringify(card.data))
  data.extensions = data.extensions || {}
  data.extensions.rp_terminal = {
    ...(data.extensions.rp_terminal || {}),
    world_card: data.extensions.rp_terminal?.world_card || '1.0'
  }
  if (worldRegex.length > 0) data.extensions.regex_scripts = worldRegex
  if (characterBook && characterBook.entries.length > 0) data.character_book = characterBook
  return { spec: 'chara_card_v3', spec_version: '3.0', data }
}

/** Gather a character + its world-scoped artifacts into a World Card JSON for export. */
export const exportWorldCard = (
  profileId: string,
  characterId: string
): { name: string; json: any } | null => {
  const card = getCharacter(profileId, characterId)
  if (!card) return null
  const book = getCharacterLorebook(profileId, characterId)
  const worldRegex = regexService.getRawScriptsForExport(profileId, characterId)
  return { name: card.data.name, json: buildWorldCardExport(card, book, worldRegex) }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
