import { getDb } from './db'
import { getSessionDbByChat } from './sessionDbService'

/**
 * The per-chat **Assembly Epoch** (ADR 0023 / lore-runtime V8 WP-G1): a persisted counter bumped
 * whenever something assembly-relevant to a chat's stored prompts changes. Each floor stamps the epoch
 * it was assembled under (`stampFloorAssemblyEpoch`); a later Resample (regenerate/swipe, a follow-up
 * WP) replays the stored prompt only when the floor's stamped epoch still matches the chat's current
 * epoch, and otherwise falls back to a full reassembly.
 *
 * Bumps are deliberately COARSE — a false positive only costs a normal reassembly, never correctness.
 * This module owns only the counter (columns are added in db.ts / sessionDbService); the consumer that
 * gates Resample on it lives in generation and is out of scope here.
 *
 * Leaf module by design: it imports only the two DB seams, so the file-based services that must bump
 * (lorebook/character/preset/settings) can depend on it without a cycle back through chatService. The
 * chat epoch lives on the CENTRAL `chats` index; the floor stamp lives in the per-chat SESSION store.
 */

/** Parse a chat's `lorebook_ids` JSON column (null column = default to the character's own book).
 *  Inlined (not imported from chatService) to keep this module a dependency leaf. */
const parseIds = (raw: string | null): string[] | null => {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

/** The chat's current Assembly Epoch. A missing/NULL column reads as 0 (legacy chat). */
export const getAssemblyEpoch = (profileId: string, chatId: string): number => {
  const row = getDb()
    .prepare('SELECT assembly_epoch FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { assembly_epoch: number | null } | undefined
  return row?.assembly_epoch ?? 0
}

/** Advance one chat's Assembly Epoch (COALESCE folds a NULL legacy value in as 0 → 1). */
export const bumpAssemblyEpoch = (profileId: string, chatId: string): void => {
  getDb()
    .prepare(
      'UPDATE chats SET assembly_epoch = COALESCE(assembly_epoch, 0) + 1 WHERE id = ? AND profile_id = ?'
    )
    .run(chatId, profileId)
}

/**
 * Bump every chat whose lore selection is affected by a save to `lorebookId`: chats whose explicit
 * selection lists the id, PLUS chats on the DEFAULT selection (null column) whose `character_id`
 * equals the id (an embedded book is stored under id == characterId).
 */
export const bumpAssemblyEpochForLorebook = (profileId: string, lorebookId: string): void => {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, lorebook_ids, character_id FROM chats WHERE profile_id = ?')
    .all(profileId) as Array<{ id: string; lorebook_ids: string | null; character_id: string }>
  const bump = db.prepare(
    'UPDATE chats SET assembly_epoch = COALESCE(assembly_epoch, 0) + 1 WHERE id = ? AND profile_id = ?'
  )
  for (const row of rows) {
    const ids = parseIds(row.lorebook_ids)
    const affected = ids === null ? row.character_id === lorebookId : ids.includes(lorebookId)
    if (affected) bump.run(row.id, profileId)
  }
}

/** Bump every chat bound to `characterId` (a card save changes those chats' assembly inputs). */
export const bumpAssemblyEpochForCharacter = (profileId: string, characterId: string): void => {
  getDb()
    .prepare(
      'UPDATE chats SET assembly_epoch = COALESCE(assembly_epoch, 0) + 1 WHERE profile_id = ? AND character_id = ?'
    )
    .run(profileId, characterId)
}

/** Bump EVERY chat in the profile — used for profile-global changes (active preset, settings) whose
 *  effect on any given chat's prompt is not worth resolving precisely (coarse on purpose). */
export const bumpAllAssemblyEpochs = (profileId: string): void => {
  getDb()
    .prepare('UPDATE chats SET assembly_epoch = COALESCE(assembly_epoch, 0) + 1 WHERE profile_id = ?')
    .run(profileId)
}

/** Stamp a persisted floor with the epoch it was assembled under (persistFloor, at persist time). The
 *  floor row lives in the per-chat session store; a missing store (deleted/mock) is a silent no-op. */
export const stampFloorAssemblyEpoch = (chatId: string, floor: number, epoch: number): void => {
  getSessionDbByChat(chatId)
    ?.prepare('UPDATE floors SET assembly_epoch = ? WHERE chat_id = ? AND floor = ?')
    .run(epoch, chatId, floor)
}

/** Read a floor's stamped Assembly Epoch, or null when unstamped (legacy floor) / no session store. */
export const getFloorAssemblyEpoch = (chatId: string, floor: number): number | null => {
  const row = getSessionDbByChat(chatId)
    ?.prepare('SELECT assembly_epoch FROM floors WHERE chat_id = ? AND floor = ?')
    .get(chatId, floor) as { assembly_epoch: number | null } | undefined
  return row?.assembly_epoch ?? null
}
