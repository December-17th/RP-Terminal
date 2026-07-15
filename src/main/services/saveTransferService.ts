import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { getDb } from './db'
import { getSessionDbByChat, sessionDir } from './sessionDbService'
import { sandboxDbPath } from './tableDbService'
import { isTableWriteBusy } from './tableOpsService'
import { getCharacter, findMatchingByIdentity } from './characterService'
import { getTableTemplateById, saveTableTemplate } from './tableTemplateService'
import { refreshChatSummary } from './floorService'
import { TableTemplate, TableTemplateSchema } from '../types/tableTemplate'
import { log } from './logService'

/**
 * Export / import a single SAVE (one chat/session) as a portable `.rpsave` zip (plan §B6 / Feature 2).
 *
 * A save is the chat's per-session STORE folder — session.sqlite (floors/ops/combat/node_state/…) +
 * table.sqlite (memory data) + notes.md + session-vars.json — PLUS a synthesized `manifest.json` and a
 * `central-sidecar.json` carrying the chat-keyed rows that stay in the central DB (§B0 exceptions:
 * agent-pack per-chat activation/overrides/trigger + the chats-row carry columns + the assigned table
 * template). Run-history is intentionally omitted (review C9). Saves REFERENCE their world: import
 * requires a world with the same name+creator installed, and errors otherwise.
 */

const SAVE_FORMAT = 1

// The session tables whose `chat_id` is rewritten on import (one chat per session.sqlite, so an
// unconditional UPDATE per table remaps every row — plan §B6). Fixed allowlist → safe to interpolate.
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

interface WorldRef {
  characterId: string
  name: string
  creator: string
  version: string
}

interface SaveManifest {
  saveFormat: number
  worldRef: WorldRef
  createdAt: string
}

interface ChatCarry {
  mode: string | null
  lorebook_ids: string | null
  workflow_id: string | null
  cached_world_info: string | null
  table_template_id: string | null
}

interface CentralSidecar {
  chat: ChatCarry
  tableTemplate: TableTemplate | null
  activation: Array<Record<string, unknown>>
  overrides: Array<Record<string, unknown>>
  triggerState: Array<Record<string, unknown>>
}

export type ExportResult = { name: string; buffer: Buffer } | { error: string }
export type ImportResult = { chatId: string } | { error: string; worldName?: string }

/** Checkpoint a sqlite file's WAL so a plain file copy is a consistent snapshot (publishShadow idiom). */
const checkpointFile = (file: string): void => {
  if (!fs.existsSync(file)) return
  try {
    const d = new Database(file)
    try {
      d.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      d.close()
    }
  } catch (e) {
    log('info', `Could not checkpoint ${file} before export:`, e)
  }
}

/** Build a `.rpsave` zip buffer for one chat, or an error code. Reuses the export-dialog IPC pattern. */
export const buildSaveZip = (profileId: string, chatId: string): ExportResult => {
  const central = getDb()
  const chat = central
    .prepare(
      `SELECT character_id, mode, lorebook_ids, workflow_id, cached_world_info, table_template_id
       FROM chats WHERE id = ? AND profile_id = ?`
    )
    .get(chatId, profileId) as ({ character_id: string } & ChatCarry) | undefined
  if (!chat) return { error: 'save.notFound' }
  // A torn/stale archive results if the memory op-log is mid-write — refuse (review C4).
  if (isTableWriteBusy(chatId)) return { error: 'save.memoryBusy' }

  const card = getCharacter(profileId, chat.character_id)
  const worldRef: WorldRef = {
    characterId: chat.character_id,
    name: card?.data.name ?? '',
    creator: card?.data.creator ?? '',
    version: card?.data.character_version ?? ''
  }

  // Consistent snapshots: checkpoint the live session WAL (via the cached handle) + the sandbox file.
  getSessionDbByChat(chatId)?.pragma('wal_checkpoint(TRUNCATE)')
  const dir = sessionDir(profileId, chatId)
  checkpointFile(sandboxDbPath(profileId, chatId))

  const manifest: SaveManifest = {
    saveFormat: SAVE_FORMAT,
    worldRef,
    createdAt: new Date().toISOString()
  }
  const sidecar: CentralSidecar = {
    chat: {
      mode: chat.mode,
      lorebook_ids: chat.lorebook_ids,
      workflow_id: chat.workflow_id,
      cached_world_info: chat.cached_world_info,
      table_template_id: chat.table_template_id
    },
    tableTemplate: chat.table_template_id
      ? getTableTemplateById(profileId, chat.table_template_id)
      : null,
    activation: central
      .prepare(
        'SELECT pack_id, world_id, gate_open, denial, pin_version FROM agent_pack_activation WHERE chat_id = ?'
      )
      .all(chatId) as Array<Record<string, unknown>>,
    overrides: central
      .prepare('SELECT pack_id, setting_id, value FROM agent_pack_overrides WHERE scope = ?')
      .all(`chat:${chatId}`) as Array<Record<string, unknown>>,
    triggerState: central
      .prepare(
        'SELECT pack_id, trigger_index, last_value, last_fire_floor FROM agent_pack_trigger_state WHERE chat_id = ?'
      )
      .all(chatId) as Array<Record<string, unknown>>
  }

  const zip = new AdmZip()
  for (const f of ['session.sqlite', 'table.sqlite', 'notes.md', 'session-vars.json']) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) zip.addLocalFile(p)
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
  zip.addFile('central-sidecar.json', Buffer.from(JSON.stringify(sidecar, null, 2), 'utf-8'))

  const name = (worldRef.name || 'save').replace(/[^a-z0-9_-]+/gi, '_') || 'save'
  return { name, buffer: zip.toBuffer() }
}

