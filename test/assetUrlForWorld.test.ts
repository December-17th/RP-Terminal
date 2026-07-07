// test/assetUrlForWorld.test.ts
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

const catDir = (lb: string, cat: 'character' | 'location'): string =>
  path.join(tmp, 'profiles', 'p1', 'lorebooks', `${lb}.assets`, cat)
const write = (lb: string, file: string): void => {
  const dir = catDir(lb, 'character')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), 'img')
}
const writeLoc = (lb: string, file: string): void => {
  const dir = catDir(lb, 'location')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), 'img')
}

beforeEach(() => {
  svc.clearAssetCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-aufw-'))
})
afterEach(() => {
  svc.clearAssetCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('assetUrlForWorld', () => {
  it('builds an rptasset:// URL for a resolved portrait (encoded file)', () => {
    write('w1', '爱莎_头像.jpg')
    expect(svc.assetUrlForWorld('p1', ['w1'], '爱莎', '头像')).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像.jpg')}`
    )
  })
  it('prefers a mood variant', () => {
    write('w1', '爱莎_头像.jpg')
    write('w1', '爱莎_头像_愤怒.png')
    expect(svc.assetUrlForWorld('p1', ['w1'], '爱莎', '头像', '愤怒')).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像_愤怒.png')}`
    )
  })
  it('returns null when no asset resolves', () => {
    expect(svc.assetUrlForWorld('p1', ['w1'], '无名', '头像')).toBeNull()
  })

  // PM-A6: the category is inferred from the asset TYPE (categoryForType), so location-category
  // types (背景/全景) resolve from the `location` index — not only character portraits.
  it('resolves a 全景 (panorama) from the location index', () => {
    writeLoc('w1', '雾港_全景.png')
    expect(svc.assetUrlForWorld('p1', ['w1'], '雾港', '全景')).toBe(
      `rptasset://p1/w1/location/${encodeURIComponent('雾港_全景.png')}`
    )
  })
  it('resolves a 背景 (background) from the location index', () => {
    writeLoc('w1', '王座厅_背景.jpg')
    expect(svc.assetUrlForWorld('p1', ['w1'], '王座厅', '背景')).toBe(
      `rptasset://p1/w1/location/${encodeURIComponent('王座厅_背景.jpg')}`
    )
  })
  it('does NOT cross categories: a 全景 name filed only under character never hits', () => {
    // A character-category file that happens to share the location name must not satisfy a 全景
    // lookup (category is scoped by categoryForType('全景') === 'location').
    write('w1', '雾港_头像.png')
    expect(svc.assetUrlForWorld('p1', ['w1'], '雾港', '全景')).toBeNull()
  })
})
