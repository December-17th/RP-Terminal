import { v4 as uuidv4 } from 'uuid'
import { getDb } from './db'
import { Lorebook, LorebookEntry, LorebookSchema } from '../types/character'

interface EntryRow {
  keys: string
  secondary_keys: string
  content: string
  enabled: number
  insertion_order: number
  case_sensitive: number
  constant: number
  selective: number
  comment: string
}

const rowToEntry = (r: EntryRow): LorebookEntry => ({
  keys: safeArr(r.keys),
  secondary_keys: safeArr(r.secondary_keys),
  content: r.content,
  enabled: !!r.enabled,
  insertion_order: r.insertion_order,
  case_sensitive: !!r.case_sensitive,
  constant: !!r.constant,
  selective: !!r.selective,
  comment: r.comment || ''
})

export const getCharacterLorebook = (
  profileId: string,
  characterId: string
): Lorebook | null => {
  const db = getDb()
  const book = db
    .prepare('SELECT id, name FROM lorebooks WHERE character_id = ? AND profile_id = ? LIMIT 1')
    .get(characterId, profileId) as { id: string; name: string } | undefined
  if (!book) return null

  const rows = db
    .prepare(
      `SELECT keys, secondary_keys, content, enabled, insertion_order, case_sensitive,
              constant, selective, comment
       FROM lorebook_entries WHERE lorebook_id = ? ORDER BY sort`
    )
    .all(book.id) as EntryRow[]

  return { name: book.name, entries: rows.map(rowToEntry) }
}

export const saveCharacterLorebook = (
  profileId: string,
  characterId: string,
  lorebook: Lorebook
): void => {
  const parsed = LorebookSchema.parse(lorebook)
  const db = getDb()

  const existing = db
    .prepare('SELECT id FROM lorebooks WHERE character_id = ? AND profile_id = ? LIMIT 1')
    .get(characterId, profileId) as { id: string } | undefined
  const lorebookId = existing?.id ?? uuidv4()

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE lorebooks SET name = ? WHERE id = ?').run(parsed.name, lorebookId)
      db.prepare('DELETE FROM lorebook_entries WHERE lorebook_id = ?').run(lorebookId)
    } else {
      db.prepare(
        'INSERT INTO lorebooks (id, profile_id, character_id, name) VALUES (?, ?, ?, ?)'
      ).run(lorebookId, profileId, characterId, parsed.name)
    }

    const insert = db.prepare(
      `INSERT INTO lorebook_entries
        (id, lorebook_id, sort, keys, secondary_keys, content, enabled, insertion_order,
         case_sensitive, constant, selective, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    parsed.entries.forEach((e, i) => {
      insert.run(
        uuidv4(),
        lorebookId,
        i,
        JSON.stringify(e.keys),
        JSON.stringify(e.secondary_keys),
        e.content,
        e.enabled ? 1 : 0,
        e.insertion_order,
        e.case_sensitive ? 1 : 0,
        e.constant ? 1 : 0,
        e.selective ? 1 : 0,
        e.comment
      )
    })
  })
  tx()
}

/**
 * Select which lorebook entries to inject given the recent conversation text.
 * Constant entries always fire; the rest fire on a keyword match. Returns entries
 * sorted by insertion_order (lower = earlier). Pure function — no DB access.
 */
export const matchEntries = (lorebook: Lorebook | null, scanText: string): LorebookEntry[] => {
  if (!lorebook || lorebook.entries.length === 0) return []
  const matched: LorebookEntry[] = []

  for (const entry of lorebook.entries) {
    if (!entry.enabled) continue
    if (entry.constant) {
      matched.push(entry)
      continue
    }
    const haystack = entry.case_sensitive ? scanText : scanText.toLowerCase()
    const keyHit = entry.keys.some((k) => {
      if (!k) return false
      const needle = entry.case_sensitive ? k : k.toLowerCase()
      return haystack.includes(needle)
    })
    if (!keyHit) continue

    if (entry.selective && entry.secondary_keys.length > 0) {
      const secHit = entry.secondary_keys.some((k) => {
        if (!k) return false
        const needle = entry.case_sensitive ? k : k.toLowerCase()
        return haystack.includes(needle)
      })
      if (!secHit) continue
    }
    matched.push(entry)
  }

  return matched.sort((a, b) => a.insertion_order - b.insertion_order)
}

const safeArr = (s: string): string[] => {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
