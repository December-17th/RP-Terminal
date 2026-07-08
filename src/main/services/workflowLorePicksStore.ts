// Per-world lorebook entry picks for `agent.llm`'s custom lore mode (agent & memory UX WP-H;
// spec §7, plan §0.4). Node config stores ONLY the mode ('main' | 'custom'); the actual entry picks
// live HERE, keyed (worldId, docId, nodeId) — so the doc stays world-portable and each world keeps
// its own picks. worldId = `chat.character_id`, exactly what the workflow world tier keys on
// (workflowService.ts `selection.worlds[chat.character_id]`).
//
// Storage: a per-profile JSON sidecar next to `_selection.json` in the workflows dir
// (`_lore-picks.json`; the `_` prefix keeps workflowService's doc scan away — workflowService.ts:186).
// Atomic write via writeJsonSyncAtomic (the `_selection.json` precedent).
//
// ENTRY IDENTITY — plan §0.4's documented fallback: our LorebookEntry shape carries NO uid
// (src/main/types/character.ts:8-33; normalizeLorebookData maps comment only, lorebookService.ts:189-205),
// so picks key by `(book id, comment)` — the same identity `lorebook.entries` (lorebookNodes.ts:121)
// and its filters already use. The stored comment doubles as the "missing" display title. A pick whose
// (book, comment) no longer resolves is skipped at run time (fail-soft, spec §11) and surfaces as
// "N missing" in the picker.

import * as path from 'path'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'

/** One picked entry: the lorebook id (listLorebooks) + the entry's comment (its title/identity). */
export interface LorePick {
  book: string
  comment: string
}

interface LorePicksFile {
  version: 1
  /** worldId → docId → nodeId → picks */
  picks: Record<string, Record<string, Record<string, LorePick[]>>>
}

const picksPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'workflows', '_lore-picks.json')

const emptyFile = (): LorePicksFile => ({ version: 1, picks: {} })

const readFile = (profileId: string): LorePicksFile => {
  const raw = readJsonSync<LorePicksFile>(picksPath(profileId))
  if (!raw || raw.version !== 1 || typeof raw.picks !== 'object' || raw.picks === null)
    return emptyFile()
  return raw
}

/** Coerce one stored pick list defensively (the sidecar is a user-editable file). */
const sanitizePicks = (raw: unknown): LorePick[] => {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (p): p is LorePick =>
      !!p &&
      typeof p === 'object' &&
      typeof (p as LorePick).book === 'string' &&
      typeof (p as LorePick).comment === 'string'
  )
}

/** The picks for (worldId, docId, nodeId). Missing anywhere along the path = []. */
export const getLorePicks = (
  profileId: string,
  worldId: string,
  docId: string,
  nodeId: string
): LorePick[] => sanitizePicks(readFile(profileId).picks[worldId]?.[docId]?.[nodeId])

/** Replace the picks for (worldId, docId, nodeId). An EMPTY list removes the key (and prunes empty
 *  parents) so "Clear" leaves no stale residue — an empty pick set means "no picks yet", which the
 *  run-time falls back from (spec: no picks ⇒ main). */
export const setLorePicks = (
  profileId: string,
  worldId: string,
  docId: string,
  nodeId: string,
  picks: LorePick[]
): void => {
  const file = readFile(profileId)
  const clean = sanitizePicks(picks)
  if (clean.length > 0) {
    file.picks[worldId] ??= {}
    file.picks[worldId][docId] ??= {}
    file.picks[worldId][docId][nodeId] = clean
  } else {
    const world = file.picks[worldId]
    if (world?.[docId]) {
      delete world[docId][nodeId]
      if (Object.keys(world[docId]).length === 0) delete world[docId]
      if (Object.keys(world).length === 0) delete file.picks[worldId]
    }
  }
  writeJsonSyncAtomic(picksPath(profileId), file)
}
