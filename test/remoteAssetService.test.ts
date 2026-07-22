import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getChatRow: vi.fn(),
  getFloorCount: vi.fn(),
  getFloor: vi.fn()
}))

vi.mock('../src/main/services/db', () => ({
  getDb: () => ({ prepare: () => ({ get: mocks.getChatRow }) })
}))
vi.mock('../src/main/services/floorService', () => ({
  getFloorCount: mocks.getFloorCount,
  getFloor: mocks.getFloor
}))

import {
  clearRemoteAssetSourceCache,
  listRemoteAssets,
  resolveRemoteAssetSource,
  resolveRemoteAssetUrl
} from '../src/main/services/remoteAssetService'

beforeEach(() => {
  vi.clearAllMocks()
  clearRemoteAssetSourceCache()
  mocks.getChatRow.mockReturnValue({ present: 1 })
  mocks.getFloorCount.mockReturnValue(2)
  mocks.getFloor.mockReturnValue({
    variables: {
      char_info_visuals: { '傲雪': { url: 'https://files.catbox.moe/dvlb7l.png' } }
    }
  })
})

describe('latest-floor remote asset resolution', () => {
  it('lists proxy URLs from only the newest floor', () => {
    expect(listRemoteAssets('p1', 'c1')).toEqual([
      {
        name: '傲雪',
        type: '立绘bg',
        sourceUrl: 'https://files.catbox.moe/dvlb7l.png',
        hostname: 'files.catbox.moe',
        mediaKind: 'image',
        url: expect.stringMatching(
          new RegExp(`^rptremoteasset://asset/p1/c1/${encodeURIComponent('傲雪')}\\?v=[a-f0-9]{12}$`)
        )
      }
    ])
    expect(resolveRemoteAssetSource('p1', 'c1', 'old')).toBeNull()
    expect(resolveRemoteAssetUrl('p1', 'c1', '傲雪')).toMatch(
      new RegExp(`^rptremoteasset://asset/p1/c1/${encodeURIComponent('傲雪')}\\?v=[a-f0-9]{12}$`)
    )
    expect(mocks.getFloor).toHaveBeenCalledWith('p1', 'c1', 1)
  })

  it('rejects a chat outside the requested profile before reading floors', () => {
    mocks.getChatRow.mockReturnValue(undefined)
    expect(listRemoteAssets('other-profile', 'c1')).toEqual([])
    expect(mocks.getFloorCount).not.toHaveBeenCalled()
  })
})

describe('resolveRemoteAssetSource TTL micro-cache', () => {
  it('serves a repeated key from cache, reading the floor once', () => {
    expect(resolveRemoteAssetSource('p1', 'c1', '傲雪')).toBe(
      'https://files.catbox.moe/dvlb7l.png'
    )
    expect(resolveRemoteAssetSource('p1', 'c1', '傲雪')).toBe(
      'https://files.catbox.moe/dvlb7l.png'
    )
    expect(mocks.getFloor).toHaveBeenCalledTimes(1)
  })

  it('re-reads after the cache is cleared', () => {
    resolveRemoteAssetSource('p1', 'c1', '傲雪')
    clearRemoteAssetSourceCache()
    resolveRemoteAssetSource('p1', 'c1', '傲雪')
    expect(mocks.getFloor).toHaveBeenCalledTimes(2)
  })

  it('re-reads once the TTL elapses', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      resolveRemoteAssetSource('p1', 'c1', '傲雪')
      vi.setSystemTime(2999)
      resolveRemoteAssetSource('p1', 'c1', '傲雪')
      expect(mocks.getFloor).toHaveBeenCalledTimes(1)
      vi.setSystemTime(3001)
      resolveRemoteAssetSource('p1', 'c1', '傲雪')
      expect(mocks.getFloor).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caches a null resolution', () => {
    expect(resolveRemoteAssetSource('p1', 'c1', 'missing')).toBeNull()
    expect(resolveRemoteAssetSource('p1', 'c1', 'missing')).toBeNull()
    expect(mocks.getFloor).toHaveBeenCalledTimes(1)
  })
})
