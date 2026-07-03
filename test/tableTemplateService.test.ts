import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  listTableTemplates,
  getTableTemplateById,
  deleteTableTemplate,
  importTableTemplateFromFile
} from '../src/main/services/tableTemplateService'
import { getAppDir } from '../src/main/services/storageService'

// File-based store is real (RPT_DATA_DIR temp root); the DB layer is stubbed but never touched here.
const profileId = `test-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
const tmpFiles: string[] = []
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

const fixturePath = path.join(__dirname, 'fixtures', 'chatsheets-poem-of-destiny-5.9.json')

const writeTmp = (raw: any): string => {
  const p = path.join(getAppDir(), `rpt-tpl-${randomUUID()}.json`)
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')
  tmpFiles.push(p)
  return p
}

describe('tableTemplateService — import + CRUD round-trip', () => {
  it('imports the real chatSheets fixture and lists/gets/deletes it', () => {
    const result = importTableTemplateFromFile(profileId, fixturePath)
    expect(result.error).toBeUndefined()
    expect(result.summary).toBeDefined()
    expect(result.summary!.tableCount).toBe(8)
    const id = result.summary!.id

    // list shows the summary
    const list = listTableTemplates(profileId)
    expect(list.some((s) => s.id === id && s.tableCount === 8)).toBe(true)

    // get returns the full zod-parsed template
    const tpl = getTableTemplateById(profileId, id)
    expect(tpl).not.toBeNull()
    expect(tpl!.sourceFormat).toBe('chatSheets-v2')
    expect(tpl!.tables.map((t) => t.sqlName)).toContain('chronicle')

    // delete removes it
    deleteTableTemplate(profileId, id)
    expect(getTableTemplateById(profileId, id)).toBeNull()
    expect(listTableTemplates(profileId).some((s) => s.id === id)).toBe(false)
  })

  it('returns a localizable read error for non-JSON input', () => {
    const bad = path.join(getAppDir(), `rpt-bad-${randomUUID()}.json`)
    fs.writeFileSync(bad, 'not json at all', 'utf-8')
    tmpFiles.push(bad)
    const result = importTableTemplateFromFile(profileId, bad)
    expect(result.summary).toBeUndefined()
    expect(result.error).toBe('tables.importErrorRead')
  })

  it('surfaces the parser message for a malformed (valid-JSON) template', () => {
    const file = writeTmp({ mate: { type: 'notChatSheets' } })
    const result = importTableTemplateFromFile(profileId, file)
    expect(result.summary).toBeUndefined()
    expect(result.error).toMatch(/chatSheets/)
  })

  it('getTableTemplateById returns null for an unknown id', () => {
    expect(getTableTemplateById(profileId, 'does-not-exist')).toBeNull()
  })
})
