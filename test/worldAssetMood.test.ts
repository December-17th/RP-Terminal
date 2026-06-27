import { describe, it, expect } from 'vitest'
import { normalizeMood, currentMoodFor } from '../src/shared/worldAssets/mood'

describe('normalizeMood', () => {
  it('trims, lowercases ascii, and maps a synonym to its canonical token', () => {
    expect(normalizeMood('  Smile ')).toBe('微笑')
    expect(normalizeMood('微笑')).toBe('微笑')
    expect(normalizeMood('愤怒')).toBe('愤怒')
  })
})

describe('currentMoodFor', () => {
  it('reads a mood="..." attribute', () => {
    const text = '<dialogue name="爱莎" mood="愤怒">你来晚了。</dialogue>'
    expect(currentMoodFor('爱莎', text)).toBe('愤怒')
  })
  it('reads a [情绪]: structured field', () => {
    const text = '角色：爱莎\n[情绪]: 喜悦\n正文……'
    expect(currentMoodFor('爱莎', text)).toBe('喜悦')
  })
  it('reads a 情绪：fullwidth-colon field', () => {
    expect(currentMoodFor('爱莎', '情绪：悲伤')).toBe('悲伤')
  })
  it('returns the LAST mood when several appear (most recent wins)', () => {
    expect(currentMoodFor('爱莎', 'mood="微笑" ... mood="愤怒"')).toBe('愤怒')
  })
  it('picks the last mood by document position across pattern types (field then attr)', () => {
    expect(currentMoodFor('爱莎', '情绪：喜悦 ... mood="愤怒"')).toBe('愤怒')
  })
  it('picks the last mood by document position across pattern types (attr then field)', () => {
    expect(currentMoodFor('爱莎', 'mood="愤怒" ... 情绪：喜悦')).toBe('喜悦')
  })
  it('returns undefined when no mood is present', () => {
    expect(currentMoodFor('爱莎', '只是一段普通的旁白。')).toBeUndefined()
  })
})
