# 命定之诗 STS Duel — Headless Engine (D1–D3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless, deterministic, unit-tested 命定之诗 Slay-the-Spire **duel engine** — deck construction, the draw/play/discard/energy turn loop, card resolution via the card's `<战斗协议>` math, telegraphed companion/enemy intents, and down-not-dead victory — with **no UI** and **no app/IPC** dependencies.

**Architecture:** A new pure module `src/shared/combat/deckbuilder/` that sits beside the grid engine and **reuses** the existing combat primitives. The 命定之诗 strike math (`poemHitOne`/`poemHealOne`) is first extracted from `systems/poemD20.ts` into a shared `systems/poemStrike.ts` so both the grid resolver and the new deck resolver call it. The deck engine targets by combatant **id** (no grid), keeps STS state (piles/energy/intents) on top of the existing `Combatant`/`ext` model, and derives every roll from `(seed, rngCursor)` so a duel is reproducible.

**Tech Stack:** TypeScript (strict), Vitest (`npm run test` → `vitest run`), the existing `src/shared/combat` core (`dice.ts`, `resolver.ts`, `types.ts`, `bundle.ts`, `systems/poemD20.ts`). No new dependencies.

This plan implements phases **D1–D3** of [the design spec](../specs/2026-06-30-poem-sts-card-duel-design.md). Phases D4 (native `DuelView`), D5 (AI touchpoints), D6 (bundle + card import), and D7 (scripted-card sandbox) are **out of scope** — they get their own plans. The scripted-card `vars` field and `script?` flag are therefore **not** added here (YAGNI until D7).

## Global Constraints

- **Pure module:** everything under `src/shared/combat/deckbuilder/` and `src/shared/combat/systems/` must NOT import from `src/main` or `src/renderer` (no electron/window/fs/sqlite). Verified by `npm run check:deps` (dependency-cruiser). Reuse only `./types`, `./dice`, `./resolver`, `./bundle`, `./systems/*`.
- **Determinism:** all randomness flows through the injected `Rng` (`makeRng(seed)` / `(seed, rngCursor)`); never `Math.random`. Clone-then-mutate (use `clone` from `../../objectPath`) so callers keep their copy — mirror `engine.ts`.
- **Reuse, don't fork:** card resolution math lives once, in `poemStrike.ts`. The deck engine never re-implements 评级/伤害/护盾 math.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit. One logical change per commit.
- **Verification gate (every task's final step runs it):** `npm run typecheck && npm run check:deps && npm run test`.
- **Existing characterization tests must stay green** — especially `test/combat/poemResolver.test.ts`, `test/combat/mvuImport.test.ts`, `test/combat/poemIntegration.test.ts`. The Task 2 extraction is behavior-preserving.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/combat/systems/poemStrike.ts` (new) | The 命定之诗 strike primitives extracted from `poemD20.ts`: `ATTRS`/`Attr`/`CardCombat`/`CombatantExt`, `extOf`, the 评级 table + mitigation helpers, and `poemHitOne`/`poemHealOne`. Grid-independent. |
| `src/shared/combat/systems/poemD20.ts` (modify) | Keeps parse/build/grid-resolver; imports the strike primitives from `poemStrike`. |
| `src/shared/combat/deckbuilder/deckTypes.ts` (new) | `DuelState`, `CardInstance`, `Intent`, `DeckConfig`, `DEFAULT_DECK_CONFIG`, and small pure selectors (`leadCombatant`, `aliveOnSide`). |
| `src/shared/combat/deckbuilder/deckBuild.ts` (new) | `buildDeck(combatant, catalog, config)` — kit→deck (basics + 格挡 synth + skill copies by 品质) + `energyCostFor`. |
| `src/shared/combat/deckbuilder/deckResolve.ts` (new) | `applyAbilityEffect(...)` (shared attack/heal/block applier over `poemStrike`) + `resolvePlay(...)` (energy/resource/HP cost + effect + card→discard). |
| `src/shared/combat/deckbuilder/intents.ts` (new) | `chooseIntent(...)` (deterministic telegraph) + `resolveIntent(...)` (executes a telegraphed action via `applyAbilityEffect`). |
| `src/shared/combat/deckbuilder/deckEngine.ts` (new) | `startDuel`, `drawHand`, `playCard`, `endLeadTurn`, `checkDuelVictory`, `swapLeadIfDown` — the turn loop. |
| `src/shared/combat/deckbuilder/index.ts` (new) | Re-exports + `buildDuelFromMvu` (binds `poemD20System` to `buildEncounterFromMvu`). |
| `test/combat/deckbuilder/*.test.ts` (new) | One test file per module above + a full integration test. |

---

## Task 1: Duel model + selectors (`deckTypes.ts`)

**Files:**
- Create: `src/shared/combat/deckbuilder/deckTypes.ts`
- Test: `test/combat/deckbuilder/deckTypes.test.ts`

**Interfaces:**
- Consumes: `Combatant`, `CombatEvent`, `Side` from `../types`.
- Produces:
  - `type CardId = string`
  - `interface CardInstance { id: CardId; abilityId: string; owner: string; energyCost: number; exhaust?: boolean }`
  - `type IntentKind = 'attack' | 'block' | 'buff' | 'heal'`
  - `interface Intent { kind: IntentKind; abilityId?: string; target?: string; preview?: number }`
  - `type DuelPhase = 'lead' | 'allies' | 'enemies'`
  - `type DuelStatus = 'active' | 'party' | 'enemy'`
  - `interface DuelState { seed; rngCursor; combatants: Combatant[]; lead: string; energy: { current: number; max: number }; piles: { draw: CardId[]; hand: CardId[]; discard: CardId[]; exhaust: CardId[] }; cards: Record<CardId, CardInstance>; intents: Record<string, Intent>; phase: DuelPhase; round: number; status: DuelStatus; log: CombatEvent[]; handSize: number }`
  - `interface DeckConfig { handSize: number; energy: number; basics: { 普攻: number; 格挡: number }; copies: Record<string, number>; energyCostByQuality: Record<string, number>; blockFraction: number }`
  - `const DEFAULT_DECK_CONFIG: DeckConfig`
  - `leadCombatant(state: DuelState): Combatant | undefined`
  - `aliveOnSide(state: DuelState, side: Side): Combatant[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_DECK_CONFIG, leadCombatant, aliveOnSide } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { DuelState } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { Combatant } from '../../../src/shared/combat/types'

const C = (id: string, side: Combatant['side'], hp = 100): Combatant => ({
  id, side, name: id, pos: [0, 0],
  block: { hp, maxHp: 100, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [] }
})

const duel = (combatants: Combatant[], lead: string): DuelState => ({
  seed: 1, rngCursor: 0, combatants, lead,
  energy: { current: 3, max: 3 },
  piles: { draw: [], hand: [], discard: [], exhaust: [] },
  cards: {}, intents: {}, phase: 'lead', round: 1, status: 'active', log: [], handSize: 5
})

describe('deckTypes selectors', () => {
  it('DEFAULT_DECK_CONFIG has sane defaults', () => {
    expect(DEFAULT_DECK_CONFIG.handSize).toBe(5)
    expect(DEFAULT_DECK_CONFIG.energy).toBe(3)
    expect(DEFAULT_DECK_CONFIG.basics).toEqual({ 普攻: 4, 格挡: 4 })
  })

  it('leadCombatant returns the lead', () => {
    const s = duel([C('主角', 'party'), C('哥布林', 'enemy')], '主角')
    expect(leadCombatant(s)?.id).toBe('主角')
  })

  it('aliveOnSide filters by side and excludes downed (hp 0)', () => {
    const s = duel([C('主角', 'party'), C('苏璃', 'party', 0), C('哥布林', 'enemy')], '主角')
    expect(aliveOnSide(s, 'party').map((c) => c.id)).toEqual(['主角'])
    expect(aliveOnSide(s, 'enemy').map((c) => c.id)).toEqual(['哥布林'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/deckTypes.test.ts`
Expected: FAIL — cannot find module `deckTypes`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/deckTypes.ts
//
// Pure model for the 命定之诗 deckbuilder duel (STS mode). Sits on top of the existing
// Combatant/ext model (src/shared/combat/types.ts); targeting is by combatant id, not grid.
// See docs/superpowers/specs/2026-06-30-poem-sts-card-duel-design.md §3.

import type { Combatant, CombatEvent, Side } from '../types'

export type CardId = string

export interface CardInstance {
  id: CardId
  abilityId: string
  owner: string
  energyCost: number
  exhaust?: boolean
}

export type IntentKind = 'attack' | 'block' | 'buff' | 'heal'

export interface Intent {
  kind: IntentKind
  abilityId?: string
  target?: string
  preview?: number
}

export type DuelPhase = 'lead' | 'allies' | 'enemies'
export type DuelStatus = 'active' | 'party' | 'enemy'

export interface DuelState {
  seed: number
  rngCursor: number
  combatants: Combatant[]
  lead: string
  energy: { current: number; max: number }
  piles: { draw: CardId[]; hand: CardId[]; discard: CardId[]; exhaust: CardId[] }
  cards: Record<CardId, CardInstance>
  intents: Record<string, Intent>
  phase: DuelPhase
  round: number
  status: DuelStatus
  log: CombatEvent[]
  handSize: number
}

export interface DeckConfig {
  handSize: number
  energy: number
  basics: { 普攻: number; 格挡: number }
  /** 品质 → copies of a skill card in the deck. */
  copies: Record<string, number>
  /** 品质 → energy cost of a skill card (basics cost 1). */
  energyCostByQuality: Record<string, number>
  /** 格挡 grants 护盾 = round(maxHp × blockFraction). */
  blockFraction: number
}

