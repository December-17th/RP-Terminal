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

// M2: the `misc` bag is a SECOND namespace keyed by the same kind of name. The protocol URL host and
// the micro-cache key both have to carry the kind, or one bag silently serves the other's art.
describe('kind-aware misc remote assets', () => {
  const bothBags = {
    variables: {
      char_info_visuals: { '火球术': { url: 'https://files.catbox.moe/portrait.png' } },
      rpt_misc_assets: {
        '火球术': { url: 'https://cdn.example.test/fireball.png' },
        '陨星裂空': { url: 'https://cdn.example.test/meteor.mp4' }
      }
    }
  }

  it('lists the misc bag under the misc host', () => {
    mocks.getFloor.mockReturnValue(bothBags)
    expect(listRemoteAssets('p1', 'c1', 'misc')).toEqual([
      {
        name: '火球术',
        type: 'misc',
        sourceUrl: 'https://cdn.example.test/fireball.png',
        hostname: 'cdn.example.test',
        mediaKind: 'image',
        url: expect.stringMatching(
          new RegExp(`^rptremoteasset://misc/p1/c1/${encodeURIComponent('火球术')}\\?v=[a-f0-9]{12}$`)
        )
      },
      {
        name: '陨星裂空',
        type: 'misc',
        sourceUrl: 'https://cdn.example.test/meteor.mp4',
        hostname: 'cdn.example.test',
        mediaKind: 'video',
        url: expect.stringMatching(
          new RegExp(
            `^rptremoteasset://misc/p1/c1/${encodeURIComponent('陨星裂空')}\\?v=[a-f0-9]{12}$`
          )
        )
      }
    ])
  })

  it('defaults to the character kind, keeping existing call sites byte-identical', () => {
    mocks.getFloor.mockReturnValue(bothBags)
    expect(listRemoteAssets('p1', 'c1')).toEqual(listRemoteAssets('p1', 'c1', 'character'))
    expect(listRemoteAssets('p1', 'c1')).toEqual([
      {
        name: '火球术',
        type: '立绘bg',
        sourceUrl: 'https://files.catbox.moe/portrait.png',
        hostname: 'files.catbox.moe',
        mediaKind: 'image',
        url: expect.stringMatching(
          new RegExp(`^rptremoteasset://asset/p1/c1/${encodeURIComponent('火球术')}\\?v=[a-f0-9]{12}$`)
        )
      }
    ])
    expect(resolveRemoteAssetUrl('p1', 'c1', '火球术')).toBe(
      resolveRemoteAssetUrl('p1', 'c1', '火球术', 'character')
    )
  })

  // THE collision case: one name declared in BOTH bags, resolved back-to-back inside the TTL window.
  // A kind-less cache key would hand the second call the first call's URL.
  it('does not let a cached character resolution leak into a misc lookup (or vice versa)', () => {
    mocks.getFloor.mockReturnValue(bothBags)

    expect(resolveRemoteAssetSource('p1', 'c1', '火球术', 'character')).toBe(
      'https://files.catbox.moe/portrait.png'
    )
    expect(resolveRemoteAssetSource('p1', 'c1', '火球术', 'misc')).toBe(
      'https://cdn.example.test/fireball.png'
    )
    // Repeat in the opposite order — both are now cached under distinct keys.
    expect(resolveRemoteAssetSource('p1', 'c1', '火球术', 'misc')).toBe(
      'https://cdn.example.test/fireball.png'
    )
    expect(resolveRemoteAssetSource('p1', 'c1', '火球术', 'character')).toBe(
      'https://files.catbox.moe/portrait.png'
    )
    expect(mocks.getFloor).toHaveBeenCalledTimes(2)

    expect(resolveRemoteAssetUrl('p1', 'c1', '火球术', 'misc')).toMatch(
      new RegExp(`^rptremoteasset://misc/p1/c1/${encodeURIComponent('火球术')}\\?v=[a-f0-9]{12}$`)
    )
    expect(resolveRemoteAssetUrl('p1', 'c1', '火球术', 'character')).toMatch(
      new RegExp(`^rptremoteasset://asset/p1/c1/${encodeURIComponent('火球术')}\\?v=[a-f0-9]{12}$`)
    )
    // Different bags ⇒ different source URLs ⇒ different revision query.
    expect(resolveRemoteAssetUrl('p1', 'c1', '火球术', 'misc')).not.toBe(
      resolveRemoteAssetUrl('p1', 'c1', '火球术', 'character')
    )
  })

  it('misses a name that exists only in the other bag', () => {
    mocks.getFloor.mockReturnValue(bothBags)
    expect(resolveRemoteAssetSource('p1', 'c1', '陨星裂空', 'character')).toBeNull()
    expect(resolveRemoteAssetUrl('p1', 'c1', '陨星裂空', 'character')).toBeNull()
    expect(resolveRemoteAssetSource('p1', 'c1', '陨星裂空', 'misc')).toBe(
      'https://cdn.example.test/meteor.mp4'
    )
  })

  it('returns an empty misc list for a chat outside the requested profile', () => {
    mocks.getChatRow.mockReturnValue(undefined)
    expect(listRemoteAssets('other-profile', 'c1', 'misc')).toEqual([])
    expect(mocks.getFloorCount).not.toHaveBeenCalled()
  })
})
