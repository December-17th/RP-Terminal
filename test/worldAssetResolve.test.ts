import { describe, it, expect } from 'vitest'
import { resolveAsset } from '../src/shared/worldAssets/resolve'
import { AssetIndex } from '../src/shared/worldAssets/types'

const idx = (entry: AssetIndex['character']): AssetIndex => ({ character: entry })

describe('resolveAsset', () => {
  const withMood: AssetIndex = idx({
    爱莎: { 头像: { base: '爱莎_头像.jpg', moods: { 愤怒: '爱莎_头像_愤怒.png' } } }
  })

  it('prefers the mood variant when the mood matches', () => {
    expect(
      resolveAsset({
        indexes: [withMood],
        category: 'character',
        name: '爱莎',
        type: '头像',
        mood: '愤怒'
      })
    ).toEqual({ indexPos: 0, filename: '爱莎_头像_愤怒.png', usedMood: '愤怒' })
  })
  it('falls back to base when the mood has no variant', () => {
    expect(
      resolveAsset({
        indexes: [withMood],
        category: 'character',
        name: '爱莎',
        type: '头像',
        mood: '困惑'
      })
    ).toEqual({ indexPos: 0, filename: '爱莎_头像.jpg', usedMood: null })
  })
  it('uses base when no mood is requested', () => {
    expect(
      resolveAsset({ indexes: [withMood], category: 'character', name: '爱莎', type: '头像' })
    ).toEqual({ indexPos: 0, filename: '爱莎_头像.jpg', usedMood: null })
  })
  it('matches a mood through normalization (smile -> 微笑)', () => {
    const i = idx({ 爱莎: { 头像: { moods: { 微笑: '爱莎_头像_微笑.jpg' } } } })
    expect(
      resolveAsset({
        indexes: [i],
        category: 'character',
        name: '爱莎',
        type: '头像',
        mood: 'smile'
      })
    ).toEqual({ indexPos: 0, filename: '爱莎_头像_微笑.jpg', usedMood: '微笑' })
  })
  it('returns null when nothing matches', () => {
    expect(
      resolveAsset({ indexes: [withMood], category: 'character', name: '无名', type: '头像' })
    ).toBeNull()
  })
  it('tries indexes in order; the first match wins', () => {
    const a: AssetIndex = idx({ 爱莎: { 立绘: { base: 'a.png', moods: {} } } })
    const b: AssetIndex = idx({ 爱莎: { 立绘: { base: 'b.png', moods: {} } } })
    expect(
      resolveAsset({ indexes: [a, b], category: 'character', name: '爱莎', type: '立绘' })
    ).toEqual({ indexPos: 0, filename: 'a.png', usedMood: null })
  })
})
