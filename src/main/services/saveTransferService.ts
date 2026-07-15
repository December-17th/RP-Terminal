import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { z } from 'zod'
import { getDb } from './db'
import * as sessionDbService from './sessionDbService'
import { sandboxDbPath } from './tableDbService'
import { isTableWriteBusy } from './tableOpsService'
import { getCharacter, findMatchingByIdentity } from './characterService'
import {
  deleteTableTemplate,
  getTableTemplateById,
  saveTableTemplate
} from './tableTemplateService'
import { refreshChatSummary } from './floorService'
import { TableTemplate, TableTemplateSchema } from '../types/tableTemplate'
import { log } from './logService'

/** Portable save archive format. A save references an installed world by name + creator. */
const SAVE_FORMAT = 1
const MAX_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const PAYLOAD_FILES = ['session.sqlite', 'table.sqlite', 'notes.md', 'session-vars.json'] as const
const ALLOWED_FILES = new Set([...PAYLOAD_FILES, 'manifest.json', 'central-sidecar.json'])

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

const ManifestSchema = z.object({
  saveFormat: z.literal(SAVE_FORMAT),
  worldRef: z.object({
    characterId: z.string(),
    name: z.string(),
    creator: z.string(),
    version: z.string()
  }),
  createdAt: z.string().min(1)
})

const nullableString = z.string().nullable().default(null)
const recordArray = z.array(z.record(z.string(), z.unknown())).default([])
const SidecarSchema = z.object({
  chat: z
    .object({
      mode: nullableString,
      lorebook_ids: nullableString,
      workflow_id: nullableString,
      cached_world_info: nullableString,
      table_template_id: nullableString
    })
    .default({
      mode: null,
      lorebook_ids: null,
      workflow_id: null,
      cached_world_info: null,
      table_template_id: null
    }),
  tableTemplate: z.unknown().nullable().default(null),
  activation: recordArray,
  overrides: recordArray,
  triggerState: recordArray
})

const EMPTY_CARRY: ChatCarry = {
  mode: null,
  lorebook_ids: null,
  workflow_id: null,
  cached_world_info: null,
  table_template_id: null
}

export type ExportResult = { name: string; buffer: Buffer } | { error: string }
export type ImportResult = { chatId: string } | { error: string; worldName?: string }

const checkpointFile = (file: string): void => {
  if (!fs.existsSync(file)) return
  try {
    const db = new Database(file)
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
  } catch (error) {
    log('info', `Could not checkpoint ${file} before export:`, error)
  }
}

export const buildSaveZip = (profileId: string, chatId: string): ExportResult => {
  const central = getDb()
  const chat = central
    .prepare(
      `SELECT character_id, mode, lorebook_ids, workflow_id, cached_world_info, table_template_id
       FROM chats WHERE id = ? AND profile_id = ?`
    )
    .get(chatId, profileId) as ({ character_id: string } & ChatCarry) | undefined
  if (!chat) return { error: 'save.notFound' }
  if (isTableWriteBusy(chatId)) return { error: 'save.memoryBusy' }

  const card = getCharacter(profileId, chat.character_id)
  const worldRef: WorldRef = {
    characterId: chat.character_id,
    name: card?.data.name ?? '',
    creator: card?.data.creator ?? '',
    version: card?.data.character_version ?? ''
  }

  sessionDbService.getSessionDbByChat(chatId)?.pragma('wal_checkpoint(TRUNCATE)')
  const dir = sessionDbService.sessionDir(profileId, chatId)
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
  for (const file of PAYLOAD_FILES) {
    const source = path.join(dir, file)
    if (fs.existsSync(source)) zip.addLocalFile(source)
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
  zip.addFile('central-sidecar.json', Buffer.from(JSON.stringify(sidecar, null, 2), 'utf-8'))

  const name = (worldRef.name || 'save').replace(/[^a-z0-9_-]+/gi, '_') || 'save'
  return { name, buffer: zip.toBuffer() }
}

interface ParsedArchive {
  zip: AdmZip
  manifest: SaveManifest
  sidecar: CentralSidecar | null
}

const parseArchive = (zipPath: string): ParsedArchive | null => {
  try {
    const zip = new AdmZip(zipPath)
    const seen = new Set<string>()
    let declaredBytes = 0
    for (const entry of zip.getEntries()) {
      const name = entry.entryName
      if (entry.isDirectory || !ALLOWED_FILES.has(name) || seen.has(name)) return null
      seen.add(name)
      const size = Number(entry.header.size)
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) return null
      declaredBytes += size
      if (declaredBytes > MAX_ARCHIVE_BYTES) return null
    }
    if (!seen.has('manifest.json') || !seen.has('session.sqlite')) return null

    const manifestResult = ManifestSchema.safeParse(JSON.parse(zip.readAsText('manifest.json')))
    if (!manifestResult.success) return null

    let sidecar: CentralSidecar | null = null
    if (seen.has('central-sidecar.json')) {
      const raw = SidecarSchema.safeParse(JSON.parse(zip.readAsText('central-sidecar.json')))
      if (!raw.success) return null
      const template = TableTemplateSchema.safeParse(raw.data.tableTemplate)
      sidecar = {
        chat: raw.data.chat,
        tableTemplate: template.success ? template.data : null,
        activation: raw.data.activation,
        overrides: raw.data.overrides,
        triggerState: raw.data.triggerState
      }
    }
    return { zip, manifest: manifestResult.data, sidecar }
  } catch (error) {
    log('error', 'Save import: unreadable archive', error)
    return null
  }
}

