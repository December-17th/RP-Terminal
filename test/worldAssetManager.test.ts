// test/worldAssetManager.test.ts — WA-2 manager surface (import/delete/rename/export/merged index).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})
import * as svc from '../src/main/services/worldAssetService'
import { parseAssetFilename } from '../src/shared/worldAssets/filename'

const assetsRoot = (lb: string): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`)
const catDir = (lb: string, cat: string): string => path.join(assetsRoot(lb), cat)
const writeFile = (lb: string, cat: string, file: string, body = 'img'): string => {
  const dir = catDir(lb, cat)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, file)
  fs.writeFileSync(p, body)
  return p
}
/** A source image outside the assets root — the picked-file case. */
const srcImage = (name: string, body = 'src'): string => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, body)
  return p
}

beforeEach(() => {
  svc.clearAssetCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-wam-'))
})
afterEach(() => {
  svc.clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getMergedIndex', () => {
  it('merges categories across lorebooks; earlier ids win on a name collision', () => {
    writeFile('w1', 'character', '薇拉_头像.png')
    writeFile('w2', 'character', '薇拉_立绘.png') // same name, later id — should lose to w1
    writeFile('w2', 'location', '雾港_全景.png')
    const merged = svc.getMergedIndex('p1', ['w1', 'w2'])
    expect(merged.character?.['薇拉']?.['头像']?.base).toBe('薇拉_头像.png')
    expect(merged.character?.['薇拉']?.['立绘']).toBeUndefined() // w1's entry won the name
    expect(merged.location?.['雾港']?.['全景']?.base).toBe('雾港_全景.png')
  })
})

describe('importAssetFiles', () => {
  it('imports a valid file under the convention filename', () => {
    const src = srcImage('pic.png')
    const res = svc.importAssetFiles('p1', 'w1', [{ srcPath: src, name: '薇拉', type: '头像' }])
    expect(res).toEqual({ imported: 1, skipped: 0, skippedReasons: [] })
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_头像.png'))).toBe(true)
  })
  it('writes a variant token when supplied', () => {
    const src = srcImage('pic.png')
    svc.importAssetFiles('p1', 'w1', [{ srcPath: src, name: '薇拉', type: '相册', variant: '01' }])
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_相册_01.png'))).toBe(true)
  })
  it('imports MP4 only for background-bearing types', () => {
    const src = srcImage('clip.mp4')
    const accepted = svc.importAssetFiles('p1', 'w1', [
      { srcPath: src, name: '薇拉', type: '立绘bg' }
    ])
    expect(accepted.imported).toBe(1)
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_立绘bg.mp4'))).toBe(true)

    const rejected = svc.importAssetFiles('p1', 'w1', [
      { srcPath: src, name: '薇拉', type: '立绘' },
      { srcPath: src, name: '薇拉', type: '头像' },
      { srcPath: src, name: '薇拉', type: '相册' }
    ])
    expect(rejected.imported).toBe(0)
    expect(rejected.skipped).toBe(3)
  })
  it('skips an unknown type', () => {
    const src = srcImage('pic.png')
    const res = svc.importAssetFiles('p1', 'w1', [
      { srcPath: src, name: '薇拉', type: 'bogus' as any }
    ])
    expect(res.imported).toBe(0)
    expect(res.skipped).toBe(1)
  })
  it('skips an empty name and an unsupported extension', () => {
    const good = srcImage('a.txt')
    const res = svc.importAssetFiles('p1', 'w1', [
      { srcPath: good, name: '', type: '头像' },
      { srcPath: good, name: '薇拉', type: '头像' } // .txt not allowed
    ])
    expect(res.imported).toBe(0)
    expect(res.skipped).toBe(2)
  })
  it('rejects a destination that escapes the assets root (traversal name)', () => {
    const src = srcImage('pic.png')
    const res = svc.importAssetFiles('p1', 'w1', [
      { srcPath: src, name: '../../evil', type: '头像' }
    ])
    expect(res.imported).toBe(0)
    expect(res.skipped).toBe(1)
    // Nothing landed outside the root.
    expect(fs.existsSync(path.join(tmp, 'profiles', 'p1', 'lorebooks', 'evil_头像.png'))).toBe(false)
  })
})

// WA-3: the write side of rptHost.requestAssetImport (the picker itself lives in the IPC layer). Copies
// one source under the convention and returns its rptasset:// URL; null on a bad arg / copy failure.
describe('importAssetForCard', () => {
  it('copies the pick and returns its rptasset:// URL', () => {
    const src = srcImage('pic.png')
    const url = svc.importAssetForCard('p1', 'w1', src, '薇拉', '相册', '02')
    expect(url).toBe(`rptasset://p1/w1/character/${encodeURIComponent('薇拉_相册_02.png')}`)
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_相册_02.png'))).toBe(true)
  })
  it('returns null for an unknown type or an empty name (never writes)', () => {
    const src = srcImage('pic.png')
    expect(svc.importAssetForCard('p1', 'w1', src, '薇拉', 'bogus' as any)).toBeNull()
    expect(svc.importAssetForCard('p1', 'w1', src, '  ', '头像')).toBeNull()
    expect(fs.existsSync(catDir('w1', 'character'))).toBe(false)
  })
  it('returns null when the copy is rejected (unsupported extension)', () => {
    const src = srcImage('a.txt')
    expect(svc.importAssetForCard('p1', 'w1', src, '薇拉', '头像')).toBeNull()
  })
})

