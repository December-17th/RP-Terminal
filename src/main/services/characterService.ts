import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir } from './storageService'
import { getDb } from './db'
import { RPTerminalCard, RPTerminalCardSchema, Lorebook } from '../types/character'
import {
  saveCharacterLorebook,
  deleteCharacterLorebook,
  normalizeLorebookData
} from './lorebookService'
import * as regexService from './regexService'
import { parseStPng } from '../parsers/stPngParser'

const getAvatarsDir = (): string => path.join(getAppDir(), 'avatars')
export const getAvatarPath = (characterId: string): string =>
  path.join(getAvatarsDir(), `${characterId}.png`)

export const getCharacters = (profileId: string): Array<{ id: string; card: RPTerminalCard }> => {
  const rows = getDb()
    .prepare('SELECT id, card FROM characters WHERE profile_id = ? ORDER BY created_at')
    .all(profileId) as Array<{ id: string; card: string }>

  const out: Array<{ id: string; card: RPTerminalCard }> = []
  for (const row of rows) {
    const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
    if (parsed.success) out.push({ id: row.id, card: parsed.data })
    else console.warn(`Skipping invalid card ${row.id}:`, parsed.error.issues?.[0]?.message)
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
  getDb()
    .prepare('DELETE FROM characters WHERE id = ? AND profile_id = ?')
    .run(characterId, profileId)
  deleteCharacterLorebook(profileId, characterId)
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
  const ext: any = card.data.extensions || {}
  const fromSt = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : []
  const fromRpt = Array.isArray(ext.rp_terminal?.regex) ? ext.rp_terminal.regex : []
  return [...fromSt, ...fromRpt].filter((r) => r && typeof r === 'object')
}

/** Count what a parsed card bundles, for the import confirm + summary toast. */
export const summarizeCardBundle = (parsed: ParsedCard): ImportSummary => {
  const ext: any = parsed.card.data.extensions || {}
  const rpt: any = ext.rp_terminal || {}
  return {
    name: parsed.card.data.name,
    isWorldCard: !!rpt.world_card,
    regexScripts: collectBundledRegex(parsed.card).length,
    loreEntries: parsed.lorebook?.entries.length || 0,
    scripts: Array.isArray(rpt.scripts) ? rpt.scripts.length : 0,
    uiWidgets: Array.isArray(rpt.ui_layout) ? rpt.ui_layout.length : 0
  }
}

/** True when a card carries enough of a bundle to warrant the install confirm. */
export const hasBundle = (s: ImportSummary): boolean =>
  s.isWorldCard || s.regexScripts > 0 || s.scripts > 0 || s.uiWidgets > 0

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

    // Route each bundled ST regex script into the profile regex store (one file each).
    let regexScripts = 0
    for (const script of collectBundledRegex(card)) {
      if (regexService.saveRegexScript(profileId, script)) regexScripts++
    }

    if (path.extname(filePath).toLowerCase() === '.png') {
      ensureDir(getAvatarsDir())
      fs.copyFileSync(filePath, getAvatarPath(newId))
    }

    const summary = summarizeCardBundle(parsed)
    summary.regexScripts = regexScripts
    return { id: newId, summary }
  } catch (error) {
    console.error('Failed to import character:', error)
    return null
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
