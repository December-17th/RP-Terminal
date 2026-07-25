import { describe, expect, it, vi } from 'vitest'
import {
  localFirstRemoteAssetUrl,
  MISC_REMOTE_ASSETS_VARIABLE,
  remoteAssetForKind,
  remoteAssetFromVariables,
  remoteAssetKindForUrlHost,
  remoteAssetsForKind,
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

// M2 regression guard: adding the second bag must not perturb the character path in any way.
describe('char_info_visuals behaviour is unchanged by the misc bag', () => {
  const variables = {
    char_info_visuals: { '傲雪': { url: 'https://files.catbox.moe/dvlb7l.png' } },
    [MISC_REMOTE_ASSETS_VARIABLE]: { '傲雪': { url: 'https://cdn.example.test/card.png' } }
  }

  it('reads only char_info_visuals, ignoring a same-named misc declaration', () => {
    expect(remoteAssetsFromVariables(variables)).toEqual([
      {
        name: '傲雪',
        type: '立绘bg',
        sourceUrl: 'https://files.catbox.moe/dvlb7l.png',
        hostname: 'files.catbox.moe',
        mediaKind: 'image'
      }
    ])
    expect(remoteAssetFromVariables(variables, '傲雪')?.sourceUrl).toBe(
      'https://files.catbox.moe/dvlb7l.png'
    )
  })

  it('is exactly the character kind of the generalised reader', () => {
    expect(remoteAssetsForKind(variables, 'character')).toEqual(
      remoteAssetsFromVariables(variables)
    )
    expect(remoteAssetForKind(variables, 'character', '傲雪')).toEqual(
      remoteAssetFromVariables(variables, '傲雪')
    )
  })

  it('returns nothing for a misc-only floor on the character path', () => {
    const miscOnly = { [MISC_REMOTE_ASSETS_VARIABLE]: { '火球术': { url: 'https://x.test/a.png' } } }
    expect(remoteAssetsFromVariables(miscOnly)).toEqual([])
    expect(remoteAssetFromVariables(miscOnly, '火球术')).toBeNull()
  })
})

describe('remote misc assets from floor variables', () => {
  it('uses the rpt_misc_assets bag and classifies declarations as misc', () => {
    expect(MISC_REMOTE_ASSETS_VARIABLE).toBe('rpt_misc_assets')
    expect(
      remoteAssetsForKind(
        {
          rpt_misc_assets: {
            '火球术': { url: 'https://cdn.example.test/fireball.png', tint: '#f00' },
            '陨星裂空': { url: 'https://cdn.example.test/meteor.mp4?rev=2' }
          }
        },
        'misc'
      )
    ).toEqual([
      {
        name: '火球术',
        type: 'misc',
        sourceUrl: 'https://cdn.example.test/fireball.png',
        hostname: 'cdn.example.test',
        mediaKind: 'image'
      },
      {
        name: '陨星裂空',
        type: 'misc',
        sourceUrl: 'https://cdn.example.test/meteor.mp4?rev=2',
        hostname: 'cdn.example.test',
        mediaKind: 'video'
      }
    ])
  })

  it('applies the same HTTPS/credential guard as the character bag', () => {
    expect(
      remoteAssetsForKind(
        {
          rpt_misc_assets: {
            http: { url: 'http://example.test/a.png' },
            credentials: { url: 'https://user:pass@example.test/a.png' },
            malformed: { url: 'not a url' },
            missing: { color: '#fff' },
            numeric: { url: 42 },
            '   ': { url: 'https://example.test/blank-name.png' }
          }
        },
        'misc'
      )
    ).toEqual([])
  })

  it('rejects a non-object or array bag', () => {
    expect(remoteAssetsForKind({ rpt_misc_assets: 'nope' }, 'misc')).toEqual([])
    expect(remoteAssetsForKind({ rpt_misc_assets: [{ url: 'https://x.test/a.png' }] }, 'misc')).toEqual(
      []
    )
    expect(remoteAssetsForKind({}, 'misc')).toEqual([])
    expect(remoteAssetsForKind(null, 'misc')).toEqual([])
  })

  it('resolves one exact misc name, and ignores a same-named character declaration', () => {
    const variables = {
      char_info_visuals: { '火球术': { url: 'https://files.catbox.moe/portrait.png' } },
      rpt_misc_assets: { '火球术': { url: 'https://cdn.example.test/fireball.png' } }
    }
    expect(remoteAssetForKind(variables, 'misc', '火球术')?.sourceUrl).toBe(
      'https://cdn.example.test/fireball.png'
    )
    expect(remoteAssetForKind(variables, 'misc', ' ')).toBeNull()
    expect(remoteAssetForKind(variables, 'misc', 'absent')).toBeNull()
  })
})

describe('protocol host ↔ kind mapping', () => {
  it('maps only the two known hosts', () => {
    expect(remoteAssetKindForUrlHost('asset')).toBe('character')
    expect(remoteAssetKindForUrlHost('misc')).toBe('misc')
    expect(remoteAssetKindForUrlHost('other')).toBeNull()
    expect(remoteAssetKindForUrlHost('')).toBeNull()
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

  it('lets misc fall back too, while every other type stays strict', async () => {
    const remote = vi.fn(() => 'rptremoteasset://misc/p/c/n')
    await expect(localFirstRemoteAssetUrl(null, 'misc', remote)).resolves.toBe(
      'rptremoteasset://misc/p/c/n'
    )
    for (const type of ['头像', '相册', '背景', '全景', 'CG', '', 'nonsense']) {
      await expect(localFirstRemoteAssetUrl(null, type, remote)).resolves.toBeNull()
    }
    expect(remote).toHaveBeenCalledTimes(1)
  })

  it('keeps "explicit local wins" for misc as well', async () => {
    const remote = vi.fn(() => 'rptremoteasset://misc/p/c/n')
    await expect(localFirstRemoteAssetUrl('rptasset://local', 'misc', remote)).resolves.toBe(
      'rptasset://local'
    )
    expect(remote).not.toHaveBeenCalled()
  })
})
