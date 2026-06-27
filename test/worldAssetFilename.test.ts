import { describe, it, expect } from 'vitest'
import { parseAssetFilename, buildAssetFilename } from '../src/shared/worldAssets/filename'

describe('parseAssetFilename', () => {
  it('parses base avatar', () => {
    expect(parseAssetFilename('爱莎_头像.jpg')).toEqual({
      name: '爱莎', type: '头像', mood: undefined, ext: 'jpg'
    })
  })
  it('parses a mood variant', () => {
    expect(parseAssetFilename('爱莎_头像_愤怒.png')).toEqual({
      name: '爱莎', type: '头像', mood: '愤怒', ext: 'png'
    })
  })
  it('trims stray whitespace and lowercases the extension', () => {
    expect(parseAssetFilename('爱莎_立绘 .JPG ')).toEqual({
      name: '爱莎', type: '立绘', mood: undefined, ext: 'jpg'
    })
  })
  it('keeps underscores that belong to the name (anchors on the type token)', () => {
    expect(parseAssetFilename('赛博_坦克_立绘.webp')).toEqual({
      name: '赛博_坦克', type: '立绘', mood: undefined, ext: 'webp'
    })
  })
  it('normalizes jpeg and accepts location types', () => {
    expect(parseAssetFilename('王城_背景.jpeg')).toEqual({
      name: '王城', type: '背景', mood: undefined, ext: 'jpeg'
    })
  })
  it('returns null when no known type token is present', () => {
    expect(parseAssetFilename('爱莎_随手图.png')).toBeNull()
  })
  it('returns null for an unsupported extension', () => {
    expect(parseAssetFilename('爱莎_头像.bmp')).toBeNull()
  })
  it('round-trips through buildAssetFilename', () => {
    const p = { name: '爱莎', type: '头像' as const, mood: '愤怒', ext: 'png' as const }
    expect(parseAssetFilename(buildAssetFilename(p))).toEqual({ ...p, mood: '愤怒' })
  })
})
