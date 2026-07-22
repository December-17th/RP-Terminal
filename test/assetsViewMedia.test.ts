import { describe, expect, it, vi } from 'vitest'
import {
  mediaKindForUrl,
  resolveCharacterPreview
} from '../src/renderer/src/components/workspace/assetMedia'

describe('asset thumbnail media resolution', () => {
  it('detects local MP4 URLs while leaving GIF on the image path', () => {
    expect(mediaKindForUrl('rptasset://p/lb/character/Vera_%E7%AB%8B%E7%BB%98bg.mp4')).toBe('video')
    expect(mediaKindForUrl('https://example.test/vera.gif?rev=2')).toBe('image')
  })

  it('uses standee, standee background, remote art, then avatar', async () => {
    const local = vi.fn(async (type: string) => (type === '头像' ? 'rptasset://avatar.png' : null))
    const result = await resolveCharacterPreview(local, {
      url: 'rptremoteasset://p/chat/Vera',
      mediaKind: 'video'
    })

    expect(local.mock.calls.map(([type]) => type)).toEqual(['立绘', '立绘bg'])
    expect(result).toEqual({ url: 'rptremoteasset://p/chat/Vera', mediaKind: 'video' })
  })

  it('keeps a local standee ahead of remote art', async () => {
    const local = vi.fn(async (type: string) =>
      type === '立绘' ? 'rptasset://p/lb/character/Vera_%E7%AB%8B%E7%BB%98.gif' : null
    )
    const result = await resolveCharacterPreview(local, {
      url: 'rptremoteasset://p/chat/Vera',
      mediaKind: 'image'
    })

    expect(local).toHaveBeenCalledTimes(1)
    expect(result?.url).toContain('rptasset://')
  })
})
