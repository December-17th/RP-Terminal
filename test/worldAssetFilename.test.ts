import { describe, it, expect } from 'vitest'
import { parseAssetFilename, buildAssetFilename } from '../src/shared/worldAssets/filename'
import { assetMediaKindForExt } from '../src/shared/worldAssets/types'

describe('parseAssetFilename', () => {
  it('classifies image and video extensions separately', () => {
    expect(assetMediaKindForExt('GIF')).toBe('image')
    expect(assetMediaKindForExt('mp4')).toBe('video')
    expect(assetMediaKindForExt('bmp')).toBeNull()
  })
  it('parses base avatar', () => {
    expect(parseAssetFilename('爱莎_头像.jpg')).toEqual({
      name: '爱莎',
      type: '头像',
      mood: undefined,
      ext: 'jpg'
    })
  })
  it('parses a mood variant', () => {
    expect(parseAssetFilename('爱莎_头像_愤怒.png')).toEqual({
      name: '爱莎',
      type: '头像',
      mood: '愤怒',
      ext: 'png'
    })
  })
  it('trims stray whitespace and lowercases the extension', () => {
    expect(parseAssetFilename('爱莎_立绘 .JPG ')).toEqual({
      name: '爱莎',
      type: '立绘',
      mood: undefined,
      ext: 'jpg'
    })
  })
  it('keeps underscores that belong to the name (anchors on the type token)', () => {
    expect(parseAssetFilename('赛博_坦克_立绘.webp')).toEqual({
      name: '赛博_坦克',
      type: '立绘',
      mood: undefined,
      ext: 'webp'
    })
  })
  it('normalizes jpeg and accepts location types', () => {
    expect(parseAssetFilename('王城_背景.jpeg')).toEqual({
      name: '王城',
      type: '背景',
      mood: undefined,
      ext: 'jpeg'
    })
  })
  it('parses a stage portrait variant with the jpe extension', () => {
    expect(parseAssetFilename('爱莎_立绘_舞台.jpe')).toEqual({
      name: '爱莎',
      type: '立绘',
      mood: '舞台',
      ext: 'jpe'
    })
  })
  it('keeps 立绘 and 立绘bg as distinct types', () => {
    expect(parseAssetFilename('爱莎_立绘.png')?.type).toBe('立绘')
    expect(parseAssetFilename('爱莎_立绘bg.png')?.type).toBe('立绘bg')
  })
  it('accepts GIF for composited and full-frame art', () => {
    expect(parseAssetFilename('爱莎_立绘.gif')?.ext).toBe('gif')
    expect(parseAssetFilename('爱莎_立绘bg.gif')?.ext).toBe('gif')
  })
  it('accepts MP4 only for background-bearing types', () => {
    for (const type of ['立绘bg', '背景', '全景', 'CG'] as const) {
      expect(parseAssetFilename(`场景_${type}.mp4`)?.type).toBe(type)
    }
    for (const type of ['头像', '立绘', '相册'] as const) {
      expect(parseAssetFilename(`爱莎_${type}.mp4`)).toBeNull()
    }
  })
  it('refuses to build an invalid transparent MP4 filename', () => {
    expect(() => buildAssetFilename({ name: '爱莎', type: '立绘', ext: 'mp4' })).toThrow(
      /not supported/
    )
  })
  // 相册/CG join ASSET_TYPES with NO parser change — the right-to-left type scan finds them.
  it('parses a 相册 gallery cover (base) and a numbered slot', () => {
    expect(parseAssetFilename('薇拉_相册.png')).toEqual({
      name: '薇拉',
      type: '相册',
      mood: undefined,
      ext: 'png'
    })
    expect(parseAssetFilename('薇拉_相册_02.png')).toEqual({
      name: '薇拉',
      type: '相册',
      mood: '02',
      ext: 'png'
    })
  })
  it('keeps an underscore inside a 相册 slot label (mood token rejoins segments)', () => {
    expect(parseAssetFilename('薇拉_相册_夏日_01.png')).toEqual({
      name: '薇拉',
      type: '相册',
      mood: '夏日_01',
      ext: 'png'
    })
  })
  it('parses a CG base and a scene-variant, keyed by scene id', () => {
    expect(parseAssetFilename('初遇_CG.png')).toEqual({
      name: '初遇',
      type: 'CG',
      mood: undefined,
      ext: 'png'
    })
    expect(parseAssetFilename('初遇_CG_雨夜.png')).toEqual({
      name: '初遇',
      type: 'CG',
      mood: '雨夜',
      ext: 'png'
    })
  })
  it('keeps an underscore in the scene id before the CG token', () => {
    expect(parseAssetFilename('初_遇_CG_雨夜.png')).toEqual({
      name: '初_遇',
      type: 'CG',
      mood: '雨夜',
      ext: 'png'
    })
  })
  it('round-trips a CG variant through buildAssetFilename', () => {
    const p = { name: '初遇', type: 'CG' as const, mood: '雨夜', ext: 'png' as const }
    expect(parseAssetFilename(buildAssetFilename(p))).toEqual(p)
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