export const DEFAULT_DECK_CONFIG: DeckConfig = {
  handSize: 5,
  energy: 3,
  basics: { 普攻: 4, 格挡: 4 },
  copies: { 普通: 2, 优良: 2, 精良: 1, 史诗: 1, 传说: 1, 神: 1 },
  energyCostByQuality: { 普通: 1, 优良: 1, 精良: 2, 史诗: 2, 传说: 3, 神: 3 },
  blockFraction: 0.05
}

export const leadCombatant = (state: DuelState): Combatant | undefined =>
  state.combatants.find((c) => c.id === state.lead)

export const aliveOnSide = (state: DuelState, side: Side): Combatant[] =>
  state.combatants.filter((c) => c.side === side && c.block.hp > 0)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/deckbuilder/deckTypes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/combat/deckbuilder/deckTypes.ts test/combat/deckbuilder/deckTypes.test.ts
git commit -m "feat(duel): deckbuilder duel state model + selectors"
```

---

## Task 2: Extract the poem strike math (`poemStrike.ts`)

Behavior-preserving refactor: move the grid-independent strike functions out of `poemD20.ts` so the deck engine can reuse them. The existing `test/combat/poemResolver.test.ts` is the safety net — it must stay green unchanged.

**Files:**
- Create: `src/shared/combat/systems/poemStrike.ts`
- Modify: `src/shared/combat/systems/poemD20.ts` (remove the moved code, import it back)
- Test: `test/combat/poemResolver.test.ts` (existing — unchanged, must pass), `test/combat/deckbuilder/poemStrike.test.ts` (new — pins the extracted functions directly)

**Interfaces:**
- Consumes: `applyDamageAmount`, `isAlive` from `../resolver`; `rollD20`, `type Rng` from `../dice`; `Combatant`, `CombatEvent`, `AbilityDef` from `../types`; `DeriveConfig` from `../bundle`.
- Produces (exported from `poemStrike.ts`):
  - `const ATTRS = ['力量','敏捷','体质','智力','精神'] as const`; `type Attr = (typeof ATTRS)[number]`
  - `interface CardCombat { … }` (the full shape currently in `poemD20.ts`)
  - `interface CombatantExt { … }`; `const extOf: (c: Combatant) => CombatantExt`
  - `poemHitOne(actor, target, ability, rng, derive, events): void`
  - `poemHealOne(actor, target, ability, derive, events): void`

- [ ] **Step 1: Write the failing test (pins the extracted module directly)**

```ts
// test/combat/deckbuilder/poemStrike.test.ts
import { describe, it, expect } from 'vitest'
import { poemHitOne, ATTRS } from '../../../src/shared/combat/systems/poemStrike'
import type { CardCombat } from '../../../src/shared/combat/systems/poemStrike'
import type { AbilityDef, Combatant, CombatEvent } from '../../../src/shared/combat/types'
import type { Rng } from '../../../src/shared/combat/dice'

const fixedRoll = (n: number): Rng => () => (n - 0.5) / 20

const actor = (): Combatant => ({
  id: 'A', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 800, maxHp: 800, ac: 10, speed: 6, mods: { DEX: 4 }, abilities: [], conditions: [] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2, equip: { 武器攻击: 60, 防御: 50, 命中: 1, 闪避: 2, DR: 0 }, passives: [] }
})
const target = (): Combatant => ({
  id: 'B', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp: 500, maxHp: 500, ac: 10, speed: 6, mods: {}, abilities: [], conditions: [] },
  ext: { system: 'poemD20', attrs: { 力量: 3, 敏捷: 5, 体质: 4, 智力: 1, 精神: 2 }, tier: 2, equip: { 武器攻击: 0, 防御: 100, 命中: 0, 闪避: 3, DR: 10 }, passives: [] }
})
const fireball: AbilityDef = {
  id: 'A/火球术', name: '火球术', range: 6, shape: { kind: 'self' }, toHit: null, cost: 'attack',
  ext: { 关联属性: '智力', 威力: 300 } as CardCombat as Record<string, unknown>
}
const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[30, 2.0], [25, 1.6], [20, 1.3], [11, 1.0], [8, 0.8], [4, 0.3], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

