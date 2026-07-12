import fs from 'fs'
import path from 'path'
import { getAppDir, ensureDir, writeTextSyncAtomic } from './storageService'
import { log } from './logService'

/**
 * Per-chat NOTES store for grep-based agentic plot-recall memory (plot-recall WP2).
 *
 * A chat's notes are a single human-readable/editable markdown file at
 * `profiles/<id>/chat-notes/<chatId>.md`, modeled on the per-chat SQL sandbox lifecycle in
 * `tableDbService.ts` (one file per chat, apart from the app DB). The CONTENT format (`##` section
 * headings + optional `<!-- keywords: … -->` lines) is owned by `src/shared/memory/notesGrep.ts`;
 * this service is purely the file I/O + lifecycle seam and never parses or shapes the prose.
 */

/** The notes file path for a chat. Kept in its own `chat-notes/` dir, apart from the app DB. */
export const notesFilePath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chat-notes', `${chatId}.md`)

/** Read a chat's notes markdown. Missing file (or any read error) → empty string. */
export const readNotes = (profileId: string, chatId: string): string => {
  const file = notesFilePath(profileId, chatId)
  try {
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf-8')
  } catch (error) {
    log('info', `Failed to read notes for chat ${chatId}:`, error)
    return ''
  }
}

/**
 * Write a chat's notes markdown (whole-file, atomic). Empty/whitespace-only content removes the file
 * so an emptied notes file is byte-for-byte the same as a chat that never had notes (idempotent —
 * `readNotes` returns '' either way).
 */
export const writeNotes = (profileId: string, chatId: string, notes: string): void => {
  const file = notesFilePath(profileId, chatId)
  if (!notes || !notes.trim()) {
    removeNotes(profileId, chatId)
    return
  }
  ensureDir(path.dirname(file))
  writeTextSyncAtomic(file, notes)
}

/** Delete the notes file for a chat (chat deletion). Idempotent — a missing file is a no-op. */
export const removeNotes = (profileId: string, chatId: string): void => {
  const file = notesFilePath(profileId, chatId)
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  } catch (error) {
    log('info', `Failed to remove notes for chat ${chatId}:`, error)
  }
}
