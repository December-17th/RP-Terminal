import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  importTableTemplateFromObject,
  getTableTemplateById
} from '../src/main/services/tableTemplateService'
import { parseChatSheets } from '../src/main/parsers/chatSheetsParser'
import { getAppDir } from '../src/main/services/storageService'

// The card-bundle importer (rp_terminal.table_templates[] → library). Verified against the real 5.9
// template fixture the chatSheets parser suite uses.
const fixture = (): any =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'chatsheets-poem-of-destiny-5.9.json'),
      'utf-8'
    )
  )

const profileId = `tt-import-${randomUUID()}`
const profileDir = path.join(getAppDir(), 'profiles', profileId)
afterAll(() => fs.rmSync(profileDir, { recursive: true, force: true }))

describe('importTableTemplateFromObject (card-bundle path)', () => {
  it('accepts a chatSheets v2 object and persists it as a library template', () => {
    const res = importTableTemplateFromObject(profileId, fixture())
    expect(res.error).toBeUndefined()
    expect(res.summary?.tableCount).toBe(8)
    expect(getTableTemplateById(profileId, res.summary!.id)).not.toBeNull()
  })

  it('falls back to a native TableTemplate shape when the object is not chatSheets v2', () => {
    // parseChatSheets returns our native TableTemplate (no `mate` key) — so feeding it back exercises
    // the ChatSheetsParseError → TableTemplateSchema fallback branch.
    const native = parseChatSheets(fixture(), 'Native')
    const res = importTableTemplateFromObject(profileId, native)
    expect(res.error).toBeUndefined()
    expect(res.summary?.tableCount).toBe(native.tables.length)
    expect(getTableTemplateById(profileId, res.summary!.id)?.tables.length).toBe(
      native.tables.length
    )
  })

  it('rejects garbage with an error and never throws', () => {
    const res = importTableTemplateFromObject(profileId, { foo: 'bar' })
    expect(res.summary).toBeUndefined()
    expect(typeof res.error).toBe('string')
  })
})
