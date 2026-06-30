// test/combat/duelScope.test.ts
import { describe, it, expect } from 'vitest'
import { parseCardItem } from '../../src/shared/combat/systems/poemD20'

describe('duel scope tag parse', () => {
  it('parses 群体 / 随机X / default 单体, leaving grid shape alone', () => {
    const aoe = parseCardItem({ 标签: ['智力', '威力: 100', '群体'] }, '技能')
    expect(aoe.目标模式).toBe('群体')
    const rng = parseCardItem({ 标签: ['力量', '威力: 60', '随机3'] }, '技能')
    expect(rng.目标模式).toBe('随机')
    expect(rng.随机次数).toBe(3)
    const single = parseCardItem({ 标签: ['力量', '威力: 20'] }, '技能')
    expect(single.目标模式).toBeUndefined() // → resolver treats as 单体
    // a bare 单体/爆发 stays a GRID shape, not the duel scope
    // (AoeShape has no 'blast' kind — 爆发 parses to 'burst'; see src/shared/combat/types.ts:85)
    const grid = parseCardItem({ 标签: ['威力: 40', '爆发', '有效距离: 3'] }, '技能')
    expect(grid.shape?.kind).toBe('burst')
    expect(grid.目标模式).toBeUndefined()
  })
})