describe('poemStrike.poemHitOne (extracted)', () => {
  it('exports ATTRS in canonical order', () => {
    expect([...ATTRS]).toEqual(['力量', '敏捷', '体质', '智力', '精神'])
  })

  it('有效 (评级 ×1.0) deals damage and lowers HP', () => {
    const a = actor(), b = target()
    const events: CombatEvent[] = []
    poemHitOne(a, b, fireball, fixedRoll(15), derive, events)
    expect(b.block.hp).toBe(155)
    expect(events.find((e) => e.kind === 'damage')?.delta).toMatchObject({ damage: 345, rating: 1.0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/poemStrike.test.ts`
Expected: FAIL — cannot find module `poemStrike`.

- [ ] **Step 3: Create `poemStrike.ts` with the moved code**

Move these out of `poemD20.ts` **verbatim** into the new file (they are currently lines ~34–78 for `ATTRS`/`Attr`/`CardCombat`, and the BP3 block `extOf`/`DEFAULT_RATING`/`rating`/`physMitFraction`/`targetDR`/`opposition`/`poemHitOne`/`poemHealOne`). The full new file:

```ts
// src/shared/combat/systems/poemStrike.ts
//
// 命定之诗 strike primitives — the grid-INDEPENDENT half of the <战斗协议> resolver,
// extracted from poemD20.ts so BOTH the grid resolver (poemD20.poemResolveAction) and the
// deckbuilder duel resolver reuse the exact same 检定→评级→伤害→护盾→状态 math.
// Pure module. See docs/combat-poem-of-destiny-expansion.md and the duel spec §5.1.

import { rollD20, type Rng } from '../dice'
import { applyDamageAmount } from '../resolver'
import type { AbilityDef, Combatant, CombatEvent } from '../types'
import type { DeriveConfig } from '../bundle'

/** The five attributes, in canonical order (also `derive.attributes`). */
export const ATTRS = ['力量', '敏捷', '体质', '智力', '精神'] as const
export type Attr = (typeof ATTRS)[number]

/** Normalized combat numbers parsed off one 技能/装备, carried on `AbilityDef.ext` / combatant ext. */
export interface CardCombat {
  品质?: string
  类型?: string
  关联属性?: Attr
  威力?: number
  攻击?: number
  防御?: number
  消耗?: { slot: 'attack' | 'action'; mp?: number; sp?: number; hp?: number }
  range?: number
  shape?: import('../types').AoeShape
  范围目标?: number
  命中?: number
  闪避?: number
  先攻?: number
  抵抗?: number
  额外固定伤害?: number
  DR?: number
  穿透?: number
  暴击倍率?: number
  伤害增幅?: number
  护盾?: number
  治疗?: boolean
  治疗增幅?: number
  治疗量?: number
  附加效果?: { 状态: string; 数值?: number; 回合: number }[]
  多段?: number
  需视线?: boolean
}

/** The shape buildCombatant writes into `Combatant.ext`. */
export interface CombatantExt {
  attrs?: Record<string, number>
  tier?: number
  mp?: number
  sp?: number
  equip?: { 武器攻击?: number; 防御?: number; 命中?: number; 闪避?: number; DR?: number }
  伤害增幅?: number
  治疗增幅?: number
  shield?: number
  passives?: { name: string; combat: CardCombat }[]
}

export const extOf = (c: Combatant): CombatantExt => (c.ext ?? {}) as CombatantExt

const DEFAULT_RATING: [number, number][] = [
  [30, 2.0],
  [25, 1.6],
  [20, 1.3],
  [11, 1.0],
  [8, 0.8],
  [4, 0.3],
  [0, 0]
]

/** 检定总值 → 评级系数 (first tier whose threshold the total meets). */
const rating = (total: number, derive?: DeriveConfig): number => {
  for (const [thr, mult] of derive?.rating_tiers ?? DEFAULT_RATING) if (total >= thr) return mult
  return 0
}

/** 属性减免 fraction (physical only — typed-damage split is a later refinement). */
const physMitFraction = (tExt: CombatantExt, derive?: DeriveConfig): number => {
  const a = tExt.attrs ?? {}
  const f = derive?.attr_mitigation?.物理 ?? 0.0025
  return Math.min(0.9, ((a.体质 ?? 0) + (a.力量 ?? 0) + (a.敏捷 ?? 0)) * f)
}

const targetDR = (tExt: CombatantExt): number => {
  let dr = tExt.equip?.DR ?? 0
  for (const p of tExt.passives ?? []) if (p.combat.DR) dr = Math.max(dr, p.combat.DR)
  return dr
}

/** 附加效果 opposition: (攻方关联属性 + d20) vs (守方 max(体质,精神) + d20). */
const opposition = (attackerAttrV: number, tExt: CombatantExt, rng: Rng): boolean => {
  const a = tExt.attrs ?? {}
  const tResist = Math.max(a.体质 ?? 0, a.精神 ?? 0)
  return attackerAttrV + rollD20(rng).natural >= tResist + rollD20(rng).natural
}

/** Resolve one attacker→target strike per 战斗协议 第三阶段 (评级 → 伤害 → 状态), appending events. */
export const poemHitOne = (
  actor: Combatant,
  target: Combatant,
  ability: AbilityDef,
  rng: Rng,
  derive: DeriveConfig | undefined,
  events: CombatEvent[]
): void => {
  const aExt = extOf(actor)
  const tExt = extOf(target)
  const cc = (ability.ext ?? {}) as CardCombat & { 武器攻击?: number }
  const atkTier = aExt.tier ?? 1
  const defTier = tExt.tier ?? 1

  const roll = rollD20(rng, { adv: atkTier > defTier, dis: atkTier < defTier })
  const 命中 = Math.max(cc.命中 ?? 0, aExt.equip?.命中 ?? 0)
  let 闪避 = tExt.equip?.闪避 ?? 0
  if (atkTier > defTier + 1) 闪避 = 0
  const total = roll.natural + 命中 - 闪避
  const K = rating(total, derive)
  if (K <= 0) {
    events.push({
      kind: 'miss',
      text: `${actor.name} misses ${target.name} (检定 ${total}).`,
      delta: { target: target.id, total }
    })
    return
  }

  const attr = (cc.关联属性 ?? '力量') as Attr
  const attrV = aExt.attrs?.[attr] ?? 0
  const coeff = derive?.tier_coefficient?.[String(atkTier)] ?? 1
  const 威力 = cc.威力 ?? 20
  const 武器攻击 = cc.武器攻击 ?? aExt.equip?.武器攻击 ?? 0
  const 构成 = attrV * 10 * coeff + 威力 + 武器攻击
  const defConst = derive?.defense_constant ?? 2000
  const effDef = (tExt.equip?.防御 ?? 0) * (1 - (cc.穿透 ?? 0) / 100)
  const afterEquip = 构成 * (defConst / (effDef + defConst))
  const J = afterEquip * (1 - physMitFraction(tExt, derive))
  const hits = cc.多段 && cc.多段 > 1 ? cc.多段 : 1
  let dmg = J * K + (cc.额外固定伤害 ?? 0) * hits
  const amp = (cc.伤害增幅 ?? 0) + (aExt.伤害增幅 ?? 0)
  if (amp) dmg *= 1 + amp / 100
  dmg *= 1 - targetDR(tExt) / 100
  dmg = Math.max(0, Math.floor(dmg))

  let absorbed = 0
  if (tExt.shield && tExt.shield > 0 && dmg > 0) {
    absorbed = Math.min(tExt.shield, dmg)
    tExt.shield -= absorbed
    dmg -= absorbed
  }
  const dealt = applyDamageAmount(target, dmg)
  events.push({
    kind: 'damage',
    text: `${target.name} takes ${dealt}${absorbed ? ` (护盾吸收 ${absorbed})` : ''} (评级 ×${K}) — HP ${target.block.hp}/${target.block.maxHp}.`,
    delta: {
      target: target.id,
      damage: dealt,
      hp: target.block.hp,
      rating: K,
      ...(absorbed ? { shieldAbsorbed: absorbed, shieldLeft: tExt.shield } : {})
    }
  })

  const eff = cc.附加效果 ?? []
  if (eff.length) {
    const apply = K >= 1.3 ? true : K >= 0.8 ? opposition(attrV, tExt, rng) : false
    if (apply) {
      for (const e of eff)
        if (!target.block.conditions.some((c) => c.id === e.状态))
          target.block.conditions.push({ id: e.状态, duration: e.回合 })
      events.push({
        kind: 'condition',
        text: `${target.name}: ${eff.map((e) => e.状态).join(', ')}.`,
        delta: { target: target.id, conditions: eff.map((e) => e.状态) }
      })
    }
  }

  if (target.block.hp <= 0)
    events.push({
      kind: 'death',
      text: `${target.name} is down!`,
      delta: { target: target.id, dead: true }
    })
}

/** Resolve one heal: restore HP to an ally — no 命中检定, no mitigation; 治疗增幅 amplifies. */
export const poemHealOne = (
  actor: Combatant,
  target: Combatant,
  ability: AbilityDef,
  derive: DeriveConfig | undefined,
  events: CombatEvent[]
): void => {
  const aExt = extOf(actor)
  const cc = (ability.ext ?? {}) as CardCombat
  const attr = (cc.关联属性 ?? '精神') as Attr
  const attrV = aExt.attrs?.[attr] ?? 0
  const coeff = derive?.tier_coefficient?.[String(aExt.tier ?? 1)] ?? 1
  const base = (cc.治疗 ? attrV * 10 * coeff + (cc.威力 ?? 0) : 0) + (cc.治疗量 ?? 0)
  const amp = (cc.治疗增幅 ?? 0) + (aExt.治疗增幅 ?? 0)
  const heal = Math.max(0, Math.floor(base * (1 + amp / 100)))
  const before = target.block.hp
  target.block.hp = Math.min(target.block.maxHp, before + heal)
  events.push({
    kind: 'heal',
    text: `${target.name} recovers ${target.block.hp - before} — HP ${target.block.hp}/${target.block.maxHp}.`,
    delta: { target: target.id, heal: target.block.hp - before, hp: target.block.hp }
  })
}
```

- [ ] **Step 4: Rewrite `poemD20.ts` to import the extracted code**

In `src/shared/combat/systems/poemD20.ts`:
1. **Delete** the local declarations now living in `poemStrike.ts`: `ATTRS`, `Attr`, `CardCombat`, the `CombatantExt` interface, `extOf`, `DEFAULT_RATING`, `rating`, `physMitFraction`, `targetDR`, `opposition`, `poemHitOne`, `poemHealOne`.
2. **Add** this import near the top (after the existing imports):

```ts
import {
  ATTRS,
  poemHitOne,
  poemHealOne,
  type Attr,
  type CardCombat,
  type CombatantExt
} from './poemStrike'
```

3. Keep everything else unchanged: `parseShape`, `scanEffectProse`, `parseCardItem`, `tierNum`, `get`, `conditionFrom`, `buildCombatant`, `poemResolveAction`, `poemD20System`. They reference `ATTRS`/`Attr`/`CardCombat`/`poemHitOne`/`poemHealOne`, now imported.
4. Re-export the strike types so existing importers of `poemD20` keep working: add

```ts
export { ATTRS, type Attr, type CardCombat } from './poemStrike'
```

- [ ] **Step 5: Run the new + existing strike tests**

Run: `npx vitest run test/combat/deckbuilder/poemStrike.test.ts test/combat/poemResolver.test.ts test/combat/mvuImport.test.ts test/combat/poemIntegration.test.ts`
Expected: PASS (all). If `poemResolver.test.ts` imports `ATTRS`/`CardCombat` from `poemD20`, the re-export in step 4.4 keeps it green.

- [ ] **Step 6: Full gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/shared/combat/systems/poemStrike.ts src/shared/combat/systems/poemD20.ts test/combat/deckbuilder/poemStrike.test.ts
git commit -m "refactor(combat): extract grid-independent poem strike math into poemStrike"
```

---

## Task 3: Deck construction (`deckBuild.ts`)

**Files:**
- Create: `src/shared/combat/deckbuilder/deckBuild.ts`
- Test: `test/combat/deckbuilder/deckBuild.test.ts`

**Interfaces:**
- Consumes: `Combatant`, `AbilityDef` from `../types`; `CardInstance`, `CardId`, `DeckConfig` from `./deckTypes`; `extOf` from `../systems/poemStrike`.
- Produces:
  - `energyCostFor(ability: AbilityDef, config: DeckConfig): number`
  - `buildDeck(combatant, catalog, config): { cards: Record<CardId, CardInstance>; order: CardId[]; abilities: Record<string, AbilityDef> }`
    - `order` is the unshuffled card-id list (deterministic); the engine shuffles it.
    - `abilities` carries any **synthesized** abilities (the 格挡 card's `AbilityDef`) to merge into the catalog.

**Design notes (decisions for this plan):**
- `普攻` already exists on the combatant (added by `poemD20.buildCombatant` as `<id>/普攻`); buildDeck just makes `config.basics.普攻` copies of it.
- `格挡` is **synthesized** here per combatant: `AbilityDef { id: '<id>/格挡', name: '格挡', range: 1, shape: {kind:'self'}, toHit: null, cost: 'action', ext: { 格挡: true, 护盾: round(maxHp × blockFraction) } }`. The deck resolver (Task 4) reads `ext.格挡` to grant 护盾.
- Skill cards: each non-`普攻` ability on the combatant gets `config.copies[品质] ?? 1` copies (品质 read from `ability.ext.品质`).
- Card-instance ids are unique: `<abilityId>#<n>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/combat/deckbuilder/deckBuild.test.ts
import { describe, it, expect } from 'vitest'
import { buildDeck, energyCostFor } from '../../../src/shared/combat/deckbuilder/deckBuild'
import { DEFAULT_DECK_CONFIG } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { AbilityDef, Combatant } from '../../../src/shared/combat/types'

const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['主角/普攻', '主角/烈焰斩'] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2 }
})
const catalog: Record<string, AbilityDef> = {
  '主角/普攻': { id: '主角/普攻', name: '普攻', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 20, 关联属性: '力量' } },
  '主角/烈焰斩': { id: '主角/烈焰斩', name: '烈焰斩', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 140, 关联属性: '智力', 品质: '史诗' } }
}

describe('energyCostFor', () => {
  it('basics cost 1; skills cost by 品质', () => {
    expect(energyCostFor(catalog['主角/普攻'], DEFAULT_DECK_CONFIG)).toBe(1)
    expect(energyCostFor(catalog['主角/烈焰斩'], DEFAULT_DECK_CONFIG)).toBe(2) // 史诗 → 2
  })
})

describe('buildDeck', () => {
  it('makes basics copies, a synthesized 格挡, and skill copies by 品质', () => {
    const { cards, order, abilities } = buildDeck(lead(), catalog, DEFAULT_DECK_CONFIG)
    const byAbility = (id: string) => order.map((cid) => cards[cid]).filter((c) => c.abilityId === id)
    expect(byAbility('主角/普攻').length).toBe(4)          // basics.普攻
    expect(byAbility('主角/格挡').length).toBe(4)          // basics.格挡 (synthesized)
    expect(byAbility('主角/烈焰斩').length).toBe(1)        // 史诗 → 1 copy
    // the synthesized 格挡 ability is returned for the catalog, granting maxHp×0.05 护盾
    expect(abilities['主角/格挡']).toMatchObject({ name: '格挡' })
    expect((abilities['主角/格挡'].ext as any).护盾).toBe(50) // round(1000 × 0.05)
    // every card carries owner + a positive energy cost + a unique id
    expect(order.length).toBe(9)
    expect(new Set(order).size).toBe(9)
    for (const cid of order) {
      expect(cards[cid].owner).toBe('主角')
      expect(cards[cid].energyCost).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/deckBuild.test.ts`
Expected: FAIL — cannot find module `deckBuild`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/deckBuild.ts
//
// Kit → draw pile (the build=deck rule). Turns a combatant's abilities into card instances:
// N copies of 普攻, M copies of a synthesized 格挡 (grants 护盾), and skill cards by 品质.
// Pure. See duel spec §4.

import type { AbilityDef, Combatant } from '../types'
import type { CardId, CardInstance, DeckConfig } from './deckTypes'

const qualityOf = (ability: AbilityDef): string =>
  (ability.ext as { 品质?: string } | undefined)?.品质 ?? '普通'

const isBasicAttack = (ability: AbilityDef): boolean => ability.name === '普攻'

/** Energy cost: basics (普攻/格挡) cost 1; skills cost by 品质 (default 2). */
export const energyCostFor = (ability: AbilityDef, config: DeckConfig): number => {
  if (isBasicAttack(ability) || ability.name === '格挡') return 1
  return config.energyCostByQuality[qualityOf(ability)] ?? 2
}

/** Synthesize the 格挡 (Defend) ability for a combatant — grants 护盾 = round(maxHp × blockFraction). */
const makeBlockAbility = (combatant: Combatant, config: DeckConfig): AbilityDef => ({
  id: `${combatant.id}/格挡`,
  name: '格挡',
  range: 1,
  shape: { kind: 'self' },
  toHit: null,
  cost: 'action',
  ext: { 格挡: true, 护盾: Math.round(combatant.block.maxHp * config.blockFraction) }
})

export const buildDeck = (
  combatant: Combatant,
  catalog: Record<string, AbilityDef>,
  config: DeckConfig
): { cards: Record<CardId, CardInstance>; order: CardId[]; abilities: Record<string, AbilityDef> } => {
  const cards: Record<CardId, CardInstance> = {}
  const order: CardId[] = []
  const abilities: Record<string, AbilityDef> = {}

  const add = (ability: AbilityDef, copies: number): void => {
    for (let n = 1; n <= copies; n++) {
      const id: CardId = `${ability.id}#${n}`
      cards[id] = { id, abilityId: ability.id, owner: combatant.id, energyCost: energyCostFor(ability, config) }
      order.push(id)
    }
  }

  for (const abilityId of combatant.block.abilities) {
    const ability = catalog[abilityId]
    if (!ability) continue
    if (isBasicAttack(ability)) add(ability, config.basics.普攻)
    else add(ability, config.copies[qualityOf(ability)] ?? 1)
  }

  const block = makeBlockAbility(combatant, config)
  abilities[block.id] = block
  add(block, config.basics.格挡)

  return { cards, order, abilities }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/deckbuilder/deckBuild.test.ts`
Expected: PASS (2 describes).

- [ ] **Step 5: Commit**

```bash
git add src/shared/combat/deckbuilder/deckBuild.ts test/combat/deckbuilder/deckBuild.test.ts
git commit -m "feat(duel): kit->deck construction (basics, synthesized 格挡, skill copies by 品质)"
```

---

## Task 4: Card resolution (`deckResolve.ts`)

**Files:**
- Create: `src/shared/combat/deckbuilder/deckResolve.ts`
- Test: `test/combat/deckbuilder/deckResolve.test.ts`

**Interfaces:**
- Consumes: `clone` from `../../objectPath`; `poemHitOne`, `poemHealOne`, `extOf` from `../systems/poemStrike`; `AbilityDef`, `Combatant, CombatEvent` from `../types`; `DeriveConfig` from `../bundle`; `DuelState` from `./deckTypes`.
- Produces:
  - `applyAbilityEffect(combatants, actorId, ability, targetIds, rng, derive, events): void` — the shared applier (attack / heal / 格挡-block) over the strike math; mutates `combatants` + `events`.
  - `resolvePlay(state, cardId, targetIds, rng, derive): { state: DuelState; events: CombatEvent[] }` — deduct energy + 消耗 (mp/sp/hp), apply the effect, move the card to discard/exhaust, advance `rngCursor`, recompute `status`.

**Design notes:**
- `applyAbilityEffect` branches on `ability.ext`: `格挡` → add `护盾` to the actor's `ext.shield` (and track `ext.blockGained` for decay in Task 6); `治疗`/`治疗量` → `poemHealOne` to same-side targets; otherwise → `poemHitOne` per target.
- `resolvePlay` deducts the card's `消耗` from the owner: `mp`/`sp` from `ext.mp`/`ext.sp`, and an HP cost (`消耗.hp`, the 血祭 archetype) from the owner's `block.hp` (floored at 0). Energy is deducted by `state.energy.current -= card.energyCost` (affordability is the caller's gate — Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// test/combat/deckbuilder/deckResolve.test.ts
import { describe, it, expect } from 'vitest'
import { resolvePlay, applyAbilityEffect } from '../../../src/shared/combat/deckbuilder/deckResolve'
import type { DuelState } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { AbilityDef, Combatant, CombatEvent } from '../../../src/shared/combat/types'
import type { Rng } from '../../../src/shared/combat/dice'

const fixedRoll = (n: number): Rng => () => (n - 0.5) / 20
const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[11, 1.0], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, tier: 2, mp: 100, sp: 100, equip: { 武器攻击: 60, 防御: 0 }, shield: 0 }
})
const foe = (): Combatant => ({
  id: '哥布林', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp: 500, maxHp: 500, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
  ext: { system: 'poemD20', attrs: { 体质: 4 }, tier: 2, equip: { 防御: 0 } }
})
const strike: AbilityDef = { id: '主角/普攻', name: '普攻', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 20, 关联属性: '力量', 消耗: { slot: 'attack', sp: 5 } } }
const block: AbilityDef = { id: '主角/格挡', name: '格挡', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'action', ext: { 格挡: true, 护盾: 50 } }

const duel = (combatants: Combatant[], cards: DuelState['cards'], hand: string[]): DuelState => ({
  seed: 1, rngCursor: 0, combatants, lead: '主角',
  energy: { current: 3, max: 3 },
  piles: { draw: [], hand, discard: [], exhaust: [] },
  cards, intents: {}, phase: 'lead', round: 1, status: 'active', log: [], handSize: 5
})

describe('applyAbilityEffect', () => {
  it('格挡 grants 护盾 to the actor', () => {
    const cs = [lead(), foe()]
    const events: CombatEvent[] = []
    applyAbilityEffect(cs, '主角', block, [], fixedRoll(15), derive, events)
    expect((cs[0].ext as any).shield).toBe(50)
    expect((cs[0].ext as any).blockGained).toBe(50)
  })
})

describe('resolvePlay', () => {
  it('deducts energy + 消耗, deals damage, and discards the card', () => {
    const cards = { 'c1': { id: 'c1', abilityId: '主角/普攻', owner: '主角', energyCost: 1 } }
    const s = duel([lead(), foe()], cards, ['c1'])
    const out = resolvePlay(s, 'c1', ['哥布林'], fixedRoll(15), derive, { '主角/普攻': strike })
    expect(out.state.energy.current).toBe(2)              // 3 − 1
    expect((out.state.combatants[0].ext as any).sp).toBe(95) // 100 − 5
    expect(out.state.combatants[1].block.hp).toBeLessThan(500)
    expect(out.state.piles.hand).toEqual([])
    expect(out.state.piles.discard).toEqual(['c1'])
    expect(out.state.rngCursor).toBe(1)
  })

  it('an HP-cost card (血祭) spends the owner HP', () => {
    const bloody: AbilityDef = { id: '主角/血祭', name: '血祭', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 200, 关联属性: '力量', 消耗: { slot: 'attack', hp: 100 } } }
    const cards = { 'c1': { id: 'c1', abilityId: '主角/血祭', owner: '主角', energyCost: 1 } }
    const s = duel([lead(), foe()], cards, ['c1'])
    const out = resolvePlay(s, 'c1', ['哥布林'], fixedRoll(15), derive, { '主角/血祭': bloody })
    expect(out.state.combatants[0].block.hp).toBe(900)   // 1000 − 100 HP cost
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/deckResolve.test.ts`
Expected: FAIL — cannot find module `deckResolve`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/deckResolve.ts
//
// Resolve one card play (and, reused by intents.ts, one telegraphed action): deduct energy +
// 消耗 (mp/sp/hp), apply the effect via the shared poemStrike math, move the card to discard.
// Pure; clone-then-mutate. See duel spec §5.

import { clone } from '../../objectPath'
import { poemHitOne, poemHealOne, extOf } from '../systems/poemStrike'
import type { AbilityDef, Combatant, CombatEvent } from '../types'
import type { DeriveConfig } from '../bundle'
import type { Rng } from '../dice'
import type { DuelState } from './deckTypes'

const isAlive = (c: Combatant): boolean => c.block.hp > 0

interface PlayExt {
  格挡?: boolean
  护盾?: number
  治疗?: boolean
  治疗量?: number
  范围目标?: number
  消耗?: { mp?: number; sp?: number; hp?: number }
}

/**
 * Apply one ability's effect to its targets, mutating `combatants` + `events`. Branches:
 * 格挡 → grant 护盾 to the actor (tracked as blockGained for per-round decay); 治疗 → heal
 * same-side targets; otherwise → strike each target. No energy/cost bookkeeping (that's resolvePlay).
 */
export const applyAbilityEffect = (
  combatants: Combatant[],
  actorId: string,
  ability: AbilityDef,
  targetIds: string[],
  rng: Rng,
  derive: DeriveConfig | undefined,
  events: CombatEvent[]
): void => {
  const actor = combatants.find((c) => c.id === actorId)
  if (!actor) return
  const ext = (ability.ext ?? {}) as PlayExt

  if (ext.格挡) {
    const gain = ext.护盾 ?? 0
    const aExt = extOf(actor) as { shield?: number; blockGained?: number }
    aExt.shield = (aExt.shield ?? 0) + gain
    aExt.blockGained = (aExt.blockGained ?? 0) + gain
    events.push({ kind: 'info', text: `${actor.name} 获得护盾 ${gain}。`, delta: { target: actor.id, block: gain } })
    return
  }

  const isHeal = !!ext.治疗 || (ext.治疗量 ?? 0) > 0
  let targets = combatants.filter((c) => targetIds.includes(c.id)).filter(isAlive)
  if (isHeal) targets = targets.filter((t) => t.side === actor.side)
  if (ext.范围目标 && targets.length > ext.范围目标) targets = targets.slice(0, ext.范围目标)

  events.push({
    kind: 'attack',
    text: `${actor.name} uses ${ability.name}.`,
    delta: { actor: actor.id, ability: ability.id, targets: targets.map((t) => t.id) }
  })
  for (const target of targets)
    if (isHeal) poemHealOne(actor, target, ability, derive, events)
    else poemHitOne(actor, target, ability, rng, derive, events)
}

const checkStatus = (combatants: Combatant[]): DuelState['status'] => {
  const partyAlive = combatants.some((c) => c.side === 'party' && isAlive(c))
  const enemyAlive = combatants.some((c) => c.side === 'enemy' && isAlive(c))
  if (!enemyAlive) return 'party'
  if (!partyAlive) return 'enemy'
  return 'active'
}

/** Resolve one card play: spend energy + 消耗, apply the effect, discard the card, recompute status. */
export const resolvePlay = (
  state: DuelState,
  cardId: string,
  targetIds: string[],
  rng: Rng,
  derive: DeriveConfig | undefined,
  catalog: Record<string, AbilityDef>
): { state: DuelState; events: CombatEvent[] } => {
  const next = clone(state)
  const card = next.cards[cardId]
  const ability = card ? catalog[card.abilityId] : undefined
  const events: CombatEvent[] = []
  if (!card || !ability) {
    events.push({ kind: 'info', text: 'No such card.', delta: { card: cardId } })
    return { state: next, events }
  }

  next.energy.current = Math.max(0, next.energy.current - card.energyCost)

  const owner = next.combatants.find((c) => c.id === card.owner)
  const cost = ((ability.ext ?? {}) as PlayExt).消耗
  if (owner && cost) {
    const oExt = extOf(owner) as { mp?: number; sp?: number }
    if (cost.mp) oExt.mp = Math.max(0, (oExt.mp ?? 0) - cost.mp)
    if (cost.sp) oExt.sp = Math.max(0, (oExt.sp ?? 0) - cost.sp)
    if (cost.hp) owner.block.hp = Math.max(0, owner.block.hp - cost.hp)
  }

  applyAbilityEffect(next.combatants, card.owner, ability, targetIds, rng, derive, events)

  next.piles.hand = next.piles.hand.filter((id) => id !== cardId)
  if (card.exhaust) next.piles.exhaust.push(cardId)
  else next.piles.discard.push(cardId)

  next.rngCursor = state.rngCursor + 1
  next.log = [...next.log, ...events]
  next.status = checkStatus(next.combatants)
  return { state: next, events }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/deckbuilder/deckResolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/combat/deckbuilder/deckResolve.ts test/combat/deckbuilder/deckResolve.test.ts
git commit -m "feat(duel): card resolution (energy/消耗/HP cost, attack/heal/格挡) over poemStrike"
```

---

## Task 5: Telegraphed intents (`intents.ts`)

**Files:**
- Create: `src/shared/combat/deckbuilder/intents.ts`
- Test: `test/combat/deckbuilder/intents.test.ts`

**Interfaces:**
- Consumes: `applyAbilityEffect` from `./deckResolve`; `extOf` from `../systems/poemStrike`; `AbilityDef`, `Combatant, CombatEvent, Side` from `../types`; `DeriveConfig` from `../bundle`; `DuelState`, `Intent` from `./deckTypes`.
- Produces:
  - `chooseIntent(state, combatantId, catalog): Intent` — deterministic next action: the combatant's first non-`普攻` ability if it has one (else `普攻`); target = the first living opponent; `kind` from the ability (治疗→`heal`, 格挡→`block`, else `attack`); `preview` = a coarse damage estimate.
  - `resolveIntent(combatants, combatantId, intent, rng, derive, catalog, events): void` — executes the telegraphed intent via `applyAbilityEffect`.

**Design notes:** the policy is intentionally simple and deterministic (no per-turn LLM). `preview` is the 构成 base (`关联属性×10×系数 + 威力`) — an estimate for the telegraph, not the resolved number. Opponent side = the opposite of the actor's side.

- [ ] **Step 1: Write the failing test**

```ts
// test/combat/deckbuilder/intents.test.ts
import { describe, it, expect } from 'vitest'
import { chooseIntent, resolveIntent } from '../../../src/shared/combat/deckbuilder/intents'
import type { DuelState } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { AbilityDef, Combatant, CombatEvent } from '../../../src/shared/combat/types'
import type { Rng } from '../../../src/shared/combat/dice'

const fixedRoll = (n: number): Rng => () => (n - 0.5) / 20
const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[11, 1.0], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const foe = (): Combatant => ({
  id: '哥布林', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp: 300, maxHp: 300, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['哥布林/横扫'] },
  ext: { system: 'poemD20', attrs: { 力量: 4, 体质: 4 }, tier: 2, equip: { 武器攻击: 30 } }
})
const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: [] },
  ext: { system: 'poemD20', attrs: { 体质: 6 }, tier: 2, equip: { 防御: 0 } }
})
const catalog: Record<string, AbilityDef> = {
  '哥布林/横扫': { id: '哥布林/横扫', name: '横扫', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 80, 关联属性: '力量' } }
}
const duel = (combatants: Combatant[]): DuelState => ({
  seed: 1, rngCursor: 0, combatants, lead: '主角',
  energy: { current: 3, max: 3 }, piles: { draw: [], hand: [], discard: [], exhaust: [] },
  cards: {}, intents: {}, phase: 'enemies', round: 1, status: 'active', log: [], handSize: 5
})

describe('chooseIntent', () => {
  it('telegraphs an attack on the first living opponent with a preview', () => {
    const intent = chooseIntent(duel([lead(), foe()]), '哥布林', catalog)
    expect(intent.kind).toBe('attack')
    expect(intent.abilityId).toBe('哥布林/横扫')
    expect(intent.target).toBe('主角')
    expect(intent.preview).toBeGreaterThan(0)
  })
})

describe('resolveIntent', () => {
  it('executes the telegraphed attack and damages the target', () => {
    const cs = [lead(), foe()]
    const intent = chooseIntent(duel(cs), '哥布林', catalog)
    const events: CombatEvent[] = []
    resolveIntent(cs, '哥布林', intent, fixedRoll(15), derive, catalog, events)
    expect(cs[0].block.hp).toBeLessThan(1000)
    expect(events.some((e) => e.kind === 'damage')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/intents.test.ts`
Expected: FAIL — cannot find module `intents`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/intents.ts
//
// Deterministic telegraphed intents for non-lead combatants (companions + enemies). No per-turn
// LLM — this is the readable-pattern core of STS, and the seam mode ③ (agent enemy) later replaces.
// Pure. See duel spec §5.

import { applyAbilityEffect } from './deckResolve'
import { extOf } from '../systems/poemStrike'
import type { AbilityDef, Combatant, CombatEvent, Side } from '../types'
import type { DeriveConfig } from '../bundle'
import type { Rng } from '../dice'
import type { DuelState, Intent, IntentKind } from './deckTypes'

const opponentSide = (side: Side): Side => (side === 'party' ? 'enemy' : 'party')

const kindOf = (ability: AbilityDef): IntentKind => {
  const ext = (ability.ext ?? {}) as { 治疗?: boolean; 治疗量?: number; 格挡?: boolean }
  if (ext.格挡) return 'block'
  if (ext.治疗 || (ext.治疗量 ?? 0) > 0) return 'heal'
  return 'attack'
}

/** Coarse damage estimate for the telegraph: 构成 base (关联属性×10×系数 + 威力). */
const previewOf = (actor: Combatant, ability: AbilityDef, derive?: DeriveConfig): number => {
  const ext = (ability.ext ?? {}) as { 威力?: number; 关联属性?: string }
  const aExt = extOf(actor)
  const attrV = ext.关联属性 ? aExt.attrs?.[ext.关联属性] ?? 0 : 0
  const coeff = derive?.tier_coefficient?.[String(aExt.tier ?? 1)] ?? 1
  return Math.round(attrV * 10 * coeff + (ext.威力 ?? 0))
}

/** Pick a combatant's next action: its first non-普攻 ability (else 普攻), aimed at the first living
 *  opponent. Deterministic. */
export const chooseIntent = (
  state: DuelState,
  combatantId: string,
  catalog: Record<string, AbilityDef>,
  derive?: DeriveConfig
): Intent => {
  const actor = state.combatants.find((c) => c.id === combatantId)
  if (!actor) return { kind: 'attack' }
  const abilities = actor.block.abilities.map((id) => catalog[id]).filter(Boolean) as AbilityDef[]
  const ability = abilities.find((a) => a.name !== '普攻') ?? abilities[0]
  const target = state.combatants.find((c) => c.side === opponentSide(actor.side) && c.block.hp > 0)
  if (!ability) return { kind: 'attack', target: target?.id }
  const kind = kindOf(ability)
  return {
    kind,
    abilityId: ability.id,
    target: kind === 'block' ? actor.id : target?.id,
    preview: kind === 'attack' ? previewOf(actor, ability, derive) : ability.ext ? (ability.ext as { 护盾?: number }).护盾 : undefined
  }
}

/** Execute a telegraphed intent (attack / heal / block) via the shared effect applier. */
export const resolveIntent = (
  combatants: Combatant[],
  combatantId: string,
  intent: Intent,
  rng: Rng,
  derive: DeriveConfig | undefined,
  catalog: Record<string, AbilityDef>,
  events: CombatEvent[]
): void => {
  if (!intent.abilityId) return
  const ability = catalog[intent.abilityId]
  if (!ability) return
  const targetIds = intent.target ? [intent.target] : []
  applyAbilityEffect(combatants, combatantId, ability, targetIds, rng, derive, events)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/deckbuilder/intents.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/combat/deckbuilder/intents.ts test/combat/deckbuilder/intents.test.ts
git commit -m "feat(duel): deterministic telegraphed intents for companions + enemies"
```

---

## Task 6: The turn loop (`deckEngine.ts`)

**Files:**
- Create: `src/shared/combat/deckbuilder/deckEngine.ts`
- Test: `test/combat/deckbuilder/deckEngine.test.ts`

**Interfaces:**
- Consumes: `clone` from `../../objectPath`; `makeRng` from `../dice`; `buildDeck` from `./deckBuild`; `resolvePlay` from `./deckResolve`; `chooseIntent`, `resolveIntent` from `./intents`; `aliveOnSide`, `leadCombatant` from `./deckTypes`; `BuiltEncounter` from `../bundle`; `AbilityDef`, `CombatEvent` from `../types`; `DuelState`, `DeckConfig` from `./deckTypes`.
- Produces:
  - `startDuel(built, opts): { state: DuelState; catalog: Record<string, AbilityDef> }` — builds decks (lead + party support folded into the shared draw pile), shuffles (seeded), sets energy, telegraphs intents, draws the opening hand. `opts: { seed?: number; lead?: string; config?: DeckConfig }`.
  - `drawHand(state): DuelState` — draw to `handSize`, reshuffling discard→draw (seeded) when the draw pile empties.
  - `playCard(state, cardId, targetIds, catalog, derive): { state; events }` — gate on hand-membership + affordability (energy + pools), then `resolvePlay`.
  - `endLeadTurn(state, catalog, derive): { state; events }` — discard hand, run allies then enemies phases (each living non-lead combatant resolves its telegraphed intent), decay block, re-telegraph, refresh energy, swap lead if down, draw the next hand.
  - `checkDuelVictory(state): DuelState['status']`
  - `swapLeadIfDown(state): DuelState` — if the lead is at 0 HP, promote the first living party member.

**Design notes:**
- Shared deck: party members' decks are concatenated then shuffled into one draw pile (lead+support). The catalog merges the encounter abilities + every synthesized 格挡.
- **Block decay:** at the end of `endLeadTurn` (after enemies act), each combatant's temporary block resets — `ext.shield -= ext.blockGained; ext.blockGained = 0` (gear-passive 护盾 is not tracked in `blockGained`, so it persists).
- **Affordability** (`playCard`): card must be in `hand`, `energy.current ≥ energyCost`, and the owner's pools cover `消耗` (mp/sp/hp). On failure, return an `info` event and the unchanged state.
- **Reshuffle determinism:** shuffle uses a Fisher–Yates driven by `makeRng(seed + rngCursor)`, and bumps `rngCursor`, so a duel replays identically.

- [ ] **Step 1: Write the failing test**

```ts
// test/combat/deckbuilder/deckEngine.test.ts
import { describe, it, expect } from 'vitest'
import { startDuel, playCard, endLeadTurn, checkDuelVictory, swapLeadIfDown } from '../../../src/shared/combat/deckbuilder/deckEngine'
import { DEFAULT_DECK_CONFIG } from '../../../src/shared/combat/deckbuilder/deckTypes'
import type { BuiltEncounter } from '../../../src/shared/combat/bundle'
import type { AbilityDef, Combatant } from '../../../src/shared/combat/types'

const derive = { tier_coefficient: { '2': 2.8 }, rating_tiers: [[11, 1.0], [0, 0]] as [number, number][], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const lead = (): Combatant => ({
  id: '主角', side: 'party', name: '主角', pos: [0, 0],
  block: { hp: 1000, maxHp: 1000, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['主角/普攻'] },
  ext: { system: 'poemD20', attrs: { 力量: 5, 体质: 6 }, tier: 2, mp: 100, sp: 100, equip: { 武器攻击: 60, 防御: 0 }, shield: 0 }
})
const foe = (hp = 60): Combatant => ({
  id: '哥布林', side: 'enemy', name: '哥布林', pos: [1, 0],
  block: { hp, maxHp: 300, ac: 10, speed: 6, mods: {}, conditions: [], abilities: ['哥布林/横扫'] },
  ext: { system: 'poemD20', attrs: { 力量: 3, 体质: 4 }, tier: 2, equip: { 武器攻击: 20, 防御: 0 } }
})
const catalog: Record<string, AbilityDef> = {
  '主角/普攻': { id: '主角/普攻', name: '普攻', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 20, 关联属性: '力量' } },
  '哥布林/横扫': { id: '哥布林/横扫', name: '横扫', range: 1, shape: { kind: 'self' }, toHit: null, cost: 'attack', ext: { 威力: 80, 关联属性: '力量' } }
}
const built = (combatants: Combatant[]): BuiltEncounter => ({ seed: 7, grid: { w: 1, h: 1, cellFt: 5 }, combatants, abilities: catalog, hooks: {} })

describe('startDuel', () => {
  it('builds a shared deck, draws an opening hand, and telegraphs enemy intents', () => {
    const { state } = startDuel(built([lead(), foe()]), { seed: 7, config: DEFAULT_DECK_CONFIG })
    expect(state.lead).toBe('主角')
    expect(state.energy).toEqual({ current: 3, max: 3 })
    expect(state.piles.hand.length).toBe(5)                 // handSize
    // deck = 4 普攻 + 4 格挡 = 8; 5 drawn, 3 left.
    expect(state.piles.draw.length).toBe(3)
    expect(state.intents['哥布林']?.kind).toBe('attack')
    expect(state.intents['哥布林']?.target).toBe('主角')
  })
})

describe('playCard', () => {
  it('rejects a card not in hand', () => {
    const { state } = startDuel(built([lead(), foe()]), { seed: 7 })
    const out = playCard(state, 'nope#1', ['哥布林'], catalog, derive)
    expect(out.events.some((e) => e.kind === 'info')).toBe(true)
    expect(out.state.energy.current).toBe(3)               // unchanged
  })

  it('plays a hand card, spends energy, and can win the duel', () => {
    const { state } = startDuel(built([lead(), foe(40)]), { seed: 7 })
    const cardId = state.piles.hand.find((id) => state.cards[id].abilityId === '主角/普攻')!
    const out = playCard(state, cardId, ['哥布林'], catalog, derive)
    expect(out.state.energy.current).toBe(2)
    expect(out.state.piles.hand.length).toBe(4)
    // 普攻 vs a 40-HP foe with no defense kills it → party victory.
    expect(out.state.combatants.find((c) => c.id === '哥布林')!.block.hp).toBe(0)
    expect(checkDuelVictory(out.state)).toBe('party')
  })
})

describe('endLeadTurn', () => {
  it('runs the enemy phase, refreshes energy, and draws a fresh hand', () => {
    const start = startDuel(built([lead(), foe(300)]), { seed: 7 })
    // spend some energy first
    const cardId = start.state.piles.hand[0]
    const mid = playCard(start.state, cardId, ['哥布林'], catalog, derive)
    const out = endLeadTurn(mid.state, catalog, derive)
    expect(out.state.energy.current).toBe(3)               // refreshed
    expect(out.state.piles.hand.length).toBe(5)            // redrawn
    expect(out.state.round).toBe(2)
    // the enemy acted on its telegraphed 横扫 → the lead took damage.
    expect(out.state.combatants.find((c) => c.id === '主角')!.block.hp).toBeLessThan(1000)
  })
})

describe('swapLeadIfDown', () => {
  it('promotes a living party member when the lead is down', () => {
    const s = startDuel(built([lead(), { ...lead(), id: '苏璃', name: '苏璃' }, foe()]), { seed: 7 }).state
    s.combatants.find((c) => c.id === '主角')!.block.hp = 0
    const out = swapLeadIfDown(s)
    expect(out.lead).toBe('苏璃')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/deckEngine.test.ts`
Expected: FAIL — cannot find module `deckEngine`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/deckEngine.ts
//
// The deckbuilder turn loop: build/shuffle the shared deck, draw/play/discard, run the
// allies + enemies intent phases, decay block, refresh energy. Pure; clone-then-mutate;
// (seed, rngCursor)-deterministic. See duel spec §5.

import { clone } from '../../objectPath'
import { makeRng } from '../dice'
import { buildDeck } from './deckBuild'
import { resolvePlay, applyAbilityEffect } from './deckResolve'
import { chooseIntent, resolveIntent } from './intents'
import { extOf } from '../systems/poemStrike'
import type { BuiltEncounter, DeriveConfig } from '../bundle'
import type { AbilityDef, CombatEvent } from '../types'
import { DEFAULT_DECK_CONFIG, type DeckConfig, type DuelState } from './deckTypes'

const seedFor = (state: DuelState): number => (state.seed + state.rngCursor) >>> 0

/** Seeded Fisher–Yates over a copy; bumps the cursor on the returned state by the caller. */
const shuffle = <T,>(items: T[], rng: () => number): T[] => {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const checkDuelVictory = (state: DuelState): DuelState['status'] => {
  const partyAlive = state.combatants.some((c) => c.side === 'party' && c.block.hp > 0)
  const enemyAlive = state.combatants.some((c) => c.side === 'enemy' && c.block.hp > 0)
  if (!enemyAlive) return 'party'
  if (!partyAlive) return 'enemy'
  return 'active'
}

export const swapLeadIfDown = (state: DuelState): DuelState => {
  const lead = state.combatants.find((c) => c.id === state.lead)
  if (lead && lead.block.hp > 0) return state
  const next = clone(state)
  const successor = next.combatants.find((c) => c.side === 'party' && c.block.hp > 0)
  if (successor) next.lead = successor.id
  return next
}

const telegraph = (state: DuelState, catalog: Record<string, AbilityDef>, derive?: DeriveConfig): void => {
  state.intents = {}
  for (const c of state.combatants)
    if (c.id !== state.lead && c.block.hp > 0) state.intents[c.id] = chooseIntent(state, c.id, catalog, derive)
}

export const drawHand = (state: DuelState): DuelState => {
  const next = clone(state)
  while (next.piles.hand.length < next.handSize) {
    if (next.piles.draw.length === 0) {
      if (next.piles.discard.length === 0) break
      const rng = makeRng(seedFor(next))
      next.piles.draw = shuffle(next.piles.discard, rng)
      next.piles.discard = []
      next.rngCursor += 1
    }
    next.piles.hand.push(next.piles.draw.shift()!)
  }
  return next
}

export const startDuel = (
  built: BuiltEncounter,
  opts: { seed?: number; lead?: string; config?: DeckConfig } = {}
): { state: DuelState; catalog: Record<string, AbilityDef> } => {
  const config = opts.config ?? DEFAULT_DECK_CONFIG
  const seed = opts.seed ?? built.seed ?? 1
  const party = built.combatants.filter((c) => c.side === 'party')
  const lead = opts.lead ?? party[0]?.id ?? built.combatants[0]?.id

  const catalog: Record<string, AbilityDef> = { ...built.abilities }
  const cards: DuelState['cards'] = {}
  let order: string[] = []
  for (const member of party) {
    const deck = buildDeck(member, catalog, config)
    Object.assign(catalog, deck.abilities)
    Object.assign(cards, deck.cards)
    order = order.concat(deck.order)
  }

  let state: DuelState = {
    seed,
    rngCursor: 0,
    combatants: built.combatants,
    lead,
    energy: { current: config.energy, max: config.energy },
    piles: { draw: [], hand: [], discard: [], exhaust: [] },
    cards,
    intents: {},
    phase: 'lead',
    round: 1,
    status: 'active',
    log: [],
    handSize: config.handSize
  }
  state.piles.draw = shuffle(order, makeRng(seedFor(state)))
  state.rngCursor += 1
  telegraph(state, catalog)
  state = drawHand(state)
  return { state, catalog }
}

const canAfford = (state: DuelState, cardId: string, catalog: Record<string, AbilityDef>): boolean => {
  const card = state.cards[cardId]
  if (!card || !state.piles.hand.includes(cardId)) return false
  if (state.energy.current < card.energyCost) return false
  const owner = state.combatants.find((c) => c.id === card.owner)
  const cost = ((catalog[card.abilityId]?.ext ?? {}) as { 消耗?: { mp?: number; sp?: number; hp?: number } }).消耗
  if (owner && cost) {
    const oExt = extOf(owner)
    if (cost.mp && (oExt.mp ?? 0) < cost.mp) return false
    if (cost.sp && (oExt.sp ?? 0) < cost.sp) return false
    if (cost.hp && owner.block.hp <= cost.hp) return false
  }
  return true
}

export const playCard = (
  state: DuelState,
  cardId: string,
  targetIds: string[],
  catalog: Record<string, AbilityDef>,
  derive?: DeriveConfig
): { state: DuelState; events: CombatEvent[] } => {
  if (!canAfford(state, cardId, catalog)) {
    const events: CombatEvent[] = [{ kind: 'info', text: 'Cannot play that card.', delta: { card: cardId } }]
    return { state: { ...state, log: [...state.log, ...events] }, events }
  }
  return resolvePlay(state, cardId, targetIds, makeRng(seedFor(state)), derive, catalog)
}

const decayBlock = (state: DuelState): void => {
  for (const c of state.combatants) {
    const ext = extOf(c) as { shield?: number; blockGained?: number }
    if (ext.blockGained) {
      ext.shield = Math.max(0, (ext.shield ?? 0) - ext.blockGained)
      ext.blockGained = 0
    }
  }
}

export const endLeadTurn = (
  state: DuelState,
  catalog: Record<string, AbilityDef>,
  derive?: DeriveConfig
): { state: DuelState; events: CombatEvent[] } => {
  let next = clone(state)
  const events: CombatEvent[] = []

  // Discard the hand.
  next.piles.discard = [...next.piles.discard, ...next.piles.hand]
  next.piles.hand = []

  // Allies phase, then enemies phase: each living non-lead combatant resolves its telegraphed intent.
  const act = (side: 'party' | 'enemy'): void => {
    for (const c of next.combatants) {
      if (c.side !== side || c.id === next.lead || c.block.hp <= 0) continue
      const intent = next.intents[c.id]
      if (!intent) continue
      const rng = makeRng(seedFor(next))
      resolveIntent(next.combatants, c.id, intent, rng, derive, catalog, events)
      next.rngCursor += 1
    }
  }
  next.phase = 'allies'
  act('party')
  next.phase = 'enemies'
  act('enemy')

  decayBlock(next)
  next.status = checkDuelVictory(next)
  next.log = [...next.log, ...events]

  if (next.status === 'active') {
    next = swapLeadIfDown(next)
    next.round += 1
    next.phase = 'lead'
    next.energy = { current: next.energy.max, max: next.energy.max }
    telegraph(next, catalog, derive)
    next = drawHand(next)
  }
  return { state: next, events }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/combat/deckbuilder/deckEngine.test.ts`
Expected: PASS (all). If a hand-composition assertion is off due to shuffle order, the test pins `seed: 7`; adjust the expected `draw.length`/hand only if the deck size math (4+4) changes — the counts (`hand 5`, `draw 3`) are seed-independent.

- [ ] **Step 5: Full gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.

```bash
git add src/shared/combat/deckbuilder/deckEngine.ts test/combat/deckbuilder/deckEngine.test.ts
git commit -m "feat(duel): turn loop (start/draw/play/end), intents phases, block decay, lead-swap"
```

---

## Task 7: Module entry + MVU build + integration test (`index.ts`)

**Files:**
- Create: `src/shared/combat/deckbuilder/index.ts`
- Test: `test/combat/deckbuilder/integration.test.ts`

**Interfaces:**
- Consumes: `buildEncounterFromMvu`, `StatMap, DeriveConfig, BuiltEncounter` from `../bundle`; `poemD20System` from `../systems/poemD20`; the deckbuilder modules above.
- Produces:
  - re-exports of `startDuel`, `drawHand`, `playCard`, `endLeadTurn`, `checkDuelVictory`, `swapLeadIfDown`, the types, and `DEFAULT_DECK_CONFIG`.
  - `buildDuelFromMvu(statData, statMap, opts): BuiltEncounter` — binds `poemD20System` to `buildEncounterFromMvu` (party from `主角` + `关系列表`, enemies from the A1 `roster`); grid output is ignored by `startDuel`.

- [ ] **Step 1: Write the failing integration test**

```ts
// test/combat/deckbuilder/integration.test.ts
import { describe, it, expect } from 'vitest'
import { buildDuelFromMvu, startDuel, playCard, endLeadTurn, DEFAULT_DECK_CONFIG } from '../../../src/shared/combat/deckbuilder'
import type { DeriveConfig, StatMap } from '../../../src/shared/combat/bundle'

const statMap: StatMap = { player: '主角', paths: { attributes: '属性', hp: '生命值', maxHp: '生命值上限', level: '等级', tier: '生命层级', equipment: '装备', skills: '技能', conditions: '状态效果' } }
const derive: DeriveConfig = { attributes: ['力量', '敏捷', '体质', '智力', '精神'], tier_coefficient: { '2': 2.8 }, hp_multiplier: { '2': 2 }, mp_sp_multiplier: { '2': 2.5 }, rating_tiers: [[11, 1.0], [0, 0]], attr_mitigation: { 物理: 0.0025 }, defense_constant: 2000 }

const statData = {
  主角: { 生命层级: '第二层级', 等级: 8, 属性: { 力量: 6, 敏捷: 4, 体质: 6, 智力: 2, 精神: 3 }, 生命值: 1400, 生命值上限: 1400, 装备: {}, 技能: {}, 状态效果: {} }
}
const roster = [
  { 名称: '哥布林', 数量: 1, 生命层级: '第一层级', 等级: 2, 属性: { 力量: 2, 敏捷: 2, 体质: 2, 智力: 1, 精神: 1 }, 装备: {}, 技能: {}, 状态效果: {} }
]

describe('duel integration — MVU build → playable headless duel', () => {
  it('builds a duel from stat_data + an A1 roster and plays it deterministically to a result', () => {
    const built = buildDuelFromMvu(statData, statMap, { derive, roster, seed: 3 })
    expect(built.combatants.some((c) => c.side === 'party' && c.id === '主角')).toBe(true)
    expect(built.combatants.some((c) => c.side === 'enemy')).toBe(true)

    const { state, catalog } = startDuel(built, { seed: 3, config: DEFAULT_DECK_CONFIG })
    expect(state.piles.hand.length).toBe(5)

    // Play every affordable 普攻 in hand at the goblin across a few turns; it must resolve.
    let s = state
    for (let turn = 0; turn < 6 && s.status === 'active'; turn++) {
      for (const cardId of [...s.piles.hand]) {
        const enemy = s.combatants.find((c) => c.side === 'enemy' && c.block.hp > 0)
        if (!enemy) break
        const r = playCard(s, cardId, [enemy.id], catalog, derive)
        s = r.state
        if (s.status !== 'active') break
      }
      if (s.status !== 'active') break
      s = endLeadTurn(s, catalog, derive).state
    }
    // Deterministic with seed 3: the duel reaches a terminal status (party wins or party wipes).
    expect(['party', 'enemy']).toContain(s.status)
    // Replaying from the same seed reproduces the same outcome.
    const replay = startDuel(buildDuelFromMvu(statData, statMap, { derive, roster, seed: 3 }), { seed: 3 })
    expect(replay.state.piles.hand).toEqual(state.piles.hand)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/combat/deckbuilder/integration.test.ts`
Expected: FAIL — cannot find module `../../../src/shared/combat/deckbuilder` (no `index.ts`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/combat/deckbuilder/index.ts
//
// Public entry for the 命定之诗 deckbuilder duel engine (headless). Binds the poem CombatSystem
// to the existing MVU encounter builder, and re-exports the turn-loop API. See duel spec §1, §5.

import { buildEncounterFromMvu, type BuiltEncounter, type DeriveConfig, type StatMap } from '../bundle'
import { poemD20System } from '../systems/poemD20'

export * from './deckTypes'
export { buildDeck, energyCostFor } from './deckBuild'
export { resolvePlay, applyAbilityEffect } from './deckResolve'
export { chooseIntent, resolveIntent } from './intents'
export { startDuel, drawHand, playCard, endLeadTurn, checkDuelVictory, swapLeadIfDown } from './deckEngine'

/**
 * Build a duel encounter from MVU stat_data via the poem CombatSystem: the player + 关系列表 party
 * and the AI-supplied `roster` enemies (A1). Reuses buildEncounterFromMvu; the grid it returns is
 * ignored by the deck engine (targeting is by id).
 */
export const buildDuelFromMvu = (
  statData: Record<string, unknown>,
  statMap: StatMap,
  opts: { derive?: DeriveConfig; seed?: number; roster?: Array<Record<string, unknown>> } = {}
): BuiltEncounter =>
  buildEncounterFromMvu(statData, statMap, poemD20System, {
    derive: opts.derive,
    seed: opts.seed,
    roster: opts.roster
  })
```

- [ ] **Step 4: Run the integration test**

Run: `npx vitest run test/combat/deckbuilder/integration.test.ts`
Expected: PASS. If the `replay` hand-equality assertion fails, the shuffle is reading state incorrectly — confirm `startDuel` bumps `rngCursor` exactly once before `drawHand` and that `seedFor` is `(seed + rngCursor) >>> 0`.

- [ ] **Step 5: Full gate + commit**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS (entire suite, including the untouched grid/poem tests).

```bash
git add src/shared/combat/deckbuilder/index.ts test/combat/deckbuilder/integration.test.ts
git commit -m "feat(duel): module entry + buildDuelFromMvu + headless integration test"
```

---

## Self-Review

**1. Spec coverage (D1–D3):**
- DuelState model (spec §3) → Task 1. ✓
- Kit→deck, copies by 品质, basics, 格挡, dual MP/SP + energy costs (spec §4, §0.4) → Tasks 1, 3. ✓
- 命定之诗 ruleset reuse via the extracted strike math (spec §5.1) → Task 2. ✓
- Card resolution incl. HP-cost 消耗 (spec §0.4) → Task 4. ✓
- Block = 护盾 + decay (spec §0.6, §5) → Tasks 4, 6. ✓
- Telegraphed deterministic intents (spec §0.8, §5) → Task 5. ✓
- Turn loop: draw/play/end, allies+enemies phases, energy refresh (spec §5) → Task 6. ✓
- Down-not-dead + lead-swap (spec §0.9) → Task 6. ✓
- Party from 主角+关系列表 + A1 roster, reusing buildEncounterFromMvu (spec §1, §8) → Task 7. ✓
- Determinism/resume via (seed, rngCursor) (spec §0, §9) → Tasks 6, 7. ✓
- **Deferred (correctly NOT in this plan):** the native `DuelView` (D4), AI bookend/fold-back (D5), the bundle `combat.mode`/skin + drop-in card import (D6), scripted-card `vars`/sandbox (D7), the per-encounter narration cadence, typed-damage split. Each is a later plan.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the test; commands have expected output. ✓

**3. Type consistency:** `DuelState`/`CardInstance`/`Intent`/`DeckConfig` defined in Task 1 are imported (not redefined) by Tasks 3–7. `buildDeck` returns `{ cards, order, abilities }` (Task 3) and `startDuel` consumes exactly those (Task 6). `applyAbilityEffect` signature (Task 4) matches its call in `resolveIntent` (Task 5) and `endLeadTurn` (Task 6). `resolvePlay(state, cardId, targetIds, rng, derive, catalog)` (Task 4) matches `playCard`'s call (Task 6). `poemHitOne`/`poemHealOne` signatures (Task 2) match the calls in Task 4. `extOf` reused from `poemStrike` everywhere (no duplicate). ✓

**Note for the implementer:** the `blockGained` field is an ad-hoc key written onto `Combatant.ext` (an open `Record<string, unknown>`); it is read/written only by `deckResolve` (set) and `deckEngine.decayBlock` (clear), both via the `extOf` cast. No `types.ts` change is required.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-poem-sts-duel-engine.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
