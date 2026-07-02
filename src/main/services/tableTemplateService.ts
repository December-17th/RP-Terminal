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
import { TableTemplate, TableTemplateSchema } from '../types/tableTemplate'
import { parseChatSheets, ChatSheetsParseError } from '../parsers/chatSheetsParser'

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

/** Persist a parsed template to its own JSON file; returns the generated id. */
export const saveTableTemplate = (profileId: string, template: TableTemplate): string => {
  ensureDir(templatesDir(profileId))
  const id = randomUUID()
  writeJsonSyncAtomic(templatePath(profileId, id), TableTemplateSchema.parse(template))
  return id
}

export const deleteTableTemplate = (profileId: string, id: string): void => {
  const p = templatePath(profileId, id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
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
