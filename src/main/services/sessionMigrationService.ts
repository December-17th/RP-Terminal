import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { getDb } from './db'
import * as sessionDbService from './sessionDbService'
import { sandboxDbPath } from './tableDbService'
import { notesFilePath } from './notesMemoryService'
import { refreshChatSummary } from './floorService'
import { log } from './logService'

/**
 * One-time migration of pre-existing chats into the decentralized per-session store (plan §B5).
 *
 * Runs at startup, BEFORE any chat is opened, so services never see a half-migrated chat (no
 * split-brain read path). Gated by the per-chat `chats.session_migrated` marker (0 = still in the
 * central tables; 1 = migrated or born decentralized). Idempotent + resumable: a chat is migrated
 * from a CLEAN folder (a partial folder from a crashed run is discarded first), and the marker is the
 * LAST write — a crash before it re-does that chat next launch. A chat that throws is QUARANTINED
 * (left at 0, logged) so one bad chat can't block the others or loop forever (review C1).
 *
 * COPY, never MOVE (review C1): the central rows AND the legacy per-chat files (table-dbs/…, chat-
 * notes/…, chat-card-vars.json) are left intact as a one-release safety net. A later release drops
 * them. The DB is backed up once (`rpterminal.db.pre-decentralize.bak`) before anything is touched.
 */

// The chat-scoped tables copied into session.sqlite (§B2). Fixed allowlist → safe to interpolate.
const SESSION_TABLES = [
  'floors',
  'combat_encounters',
  'node_state',
  'table_ops',
  'vars_ops',
  'table_progress',
  'table_refill_progress',
  'workflow_trigger_state'
] as const

const legacyTableDbPath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'table-dbs', `${chatId}.sqlite`)
const legacyNotesPath = (profileId: string, chatId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chat-notes', `${chatId}.md`)
const legacyChatCardVarsPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chat-card-vars.json')
const sessionVarsPath = (profileId: string, chatId: string): string =>
  path.join(sessionDbService.sessionDir(profileId, chatId), 'session-vars.json')
const backupPath = (): string => path.join(getAppDir(), 'rpterminal.db.pre-decentralize.bak')

/** Copy a chat's rows for one table from the central DB into its session DB (by column name, so
 *  column-order differences never misbind). No-op when the chat has no rows there. */
const copyTableRows = (
  central: Database.Database,
  session: Database.Database,
  table: (typeof SESSION_TABLES)[number],
  chatId: string
): void => {
  const cols = (
    central.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name)
  if (!cols.length) return
  const rows = central.prepare(`SELECT * FROM ${table} WHERE chat_id = ?`).all(chatId) as Array<
    Record<string, unknown>
  >
  if (!rows.length) return
  const ins = session.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  )
  for (const r of rows) ins.run(...cols.map((c) => r[c] as unknown))
}

/** Copy a legacy sandbox .sqlite into the session folder, checkpointing its WAL first so the single-
 *  file copy is consistent (the publishShadow idiom). No-op when the source is absent. */
const copyLegacySqliteFile = (from: string, to: string): void => {
  if (!fs.existsSync(from)) return
  try {
    const d = new Database(from)
    try {
      d.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      d.close()
    }
  } catch (e) {
    log('info', `Could not checkpoint legacy sandbox ${from} before copy:`, e)
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

const migrateOneChat = (central: Database.Database, profileId: string, chatId: string): void => {
  // Start clean (resumable): discard any partial folder from a crashed run, then create fresh.
  sessionDbService.removeSession(profileId, chatId)
  const session = sessionDbService.getSessionDb(profileId, chatId)
  session.transaction(() => {
    for (const t of SESSION_TABLES) copyTableRows(central, session, t, chatId)
  })()

  // Per-chat files — COPIED (legacy originals retained as the safety net, C1).
  copyLegacySqliteFile(legacyTableDbPath(profileId, chatId), sandboxDbPath(profileId, chatId))
  const legacyNotes = legacyNotesPath(profileId, chatId)
  if (fs.existsSync(legacyNotes)) {
    const dest = notesFilePath(profileId, chatId)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(legacyNotes, dest)
  }
  // Split this chat's slice out of the shared chat-card-vars.json into its own session-vars.json.
  const allVars = readJsonSync<Record<string, Record<string, unknown>>>(
    legacyChatCardVarsPath(profileId)
  )
  const vars = allVars?.[chatId]
  if (vars && typeof vars === 'object')
    writeJsonSyncAtomic(sessionVarsPath(profileId, chatId), vars)

  // Denormalized launcher summary (§B3), then flip the marker LAST (C1).
  refreshChatSummary(chatId)
  central.prepare('UPDATE chats SET session_migrated = 1 WHERE id = ?').run(chatId)
}

/** Migrate every not-yet-migrated chat. Safe to call on every startup (a no-op once all are done). */
export const migrateSessionsIfNeeded = (): void => {
  const central = getDb()
  const pending = central
    .prepare('SELECT id, profile_id FROM chats WHERE session_migrated = 0')
    .all() as Array<{ id: string; profile_id: string }>
  if (!pending.length) return

  // Back up the central DB ONCE before touching anything (checkpoint so the copy is consistent).
  try {
    if (!fs.existsSync(backupPath())) {
      central.pragma('wal_checkpoint(TRUNCATE)')
      fs.copyFileSync(path.join(getAppDir(), 'rpterminal.db'), backupPath())
    }
  } catch (e) {
    log('error', 'Session migration: DB backup failed (continuing without it)', e)
  }

  log('info', `Decentralizing ${pending.length} chat(s) into per-session stores…`)
  let migrated = 0
  let deferred = 0
  for (const c of pending) {
    try {
      migrateOneChat(central, c.profile_id, c.id)
      migrated++
    } catch (e) {
      deferred++
      log(
        'error',
        `Session migration deferred for chat ${c.id} (quarantined; retries next launch)`,
        e
      )
    }
  }
  log('info', `Session migration: ${migrated} migrated, ${deferred} deferred`)
}
