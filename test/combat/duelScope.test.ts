// test/combat/duelScope.test.ts
import { describe, it, expect } from 'vitest'
import { parseCardItem } from '../../src/shared/combat/systems/poemD20'
import { applyAbilityEffect } from '../../src/shared/combat/deckbuilder/deckResolve'
import { makeRng } from '../../src/shared/combat/dice'
import type { AbilityDef, Combatant, CombatEvent } from '../../src/shared/combat/types'

describe('duel-scope grammar tags (lorebook ↔ parser contract)', () => {
  it('parses 群体 → 目标模式 群体', () => {
    const c = parseCardItem({ 类型: '主动', 标签: ['力量', '威力: 90', '群体'], 效果: {} }, 'skill')
    expect(c.目标模式).toBe('群体')
  })
  it('parses 随机3 → 目标模式 随机 with 随机次数 3', () => {
    const c = parseCardItem({ 类型: '主动', 标签: ['敏捷', '威力: 40', '随机3'], 效果: {} }, 'skill')
    expect(c.目标模式).toBe('随机')
    expect(c.随机次数).toBe(3)
  })
  it('a skill with no scope tag stays single-target (目标模式 undefined → 单体)', () => {
    const c = parseCardItem({ 类型: '主动', 标签: ['力量', '威力: 90'], 效果: {} }, 'skill')
    expect(c.目标模式).toBeUndefined()
  })
})

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

// minimal combatant with just enough block/ext for poemHitOne/poemHealOne; fields confirmed
// against src/shared/combat/types.ts (StatBlock requires speed/mods/abilities/conditions) and
// src/main/services/combatService.ts's block(...) helper / test/combat/deckbuilder/deckResolve.test.ts.
const mk = (id: string, side: 'party' | 'enemy', hp = 100): Combatant => ({
  id,
  side,
  name: id,
  pos: [0, 0],
  block: { hp, maxHp: hp, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [] },
  ext: { attrs: { 力量: 5, 精神: 5 }, tier: 1 }
})

const ability = (ext: Record<string, unknown>): AbilityDef =>
  ({ id: 'a/x', name: 'X', range: 1, shape: { kind: 'self' }, toHit: null, ext }) as AbilityDef

const resolvedTargets = (
  combatants: Combatant[],
  actorId: string,
  ab: AbilityDef,
  picked: string[]
): string[] => {
  const events: CombatEvent[] = []
  applyAbilityEffect(combatants, actorId, ab, picked, makeRng(1), undefined, events)
  const atk = events.find((e) => e.kind === 'attack')
  return (atk?.delta?.targets as string[]) ?? []
}

describe('scope-driven target selection', () => {
  it('单体 damage hits exactly the picked enemy', () => {
    const cs = [mk('hero', 'party'), mk('e1', 'enemy'), mk('e2', 'enemy')]
    expect(resolvedTargets(cs, 'hero', ability({ 威力: 20 }), ['e2'])).toEqual(['e2'])
  })
  it('群体 damage hits all living enemies', () => {
    const cs = [mk('hero', 'party'), mk('e1', 'enemy'), mk('e2', 'enemy')]
    expect(resolvedTargets(cs, 'hero', ability({ 威力: 20, 目标模式: '群体' }), []).sort()).toEqual([
      'e1',
      'e2'
    ])
  })
  it('随机X damage resolves X hits among enemies (with replacement)', () => {
    const cs = [mk('hero', 'party'), mk('e1', 'enemy'), mk('e2', 'enemy')]
    const hits = resolvedTargets(
      cs,
      'hero',
      ability({ 威力: 20, 目标模式: '随机', 随机次数: 4 }),
      []
    )
    expect(hits.length).toBe(4)
    expect(hits.every((id) => id === 'e1' || id === 'e2')).toBe(true)
  })
  it('群体 heal targets all living allies, not enemies', () => {
    const cs = [mk('hero', 'party'), mk('ally', 'party'), mk('e1', 'enemy')]
    const t = resolvedTargets(
      cs,
      'hero',
      ability({ 治疗: true, 威力: 10, 目标模式: '群体' }),
      []
    ).sort()
    expect(t).toEqual(['ally', 'hero'])
  })
  it('单体 heal targets the picked ally', () => {
    const cs = [mk('hero', 'party'), mk('ally', 'party'), mk('e1', 'enemy')]
    expect(resolvedTargets(cs, 'hero', ability({ 治疗: true, 威力: 10 }), ['ally'])).toEqual([
      'ally'
    ])
  })
})
