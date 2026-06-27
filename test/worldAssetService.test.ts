// test/worldAssetService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmp: string
// Point the service's app dir at a temp dir by mocking storageService.getAppDir.
vi.mock('../src/main/services/storageService', async () => {
  const actual = await vi.importActual<any>('../src/main/services/storageService')
  return { ...actual, getAppDir: () => tmp }
})

import * as svc from '../src/main/services/worldAssetService'

const charDir = (lb: string) =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, 'character')
const write = (lb: string, file: string) => {
  const d = charDir(lb)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, file), 'img-bytes')
}

beforeEach(() => {
  svc.clearAssetCache() // module-level cache/watchers persist across tests — reset for isolation
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-assets-'))
})
afterEach(() => {
  svc.clearAssetCache() // close watchers BEFORE rmSync so Windows can delete the watched dir
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildIndex / getIndex', () => {
  it('indexes base + mood variants and skips _index.json and .thumbs', () => {
    write('w1', '爱莎_头像.jpg')
    write('w1', '爱莎_头像_愤怒.png')
    write('w1', '爱莎_立绘.webp')
    fs.writeFileSync(path.join(charDir('w1'), '_index.json'), '{}')
    fs.mkdirSync(path.join(charDir('w1'), '.thumbs'), { recursive: true })
    const idx = svc.getIndex('p1', 'w1', { refresh: true })
    expect(idx.character['爱莎']['头像']).toEqual({
      base: '爱莎_头像.jpg', moods: { 愤怒: '爱莎_头像_愤怒.png' }
    })
    expect(idx.character['爱莎']['立绘'].base).toBe('爱莎_立绘.webp')
  })
})

describe('resolveProtocolPath', () => {
  it('returns the absolute file path for a valid asset', () => {
    write('w1', '爱莎_头像.jpg')
    const p = svc.resolveProtocolPath('p1', 'w1', 'character', '爱莎_头像.jpg')
    expect(p).toBe(path.join(charDir('w1'), '爱莎_头像.jpg'))
  })
  it('rejects path traversal', () => {
    write('w1', '爱莎_头像.jpg')
    expect(svc.resolveProtocolPath('p1', 'w1', 'character', '..%2f..%2fsecret')).toBeNull()
    expect(svc.resolveProtocolPath('p1', 'w1', 'character', '../../../etc/passwd')).toBeNull()
  })
  it('returns null for a missing file', () => {
    expect(svc.resolveProtocolPath('p1', 'w1', 'character', '无.jpg')).toBeNull()
  })
  it('rejects an unknown / traversal category', () => {
    write('w1', '爱莎_头像.jpg')
    expect(svc.resolveProtocolPath('p1', 'w1', 'evil', '爱莎_头像.jpg')).toBeNull()
    expect(svc.resolveProtocolPath('p1', 'w1', 'character/..', '爱莎_头像.jpg')).toBeNull()
  })
})

describe('resolveAssetFile', () => {
  it('resolves across lorebook ids in order and reports the matched id', () => {
    write('w2', '爱莎_立绘.png')
    const r = svc.resolveAssetFile('p1', ['w1', 'w2'], 'character', '爱莎', '立绘')
    expect(r?.lorebookId).toBe('w2')
    expect(r?.absPath).toBe(path.join(charDir('w2'), '爱莎_立绘.png'))
  })
})

describe('listCoverage', () => {
  it('merges folder names with the roster', () => {
    write('w1', '爱莎_头像.jpg')
    const rows = svc.listCoverage('p1', ['w1'], 'character', ['爱莎', '旅人'])
    expect(rows.map((r) => r.name).sort()).toEqual(['旅人', '爱莎'])
    expect(rows.find((r) => r.name === '旅人')!.hasAvatar).toBe(false)
  })
})
