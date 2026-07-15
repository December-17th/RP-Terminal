import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'
import { createNullHost } from '../src/shared/thRuntime/nullHost'

// Spread the inert null host and override ONLY the asset members this file exercises; the
// construction stubs (statData/floors/charData/…) come from createNullHost's neutrals.
function fakeHost(over = {}) {
  return {
    ...createNullHost(),
    assetUrl: vi.fn(async () => 'rptasset://p/w/character/x.png'),
    assetList: vi.fn(async () => [
      { variant: null, url: 'rptasset://p/w/character/薇拉_相册.png' },
      { variant: '02', url: 'rptasset://p/w/character/薇拉_相册_02.png' }
    ]),
    requestAssetImport: vi.fn(async () => 'rptasset://p/w/character/薇拉_头像.png'),
    ...over
  } as any
}

describe('createThRuntime exposes assetUrl to the card page', () => {
  it('forwards top-level assetUrl(name,type,mood) to host.assetUrl', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    await g.assetUrl('爱莎', '头像', '愤怒')
    expect(host.assetUrl).toHaveBeenCalledWith('爱莎', '头像', '愤怒')
  })
  it('also exposes it on the TavernHelper sub-object', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    expect(typeof g.TavernHelper.assetUrl).toBe('function')
    await g.TavernHelper.assetUrl('凯尔', '立绘')
    expect(host.assetUrl).toHaveBeenCalledWith('凯尔', '立绘', undefined)
  })
})

describe('createThRuntime exposes sceneAssetUrl to the card page', () => {
  it('forwards to a scene-aware host', async () => {
    const sceneAssetUrl = vi.fn(async () => 'rptasset://p/w/location/scene.png')
    const host = fakeHost({ sceneAssetUrl })
    const g = createThRuntime(host)
    expect(await g.sceneAssetUrl('内廷-皇家迎宾偏厅', '背景')).toContain('scene.png')
    expect(sceneAssetUrl).toHaveBeenCalledWith('内廷-皇家迎宾偏厅', '背景')
  })

  it('also exposes sceneAssetUrl on TavernHelper', async () => {
    const sceneAssetUrl = vi.fn(async () => 'rptasset://p/w/location/scene.png')
    const host = fakeHost({ sceneAssetUrl })
    const g = createThRuntime(host)
    await g.TavernHelper.sceneAssetUrl('宏伟皇宫-内廷', '背景')
    expect(sceneAssetUrl).toHaveBeenCalledWith('宏伟皇宫-内廷', '背景')
  })
})

// WA-3: assetList + requestAssetImport ride the SAME Host seam, so pinning the shared facade proves both
// transports (inline cardBridge + WCV wcvPreload) inherit them identically — the parity guarantee.
describe('createThRuntime exposes assetList to the card page (WA-3)', () => {
  it('forwards top-level assetList(name,type) to host.assetList and returns its ordered array', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    const list = await g.assetList('薇拉', '相册')
    expect(host.assetList).toHaveBeenCalledWith('薇拉', '相册')
    // base (variant:null) first, then variant tokens — the shape both transports must return.
    expect(list).toEqual([
      { variant: null, url: 'rptasset://p/w/character/薇拉_相册.png' },
      { variant: '02', url: 'rptasset://p/w/character/薇拉_相册_02.png' }
    ])
  })
  it('also exposes assetList on the TavernHelper sub-object (namespaced parity)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    expect(typeof g.TavernHelper.assetList).toBe('function')
    await g.TavernHelper.assetList('雾港', '全景')
    expect(host.assetList).toHaveBeenCalledWith('雾港', '全景')
  })
})

describe('createThRuntime exposes requestAssetImport to the card page (WA-3)', () => {
  it('forwards top-level requestAssetImport(arg) to host.requestAssetImport (coerced)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    const url = await g.requestAssetImport({ name: '薇拉', type: '头像' })
    expect(host.requestAssetImport).toHaveBeenCalledWith({
      name: '薇拉',
      type: '头像',
      variant: undefined
    })
    expect(url).toBe('rptasset://p/w/character/薇拉_头像.png')
  })
  it('returns null when the host import resolves null (cancel/invalid path)', async () => {
    const host = fakeHost({ requestAssetImport: vi.fn(async () => null) })
    const g = createThRuntime(host)
    expect(await g.requestAssetImport({ name: '薇拉', type: '相册', variant: '03' })).toBeNull()
    expect(host.requestAssetImport).toHaveBeenCalledWith({
      name: '薇拉',
      type: '相册',
      variant: '03'
    })
  })
  it('also exposes requestAssetImport on the TavernHelper sub-object (namespaced parity)', async () => {
    const host = fakeHost()
    const g = createThRuntime(host)
    expect(typeof g.TavernHelper.requestAssetImport).toBe('function')
    await g.TavernHelper.requestAssetImport({ name: '初遇', type: 'CG' })
    expect(host.requestAssetImport).toHaveBeenCalledWith({
      name: '初遇',
      type: 'CG',
      variant: undefined
    })
  })
})
