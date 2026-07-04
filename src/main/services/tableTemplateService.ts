import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { log } from './logService'
import {
  TableTemplate,
  TableTemplateSchema,
  TableTemplatePatchSchema
} from '../types/tableTemplate'
import { parseChatSheets, exportChatSheets, ChatSheetsParseError } from '../parsers/chatSheetsParser'
import { readAllTables } from './tableDbService'

export interface TableTemplateSummary {
  id: string
  name: string
  tableCount: number
}

/** Result of an import attempt surfaced across IPC: either a summary or a localizable error. */
export interface TableTemplateImportResult {
  summary?: TableTemplateSummary
  error?: string
}

const templatesDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'table-templates')
const templatePath = (profileId: string, id: string): string =>
  path.join(templatesDir(profileId), `${id}.json`)

export const listTableTemplates = (profileId: string): TableTemplateSummary[] => {
  const dir = templatesDir(profileId)
  const out: TableTemplateSummary[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const id = file.replace(/\.json$/, '')
    const data = readJsonSync<TableTemplate>(path.join(dir, file))
    if (data) {
      out.push({
        id,
        name: data.name || 'Untitled Template',
        tableCount: Array.isArray(data.tables) ? data.tables.length : 0
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const getTableTemplateById = (profileId: string, id: string): TableTemplate | null => {
  const data = readJsonSync(templatePath(profileId, id))
  if (!data) return null
  const parsed = TableTemplateSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/**
 * Persist a parsed template to its own JSON file; returns the id written. Without `id` a new UUID is
 * generated (the import path); pass an existing `id` to OVERWRITE that template in place (the Tables-view
 * prompt editor needs the file at the SAME id updated, not a new file — issue 03).
 */
export const saveTableTemplate = (
  profileId: string,
  template: TableTemplate,
  id: string = randomUUID()
): string => {
  ensureDir(templatesDir(profileId))
  writeJsonSyncAtomic(templatePath(profileId, id), TableTemplateSchema.parse(template))
  return id
}

/**
 * PURE: apply an editable (non-structural) patch to a template, returning a NEW template. Only the five
 * per-op prompts + `updateFrequency` + `exportConfig` (and the template `name`) may change; structural
 * fields (`uid`/`sqlName`/`ddl`/`headers`/`initialRows`/`displayName`) always pass through verbatim.
 * Every patched `uid` must name an existing table; table order is preserved and unmatched tables are
 * untouched. On a malformed patch → `{ error: 'tables.templateBadPatch' }`; an unknown `uid` →
 * `{ error: 'tables.templateUnknownTable' }`. Does not mutate its input.
 */
export const applyTemplatePatch = (
  template: TableTemplate,
  patch: unknown
): TableTemplate | { error: string } => {
  const parsed = TableTemplatePatchSchema.safeParse(patch)
  if (!parsed.success) return { error: 'tables.templateBadPatch' }
  const { name, tables: tablePatches } = parsed.data

  const byUid = new Map(template.tables.map((t) => [t.uid, t]))
  for (const tp of tablePatches) {
    if (!byUid.has(tp.uid)) return { error: 'tables.templateUnknownTable' }
  }
  const patchByUid = new Map(tablePatches.map((tp) => [tp.uid, tp]))

  const tables = template.tables.map((table) => {
    const tp = patchByUid.get(table.uid)
    if (!tp) return table
    const next = { ...table }
    if (tp.note !== undefined) next.note = tp.note
    if (tp.initNode !== undefined) next.initNode = tp.initNode
    if (tp.insertNode !== undefined) next.insertNode = tp.insertNode
    if (tp.updateNode !== undefined) next.updateNode = tp.updateNode
    if (tp.deleteNode !== undefined) next.deleteNode = tp.deleteNode
    if (tp.updateFrequency !== undefined) next.updateFrequency = tp.updateFrequency
    if (tp.exportConfig !== undefined) next.exportConfig = tp.exportConfig
    return next
  })

  return { ...template, ...(name !== undefined ? { name } : {}), tables }
}

/**
 * Load a template by id, apply an editable patch (`applyTemplatePatch`), and persist it back to the SAME
 * id. Returns `{ ok: true }` or a localizable `{ error }`. Structural fields stay immutable; prompt edits
 * are shared across every chat assigned to the template and are picked up on the next maintenance pass.
 */
export const updateTableTemplate = (
  profileId: string,
  id: string,
  patch: unknown
): { ok: true } | { error: string } => {
  const template = getTableTemplateById(profileId, id)
  if (!template) return { error: 'tables.templateNotFound' }
  const result = applyTemplatePatch(template, patch)
  if ('error' in result) return result
  saveTableTemplate(profileId, result, id)
  return { ok: true }
}

export const deleteTableTemplate = (profileId: string, id: string): void => {
  const p = templatePath(profileId, id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

/**
 * Export a stored template back to chatSheets v2 JSON on disk (issue 06). When `chatId` is given,
 * embeds that chat's CURRENT sandbox rows as each table's initial rows ("export with data"): rows are
 * read via `readAllTables` and stringified (null → `''`) so the exported template ships seeded. Absent
 * `chatId` → the template's own `initialRows` are written (header-only for a fresh template). Returns
 * false if the template id is unknown.
 */
export const exportTableTemplateToFile = (
  profileId: string,
  id: string,
  filePath: string,
  chatId?: string | null
): boolean => {
  const template = getTableTemplateById(profileId, id)
  if (!template) return false

  let dataRows: Map<string, string[][]> | undefined
  if (chatId) {
    dataRows = new Map()
    for (const read of readAllTables(profileId, chatId, template)) {
      dataRows.set(
        read.sqlName,
        read.rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
      )
    }
  }

  const payload = exportChatSheets(template, dataRows)
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  return true
}

/**
 * Import a chatSheets v2 JSON file as a NEW template. Returns `{ summary }` on success or
 * `{ error }` (a localizable message) on failure — never throws across the IPC boundary.
 */
export const importTableTemplateFromFile = (
  profileId: string,
  filePath: string
): TableTemplateImportResult => {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (error) {
    log('error', 'Failed to read table-template file:', error)
    return { error: 'tables.importErrorRead' }
  }
  try {
    const template = parseChatSheets(raw, path.basename(filePath, '.json'))
    const id = saveTableTemplate(profileId, template)
    return {
      summary: { id, name: template.name, tableCount: template.tables.length }
    }
  } catch (error) {
    // Parser errors carry a human message; surface it. Anything else → a generic localized key.
    if (error instanceof ChatSheetsParseError) {
      log('info', 'Rejected table-template import:', error.message)
      return { error: error.message }
    }
    log('error', 'Failed to import table template:', error)
    return { error: 'tables.importErrorGeneric' }
  }
}
