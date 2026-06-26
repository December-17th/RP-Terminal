import { describe, it, expect } from 'vitest'
import { poemResolveAction } from '../../src/shared/combat/systems/poemD20'
import type { ResolverContext, DeriveConfig } from '../../src/shared/combat/bundle'
import type { AbilityDef, Action, Combatant, CombatState } from '../../src/shared/combat/types'
import type { Rng } from '../../src/shared/combat/dice'

const derive: DeriveConfig = {
  tier_coefficient: { '1': 2.0, '2': 2.8, '3': 4.0 },
  rating_tiers: [
    [30, 2.0],
    [25, 1.6],
    [20, 1.3],
    [11, 1.0],
    [8, 0.8],
    [4, 0.3],
    [0, 0]
  ],
  attr_mitigation: { 物理: 0.0025 },
  defense_constant: 2000
}

/** A stub RNG that makes every d20 land on `n` (rollDie = floor(v*20)+1). */
const fixedRoll =
  (n: number): Rng =>
  () =>
    (n - 0.5) / 20

const attacker = (over: Partial<Combatant> = {}): Combatant => ({
  id: 'A',
  side: 'party',
  name: '主角',
  pos: [0, 0],
  block: {
    hp: 800,
    maxHp: 800,
    ac: 10,
    speed: 6,
    mods: { DEX: 4 },
    abilities: ['A/火球术'],
    conditions: []
  },
  ext: {
    system: 'poemD20',
    attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 },
    tier: 2,
    mp: 250,
    sp: 450,
    equip: { 武器攻击: 60, 防御: 50, 命中: 1, 闪避: 2, DR: 0 },
    passives: []
  },
  ...over
})

const target = (over: Partial<Combatant> = {}): Combatant => ({
  id: 'B',
  side: 'enemy',
  name: '哥布林',
  pos: [1, 0],
  block: { hp: 500, maxHp: 500, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [] },
  ext: {
    system: 'poemD20',
    attrs: { 力量: 3, 敏捷: 5, 体质: 4, 智力: 1, 精神: 2 },
    tier: 2,
    equip: { 武器攻击: 0, 防御: 100, 命中: 0, 闪避: 3, DR: 10 },
    passives: []
  },
  ...over
})

const fireball: AbilityDef = {
  id: 'A/火球术',
  name: '火球术',
  range: 6,
  shape: { kind: 'self' },
  toHit: null,
  cost: 'attack',
  ext: {
    关联属性: '智力',
    威力: 300,
    消耗: { slot: 'attack', mp: 200 },
    附加效果: [{ 状态: '灼烧', 数值: 30, 回合: 2 }]
  }
}

const state = (combatants: Combatant[]): CombatState => ({
  seed: 1,
  rngCursor: 0,
  grid: { w: 10, h: 8, cellFt: 5 },
  combatants,
  initiative: combatants.map((c) => c.id),
  turnIndex: 0,
  round: 1,
  log: [],
  status: 'active'
})

const ctx = (s: CombatState, action: Action, rng: Rng): ResolverContext => ({
  state: s,
  action,
  abilities: { 'A/火球术': fireball },
  rng,
  derive
})

const cast = (
  rng: Rng,
  abilityExt?: Record<string, unknown>
): ReturnType<typeof poemResolveAction> => {
  const ab = abilityExt ? { ...fireball, ext: { ...fireball.ext, ...abilityExt } } : fireball
  const s = state([attacker(), target()])
  return poemResolveAction({
    ...ctx(s, { kind: 'ability', actor: 'A', abilityId: 'A/火球术', targetIds: ['B'] }, rng),
    abilities: { 'A/火球术': ab }
  })
}

