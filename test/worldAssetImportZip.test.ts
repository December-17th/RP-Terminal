// test/worldAssetImportZip.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'

let tmp: string
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})
import * as svc from '../src/main/services/worldAssetService'

const charDir = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'character')
const locDir = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'location')

const makeZip = (entries: Array<[string, string]>): string => {
  const zip = new AdmZip()
  for (const [name, body] of entries) zip.addFile(name, Buffer.from(body))
  const p = path.join(tmp, `assets-${Math.random().toString(36).slice(2)}.zip`)
  zip.writeZip(p)
  return p
}

beforeEach(() => {
  svc.clearAssetCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-zip-'))
})
afterEach(() => {
  svc.clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('importAssetsZip', () => {
  it('extracts valid category/file entries and counts them', () => {
    const zip = makeZip([
      ['character/爱莎_头像.jpg', 'A'],
      ['location/王城_背景.png', 'B']
    ])
    const r = svc.importAssetsZip('p1', 'w1', zip)
    expect(r.imported).toBe(2)
    expect(r.byCategory).toEqual({ character: 1, location: 1 })
    expect(fs.readFileSync(path.join(charDir('w1'), '爱莎_头像.jpg'), 'utf-8')).toBe('A')
    expect(fs.readFileSync(path.join(locDir('w1'), '王城_背景.png'), 'utf-8')).toBe('B')
  })

  it('skips loose, non-convention, wrong-category, and traversal entries with reasons', () => {
    const zip = makeZip([
      ['character/爱莎_头像.jpg', 'A'],
      ['loose.jpg', 'x'], // outside a category folder
      ['character/readme.txt', 'x'], // unrecognized name
      ['character/王城_背景.jpg', 'x'], // wrong category for type
      ['../evil.png', 'x'] // traversal → not a known category
    ])
    const r = svc.importAssetsZip('p1', 'w1', zip)
    expect(r.imported).toBe(1)
    expect(r.skipped).toBe(4)
    expect(r.skippedReasons.join(' ')).toMatch(/outside category folder/)
    expect(r.skippedReasons.join(' ')).toMatch(/unrecognized name/)
    expect(r.skippedReasons.join(' ')).toMatch(/wrong category for type/)
    // nothing escaped the assets root
    expect(fs.existsSync(path.join(tmp, 'evil.png'))).toBe(false)
  })

  it('skips __MACOSX and dotfiles silently (not counted as user errors)', () => {
    const zip = makeZip([
      ['character/爱莎_头像.jpg', 'A'],
      ['__MACOSX/character/._爱莎_头像.jpg', 'junk'],
      ['character/.DS_Store', 'junk']
    ])
    const r = svc.importAssetsZip('p1', 'w1', zip)
    expect(r.imported).toBe(1)
    expect(r.skipped).toBe(0)
  })

  it('overwrites an existing file', () => {
    svc.importAssetsZip('p1', 'w1', makeZip([['character/爱莎_头像.jpg', 'OLD']]))
    svc.importAssetsZip('p1', 'w1', makeZip([['character/爱莎_头像.jpg', 'NEW']]))
    expect(fs.readFileSync(path.join(charDir('w1'), '爱莎_头像.jpg'), 'utf-8')).toBe('NEW')
  })

  it('reports an invalid zip without throwing', () => {
    const bad = path.join(tmp, 'not-a.zip')
    fs.writeFileSync(bad, 'not a zip')
    const r = svc.importAssetsZip('p1', 'w1', bad)
    expect(r.imported).toBe(0)
    expect(r.skippedReasons.join(' ')).toMatch(/invalid|unreadable/i)
  })
})