/** Import a `.rpsave` into a NEW chat bound to the (already-installed) referenced world. */
export const importSave = (profileId: string, zipPath: string): ImportResult => {
  let manifest: SaveManifest
  let sidecar: CentralSidecar | null = null
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
    if (!zip.getEntry('manifest.json')) return { error: 'save.badArchive' }
    manifest = JSON.parse(zip.readAsText('manifest.json')) as SaveManifest
    if (zip.getEntry('central-sidecar.json')) {
      sidecar = JSON.parse(zip.readAsText('central-sidecar.json')) as CentralSidecar
    }
  } catch (e) {
    log('error', 'Save import: unreadable archive', e)
    return { error: 'save.badArchive' }
  }
  if (!manifest?.worldRef?.name && manifest?.worldRef?.name !== '')
    return { error: 'save.badArchive' }

  // Resolve the referenced world (must be installed — a save REFERENCES its world, §B / Feature 2).
  const matches = findMatchingByIdentity(
    profileId,
    manifest.worldRef.name,
    manifest.worldRef.creator
  )
  if (!matches.length)
    return { error: 'save.worldMissing', worldName: manifest.worldRef.name || '?' }
  const worldId = matches[0].id

  const central = getDb()
  const newId = randomUUID()
  const now = new Date().toISOString()
  const carry: ChatCarry = sidecar?.chat ?? {
    mode: null,
    lorebook_ids: null,
    workflow_id: null,
    cached_world_info: null,
    table_template_id: null
  }

  // Install the save's table template if this profile doesn't already have that id (review C4), so the
  // imported chat's table memory resolves. A malformed embedded template is skipped (memory just off).
  let templateId = carry.table_template_id
  if (templateId && sidecar?.tableTemplate && !getTableTemplateById(profileId, templateId)) {
    const parsed = TableTemplateSchema.safeParse(sidecar.tableTemplate)
    if (parsed.success) saveTableTemplate(profileId, parsed.data, templateId)
    else templateId = null
  }

  // Index row FIRST (so the session-DB resolver can find the new chat), carrying the source columns.
  central
    .prepare(
      `INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, mode, lorebook_ids,
         workflow_id, cached_world_info, table_template_id, session_migrated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      newId,
      profileId,
      worldId,
      now,
      now,
      carry.mode ?? null,
      carry.lorebook_ids ?? null,
      carry.workflow_id ?? null,
      carry.cached_world_info ?? null,
      templateId ?? null
    )

  // Extract the store files into the new session folder, then drop the metadata files.
  const dir = sessionDir(profileId, newId)
  fs.mkdirSync(dir, { recursive: true })
  zip.extractAllTo(dir, true)
  for (const meta of ['manifest.json', 'central-sidecar.json']) {
    const p = path.join(dir, meta)
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
  }

  // Remap every session-table row's chat_id to the new id (one chat per session.sqlite — §B6).
  const sdb = getSessionDbByChat(newId)
  if (sdb) {
    for (const t of SESSION_TABLES) {
      try {
        sdb.prepare(`UPDATE ${t} SET chat_id = ?`).run(newId)
      } catch (e) {
        log('info', `Save import: could not remap chat_id for ${t}:`, e)
      }
    }
  }

  // Re-insert the sidecar central rows under the new chat + resolved world (best-effort — rows for a
  // pack not installed on this machine simply never resolve; review C9).
  if (sidecar) {
    for (const a of sidecar.activation ?? []) {
      central
        .prepare(
          `INSERT OR REPLACE INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial, pin_version)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(a.pack_id, worldId, newId, a.gate_open ?? 0, a.denial ?? null, a.pin_version ?? null)
    }
    for (const o of sidecar.overrides ?? []) {
      central
        .prepare(
          'INSERT OR REPLACE INTO agent_pack_overrides (pack_id, scope, setting_id, value) VALUES (?, ?, ?, ?)'
        )
        .run(o.pack_id, `chat:${newId}`, o.setting_id, o.value)
    }
    for (const tr of sidecar.triggerState ?? []) {
      central
        .prepare(
          `INSERT OR REPLACE INTO agent_pack_trigger_state (chat_id, pack_id, trigger_index, last_value, last_fire_floor)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(newId, tr.pack_id, tr.trigger_index, tr.last_value ?? null, tr.last_fire_floor ?? null)
    }
  }

  refreshChatSummary(newId)
  return { chatId: newId }
}