describe('poemResolveAction — 战斗协议 damage', () => {
  it('有效 (评级 ×1.0): 构成 → 装备减免 → 属性减免 → ×K → DR', () => {
    // d20 15, 命中 max(0,1)=1, 闪避 3 → 总值 13 → 评级 1.0.
    // 构成 = 智力2×10×系数2.8 + 威力300 + 武器60 = 416
    // 装备减免: 416×2000/(100+2000)=396.19; 属性减免 (4+3+5)×0.0025=0.03 → ×0.97 = 384.30
    // ×1.0, DR10 → ×0.9 = 345.87 → 345
    const res = cast(fixedRoll(15))!
    const b = res.state!.combatants.find((c) => c.id === 'B')!
    expect(b.block.hp).toBe(155)
    const dmg = res.events!.find((e) => e.kind === 'damage')!
    expect(dmg.delta).toMatchObject({ damage: 345, rating: 1.0 })
    // opposition for 灼烧 fails at this roll → no condition.
    expect(b.block.conditions).toEqual([])
    // MP 消耗 deducted once.
    expect((res.state!.combatants[0].ext as any).mp).toBe(50)
  })

  it('暴击 (评级 ×1.3) auto-applies 附加效果', () => {
    // give 火球术 命中 +8 → 总值 15+8−3 = 20 → 评级 1.3; status auto-applies on 暴击.
    const res = cast(fixedRoll(15), { 命中: 8 })!
    const b = res.state!.combatants.find((c) => c.id === 'B')!
    // 384.30 ×1.3 = 499.60, ×0.9 = 449.6 → 449 → hp 51
    expect(b.block.hp).toBe(51)
    expect(b.block.conditions).toEqual([{ id: '灼烧', duration: 2 }])
  })

  it('百分比 伤害增幅 raises outgoing damage (×(1+amp) before DR)', () => {
    // baseline at this roll deals 345; +50% before DR → 384.30×1.5×0.9 = 518.8 → 518.
    const a = attacker({ ext: { ...attacker().ext, 伤害增幅: 50 } as Record<string, unknown> })
    const s = state([a, target()])
    const res = poemResolveAction(
      ctx(
        s,
        { kind: 'ability', actor: 'A', abilityId: 'A/火球术', targetIds: ['B'] },
        fixedRoll(15)
      )
    )!
    expect((res.events!.find((e) => e.kind === 'damage')!.delta as any).damage).toBe(518)
  })

  it('护盾 absorbs damage before HP, depleting the pool', () => {
    // baseline computed damage 345; a 200 shield absorbs 200 → 145 reaches HP (500→355), shield→0.
    const b = target({ ext: { ...target().ext, shield: 200 } as Record<string, unknown> })
    const s = state([attacker(), b])
    const res = poemResolveAction(
      ctx(
        s,
        { kind: 'ability', actor: 'A', abilityId: 'A/火球术', targetIds: ['B'] },
        fixedRoll(15)
      )
    )!
    const after = res.state!.combatants.find((c) => c.id === 'B')!
    expect(after.block.hp).toBe(355)
    expect((after.ext as any).shield).toBe(0)
    expect((res.events!.find((e) => e.kind === 'damage')!.delta as any).shieldAbsorbed).toBe(200)
  })

  it('治疗 heals an ally (no 命中检定; 治疗增幅 amplifies; only same-side)', () => {
    const heal: AbilityDef = {
      id: 'A/治疗术',
      name: '治疗术',
      range: 4,
      shape: { kind: 'self' },
      toHit: null,
      cost: 'action',
      ext: { 治疗: true, 关联属性: '精神', 威力: 200, 治疗增幅: 50 }
    }
    const ally: Combatant = {
      id: 'C',
      side: 'party',
      name: '盟友',
      pos: [0, 1],
      block: { hp: 100, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
      ext: { system: 'poemD20', attrs: {}, tier: 2 } as Record<string, unknown>
    }
    const s = state([attacker(), ally, target()])
    // base = 精神3×10×系数2.8 + 威力200 = 284; ×(1+50%) = 426; HP 100 → 526.
    const healed = poemResolveAction({
      ...ctx(
        s,
        { kind: 'ability', actor: 'A', abilityId: 'A/治疗术', targetIds: ['C'] },
        fixedRoll(15)
      ),
      abilities: { 'A/治疗术': heal }
    })!
    expect(healed.state!.combatants.find((c) => c.id === 'C')!.block.hp).toBe(526)
    expect(healed.events!.some((e) => e.kind === 'heal')).toBe(true)

    // Aiming the heal at an enemy heals no one (same-side filter) — B is untouched.
    const onEnemy = poemResolveAction({
      ...ctx(
        s,
        { kind: 'ability', actor: 'A', abilityId: 'A/治疗术', targetIds: ['B'] },
        fixedRoll(15)
      ),
      abilities: { 'A/治疗术': heal }
    })!
    expect(onEnemy.events!.some((e) => e.kind === 'heal')).toBe(false)
  })

  it('失手 (评级 0) → miss, no damage', () => {
    const res = cast(fixedRoll(2))! // 总值 2+1−3 = 0 → 0
    const b = res.state!.combatants.find((c) => c.id === 'B')!
    expect(b.block.hp).toBe(500)
    expect(res.events!.some((e) => e.kind === 'miss')).toBe(true)
    expect(res.events!.some((e) => e.kind === 'damage')).toBe(false)
  })

  it('layer advantage: higher 生命层级 rolls with advantage (2d20 high)', () => {
    const s = state([attacker({ ext: { ...attacker().ext, tier: 3 } as any }), target()])
    // tier 3 vs 2 → adv; tier diff is 1 so 闪避 still applies. Just assert it resolves to damage.
    const res = poemResolveAction(
      ctx(
        s,
        { kind: 'ability', actor: 'A', abilityId: 'A/火球术', targetIds: ['B'] },
        fixedRoll(15)
      )
    )!
    expect(res.events!.some((e) => e.kind === 'damage')).toBe(true)
  })
})

describe('poemResolveAction — fall-through to native', () => {
  it('returns null for non-ability actions', () => {
    const s = state([attacker(), target()])
    expect(
      poemResolveAction(ctx(s, { kind: 'move', actor: 'A', to: [1, 1] }, fixedRoll(10)))
    ).toBeNull()
    expect(poemResolveAction(ctx(s, { kind: 'end', actor: 'A' }, fixedRoll(10)))).toBeNull()
  })

  it('returns null when the aimed cell is out of range (engine reports it, no budget spent)', () => {
    const melee: AbilityDef = {
      id: 'A/普攻',
      name: '普攻',
      range: 1,
      shape: { kind: 'self' },
      toHit: null,
      cost: 'attack',
      ext: { 威力: 20 }
    }
    const s = state([attacker(), target({ pos: [5, 0] })])
    // Aim the melee template at the far cell — distance 5 > range 1 → fall through to native.
    const res = poemResolveAction({
      ...ctx(
        s,
        { kind: 'ability', actor: 'A', abilityId: 'A/普攻', targetCell: [5, 0] },
        fixedRoll(15)
      ),
      abilities: { 'A/普攻': melee }
    })
    expect(res).toBeNull()
  })
})
