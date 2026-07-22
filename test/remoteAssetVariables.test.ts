import { describe, expect, it, vi } from 'vitest'
import {
  localFirstRemoteAssetUrl,
  remoteAssetFromVariables,
  remoteAssetsFromVariables
} from '../src/shared/worldAssets/remote'

describe('remote character assets from floor variables', () => {
  it('reads valid HTTPS char_info_visuals URLs and classifies the legacy field as 立绘bg', () => {
    expect(
      remoteAssetsFromVariables({
        char_info_visuals: {
          '傲雪': { url: 'https://files.catbox.moe/dvlb7l.png', other: '#fff' },
          '动画': { url: 'https://cdn.example.test/scene.mp4?rev=2' }
        }
      })
    ).toEqual([
      {
        name: '傲雪',
        type: '立绘bg',
        sourceUrl: 'https://files.catbox.moe/dvlb7l.png',
        hostname: 'files.catbox.moe',
        mediaKind: 'image'
      },
      {
        name: '动画',
        type: '立绘bg',
        sourceUrl: 'https://cdn.example.test/scene.mp4?rev=2',
        hostname: 'cdn.example.test',
        mediaKind: 'video'
      }
    ])
  })

  it('rejects malformed, credentialed, and non-HTTPS declarations', () => {
    expect(
      remoteAssetsFromVariables({
        char_info_visuals: {
          http: { url: 'http://example.test/a.png' },
          credentials: { url: 'https://user:pass@example.test/a.png' },
          malformed: { url: 'not a url' },
          missing: { color: '#fff' }
        }
      })
    ).toEqual([])
  })

  it('resolves one exact character name', () => {
    expect(
      remoteAssetFromVariables(
        { char_info_visuals: { '傲雪': { url: 'https://example.test/a.gif' } } },
        '傲雪'
      )?.sourceUrl
    ).toBe('https://example.test/a.gif')
  })
})

describe('local-first remote fallback shared by both card transports', () => {
  it('keeps a local 立绘bg and does not inspect remote state', async () => {
    const remote = vi.fn(() => 'rptremoteasset://asset/p/c/n')
    await expect(localFirstRemoteAssetUrl('rptasset://local', '立绘bg', remote)).resolves.toBe(
      'rptasset://local'
    )
    expect(remote).not.toHaveBeenCalled()
  })

  it('falls back only for 立绘bg; explicit 立绘 remains strict', async () => {
    const remote = vi.fn(() => 'rptremoteasset://asset/p/c/n')
    await expect(localFirstRemoteAssetUrl(null, '立绘bg', remote)).resolves.toBe(
      'rptremoteasset://asset/p/c/n'
    )
    await expect(localFirstRemoteAssetUrl(null, '立绘', remote)).resolves.toBeNull()
    expect(remote).toHaveBeenCalledTimes(1)
  })
})
