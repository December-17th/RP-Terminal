import { describe, it, expect, vi } from 'vitest'
import { createThRuntime } from '../src/shared/thRuntime'

// Minimal Host — stub only what createThRuntime touches at construction + assetUrl.
// (Mirror the fake-Host shape used in test/thRuntime.test.ts; add any other method the
//  constructor calls so it doesn't throw.)
function fakeHost(over = {}) {
  return {
    statData: () => ({}),
    onVarsChanged: () => () => {},
    onHostEvent: () => () => {},
    floors: () => [],
    charData: () => null,
    personaName: () => 'User',
    listWorldbooks: () => [],
    assetUrl: vi.fn(async () => 'rptasset://p/w/character/x.png'),
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