describe('deleteAssetFile', () => {
  it('unlinks an existing file', () => {
    writeFile('w1', 'character', '薇拉_头像.png')
    expect(svc.deleteAssetFile('p1', 'w1', 'character', '薇拉_头像.png')).toBe(true)
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_头像.png'))).toBe(false)
  })
  it('refuses a traversal path', () => {
    writeFile('w1', 'character', '薇拉_头像.png')
    expect(svc.deleteAssetFile('p1', 'w1', 'character', '../../../etc/passwd')).toBe(false)
  })
})

describe('renameAssetVariant', () => {
  it('rewrites the variant token only, keeping name + type', () => {
    writeFile('w1', 'character', '薇拉_头像_微笑.png')
    const res = svc.renameAssetVariant('p1', 'w1', 'character', '薇拉_头像_微笑.png', '愤怒')
    expect(res).toEqual({ ok: true, file: '薇拉_头像_愤怒.png' })
    const parsed = parseAssetFilename('薇拉_头像_愤怒.png')
    expect(parsed?.name).toBe('薇拉')
    expect(parsed?.type).toBe('头像')
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_头像_愤怒.png'))).toBe(true)
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_头像_微笑.png'))).toBe(false)
  })
  it('promotes a base to a variant (empty → token)', () => {
    writeFile('w1', 'character', '薇拉_头像.png')
    const res = svc.renameAssetVariant('p1', 'w1', 'character', '薇拉_头像.png', '微笑')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.file).toBe('薇拉_头像_微笑.png')
  })
  it('rejects a collision with an existing file', () => {
    writeFile('w1', 'character', '薇拉_头像_微笑.png')
    writeFile('w1', 'character', '薇拉_头像_愤怒.png')
    const res = svc.renameAssetVariant('p1', 'w1', 'character', '薇拉_头像_微笑.png', '愤怒')
    expect(res).toEqual({ ok: false, error: 'collision' })
    // Original untouched.
    expect(fs.existsSync(path.join(catDir('w1', 'character'), '薇拉_头像_微笑.png'))).toBe(true)
  })
})

describe('exportAssetsZip round-trip', () => {
  it('writes a <category>/<file> zip that re-imports cleanly via importAssetsZip', () => {
    writeFile('w1', 'character', '薇拉_头像.png', 'A')
    writeFile('w1', 'character', '薇拉_相册_01.png', 'B')
    writeFile('w1', 'character', '薇拉_立绘bg.mp4', 'V')
    writeFile('w1', 'location', '雾港_全景.png', 'C')
    const zipPath = path.join(tmp, 'out.zip')
    const exp = svc.exportAssetsZip('p1', 'w1', zipPath)
    expect(exp).toEqual({ ok: true, entries: 4 })
    expect(fs.existsSync(zipPath)).toBe(true)

    // Import into a fresh world and compare the merged indexes.
    const imp = svc.importAssetsZip('p1', 'w2', zipPath)
    expect(imp.imported).toBe(4)
    const a = svc.getMergedIndex('p1', ['w1'])
    const b = svc.getMergedIndex('p1', ['w2'])
    expect(b).toEqual(a)
  })
})