const writePayloadToStaging = (archive: ParsedArchive, stagingDir: string): void => {
  fs.mkdirSync(stagingDir, { recursive: true })
  let actualBytes = 0
  for (const file of PAYLOAD_FILES) {
    const entry = archive.zip.getEntry(file)
    if (!entry) continue
    const data = entry.getData()
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`Save entry is too large: ${file}`)
    actualBytes += data.length
    if (actualBytes > MAX_ARCHIVE_BYTES) throw new Error('Save archive is too large')
    fs.writeFileSync(path.join(stagingDir, file), data)
  }
}

const validateAndRemapSession = (dbPath: string, newChatId: string): void => {
  const db = new Database(dbPath)
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check: string
    }>
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('Imported session database failed integrity_check')
    }
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string
    }>
    const tables = new Set(rows.map((row) => row.name))
    for (const table of SESSION_TABLES) {
      if (!tables.has(table)) throw new Error(`Imported session database is missing ${table}`)
    }
    db.transaction(() => {
      for (const table of SESSION_TABLES) {
        db.prepare(`UPDATE ${table} SET chat_id = ?`).run(newChatId)
      }
    })()
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

const removeImportedIndexRows = (chatId: string): void => {
  const central = getDb()
  central.transaction(() => {
    central.prepare('DELETE FROM agent_pack_activation WHERE chat_id = ?').run(chatId)
    central.prepare('DELETE FROM agent_pack_overrides WHERE scope = ?').run(`chat:${chatId}`)
    central.prepare('DELETE FROM agent_pack_trigger_state WHERE chat_id = ?').run(chatId)
    central.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
  })()
}

/** Import a validated `.rpsave` into a new chat. All files are staged before anything is published. */
export const importSave = (profileId: string, zipPath: string): ImportResult => {
  const archive = parseArchive(zipPath)
  if (!archive) return { error: 'save.badArchive' }

  const matches = findMatchingByIdentity(
    profileId,
    archive.manifest.worldRef.name,
    archive.manifest.worldRef.creator
  )
  if (!matches.length) {
    return { error: 'save.worldMissing', worldName: archive.manifest.worldRef.name || '?' }
  }

  const worldId = matches[0].id
  const newId = randomUUID()
  const finalDir = sessionDbService.sessionDir(profileId, newId)
  const stagingDir = path.join(path.dirname(finalDir), `.${newId}.importing`)
  const central = getDb()
  const carry = archive.sidecar?.chat ?? EMPTY_CARRY
  let published = false
  let installedTemplateId: string | null = null

  try {
    writePayloadToStaging(archive, stagingDir)
    validateAndRemapSession(path.join(stagingDir, 'session.sqlite'), newId)

    let templateId = carry.table_template_id
    if (templateId && !getTableTemplateById(profileId, templateId)) {
      if (archive.sidecar?.tableTemplate) {
        saveTableTemplate(profileId, archive.sidecar.tableTemplate, templateId)
        installedTemplateId = templateId
      } else {
        templateId = null
      }
    }

    fs.renameSync(stagingDir, finalDir)
    published = true
    const now = new Date().toISOString()
    central.transaction(() => {
      central
        .prepare(
          `INSERT INTO chats (id, profile_id, character_id, created_at, updated_at, mode, lorebook_ids,
             workflow_id, cached_world_info, table_template_id, session_migrated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)`
        )
        .run(
          newId,
          profileId,
          worldId,
          now,
          now,
          carry.mode,
          carry.lorebook_ids,
          carry.workflow_id,
          templateId
        )

      for (const activation of archive.sidecar?.activation ?? []) {
        central
          .prepare(
            `INSERT OR REPLACE INTO agent_pack_activation
               (pack_id, world_id, chat_id, gate_open, denial, pin_version)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            activation.pack_id,
            worldId,
            newId,
            activation.gate_open ?? 0,
            activation.denial ?? null,
            activation.pin_version ?? null
          )
      }
      for (const override of archive.sidecar?.overrides ?? []) {
        central
          .prepare(
            'INSERT OR REPLACE INTO agent_pack_overrides (pack_id, scope, setting_id, value) VALUES (?, ?, ?, ?)'
          )
          .run(override.pack_id, `chat:${newId}`, override.setting_id, override.value)
      }
      for (const trigger of archive.sidecar?.triggerState ?? []) {
        central
          .prepare(
            `INSERT OR REPLACE INTO agent_pack_trigger_state
               (chat_id, pack_id, trigger_index, last_value, last_fire_floor)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            newId,
            trigger.pack_id,
            trigger.trigger_index,
            trigger.last_value ?? null,
            trigger.last_fire_floor ?? null
          )
      }
    })()

    refreshChatSummary(newId)
    return { chatId: newId }
  } catch (error) {
    log('error', 'Save import failed; staged changes were rolled back', error)
    try {
      removeImportedIndexRows(newId)
    } catch (cleanupError) {
      log('error', `Save import: failed to remove index rows for ${newId}`, cleanupError)
    }
    if (published) sessionDbService.removeSession(profileId, newId)
    else if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true })
    if (installedTemplateId) {
      try {
        deleteTableTemplate(profileId, installedTemplateId)
      } catch (cleanupError) {
        log('error', `Save import: failed to remove template ${installedTemplateId}`, cleanupError)
      }
    }
    return { error: 'save.badArchive' }
  }
}
