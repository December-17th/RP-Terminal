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

describe('sceneAssetUrlForWorld', () => {
  it('resolves a simple scene name from the final segment of a full location', () => {
    const full = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫-内廷-皇家迎宾偏厅'
    const file = '皇家迎宾偏厅_背景.png'
    writeLoc('w1', file)
    expect(svc.sceneAssetUrlForWorld('p1', ['w1'], full, '背景')).toBe(
      `rptasset://p1/w1/location/${encodeURIComponent(file)}`
    )
  })

  it('falls back to the closest available ancestor scene', () => {
    const full = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫-内廷-皇家迎宾偏厅'
    const file = '奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫_背景.png'
    writeLoc('w1', file)
    expect(svc.sceneAssetUrlForWorld('p1', ['w1'], full, '背景')).toBe(
      `rptasset://p1/w1/location/${encodeURIComponent(file)}`
    )
  })

  it('resolves a hierarchical location stored as a location-alias variant', () => {
    const full = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫-内廷-皇家迎宾偏厅'
    const file = `皇家迎宾偏厅_背景_${full}.png`
    writeLoc('w1', file)
    expect(svc.sceneAssetUrlForWorld('p1', ['w1'], full, '背景')).toBe(
      `rptasset://p1/w1/location/${encodeURIComponent(file)}`
    )
  })

  it('keeps exact base-name lookup ahead of partial aliases', () => {
    writeLoc('w1', '皇家迎宾偏厅_背景.png')
    writeLoc('w1', '皇家迎宾偏厅_背景_内廷-皇家迎宾偏厅.png')
    expect(svc.sceneAssetUrlForWorld('p1', ['w1'], '皇家迎宾偏厅', '背景')).toBe(
      `rptasset://p1/w1/location/${encodeURIComponent('皇家迎宾偏厅_背景.png')}`
    )
  })
})

// WA-3: assetList enumerates one entry's variants for a card. base first (variant:null), then variants
// naturally sorted; same lorebook-id precedence + category inference as assetUrl; [] on any miss.
describe('assetListForWorld', () => {
  it('lists the base first (variant:null) then variants, numeric-aware sorted', () => {
    write('w1', '薇拉_相册.png') // cover (base, no slot)
    write('w1', '薇拉_相册_10.png')
    write('w1', '薇拉_相册_2.png')
    const list = svc.assetListForWorld('p1', ['w1'], '薇拉', '相册')
    expect(list).toEqual([
      { variant: null, url: `rptasset://p1/w1/character/${encodeURIComponent('薇拉_相册.png')}` },
      // numeric-aware: 2 before 10 (a plain string sort would put "10" first).
      { variant: '2', url: `rptasset://p1/w1/character/${encodeURIComponent('薇拉_相册_2.png')}` },
      { variant: '10', url: `rptasset://p1/w1/character/${encodeURIComponent('薇拉_相册_10.png')}` }
    ])
  })
  it('omits the base when only variants exist', () => {
    write('w1', '爱莎_头像_愤怒.png')
    const list = svc.assetListForWorld('p1', ['w1'], '爱莎', '头像')
    expect(list).toEqual([
      { variant: '愤怒', url: `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像_愤怒.png')}` }
    ])
  })
  it('returns [] on a miss, an empty name, or an unknown type', () => {
    write('w1', '爱莎_头像.png')
    expect(svc.assetListForWorld('p1', ['w1'], '无名', '头像')).toEqual([])
    expect(svc.assetListForWorld('p1', ['w1'], '  ', '头像')).toEqual([])
    expect(svc.assetListForWorld('p1', ['w1'], '爱莎', '不存在' as any)).toEqual([])
  })
  it('honors lorebook-id precedence: the FIRST id carrying the entry wins (no cross-world merge)', () => {
    write('w1', '薇拉_相册.png')
    write('w2', '薇拉_相册_02.png') // later id — must NOT be merged into w1's entry
    const list = svc.assetListForWorld('p1', ['w1', 'w2'], '薇拉', '相册')
    expect(list).toEqual([
      { variant: null, url: `rptasset://p1/w1/character/${encodeURIComponent('薇拉_相册.png')}` }
    ])
  })
  it('resolves from a later id when the earlier one lacks the entry', () => {
    write('w2', '薇拉_相册_02.png')
    const list = svc.assetListForWorld('p1', ['w1', 'w2'], '薇拉', '相册')
    expect(list).toEqual([
      { variant: '02', url: `rptasset://p1/w2/character/${encodeURIComponent('薇拉_相册_02.png')}` }
    ])
  })
})
