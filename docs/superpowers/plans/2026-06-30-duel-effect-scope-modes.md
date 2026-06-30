# Duel effect-scope modes (单体 / 随机 / 群体) + heal targeting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give duel cards a target-selection scope (单体 / 随机X / 群体) that the duel resolver applies to a card's damage or heal, and finish heal targeting in the DuelView (the engine already heals; the UI never gave heal cards ally targets).

**Architecture:** A new `目标模式` field on `CardCombat` (parsed in `poemD20`, separate from grid `shape`); `deckResolve.applyAbilityEffect` selects targets by that scope (单体 = the picked one, 群体 = all on the side, 随机X = X random with replacement; side = enemies for damage, allies for heal); the DuelView's targeting becomes scope-aware with a new **ally picker** for 单体-heal. Enemy intents inherit scope free (they resolve through the same path).

**Tech Stack:** TypeScript (strict), Vitest, the pure duel engine (`src/shared/combat/deckbuilder` + `systems`), the React DuelView. No new deps.

This implements [2026-06-30-duel-effect-scope-modes-design.md](../specs/2026-06-30-duel-effect-scope-modes-design.md).

## Global Constraints

- **Default 单体.** A card with no `目标模式` resolves single-target (today's behavior) — no regression.
- **Grid combat untouched.** `shape`/`范围目标`/`多段` parsing + grid resolution unchanged; the duel scope is a separate field read only by the duel resolver.
- **Orthogonal to damage/heal.** Scope picks the target set; the effect (`isHeal`) picks the **side** (damage → opposite side, heal → actor's side). All three modes apply to both.
- **随机 is with replacement** — each of X hits picks a random living target independently (can repeat).
- **Engine stays pure** (`shared/combat/*` — no renderer/main/IPC import). `npm run check:deps` green.
- **Verification gate (each task):** `npm run typecheck && npm run check:deps && npm run test`. Task 4 adds a manual mock-duel check.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/combat/systems/poemStrike.ts` (modify) | add `目标模式` + `随机次数` to `CardCombat` |
| `src/shared/combat/systems/poemD20.ts` (modify) | parse the duel-scope tags into the ext |
| `test/combat/poemResolver.test.ts` or new `test/combat/duelScope.test.ts` | parse + selection tests |
| `src/shared/combat/deckbuilder/deckResolve.ts` (modify) | scope-driven `selectTargets` in `applyAbilityEffect` |
| `src/main/services/duelService.ts` (modify) | give the mock deck one card per mode + a heal card |
| `src/renderer/src/components/workspace/DuelView.tsx` (modify) | scope-aware targeting + ally picker |

---

## Task 1: `目标模式` field + parser

**Files:**
- Modify: `src/shared/combat/systems/poemStrike.ts`, `src/shared/combat/systems/poemD20.ts`
- Test: `test/combat/duelScope.test.ts` (new)

**Interfaces:**
- Produces: `CardCombat.目标模式?: '单体' | '随机' | '群体'`, `CardCombat.随机次数?: number`; `parseCardItem` emits them from the duel tags.

- [ ] **Step 1: Write the failing parse test**

```ts
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
    const grid = parseCardItem({ 标签: ['威力: 40', '爆发', '有效距离: 3'] }, '技能')
    expect(grid.shape?.kind).toBe('blast')
    expect(grid.目标模式).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run test/combat/duelScope.test.ts` → `目标模式` is not on `CardCombat`).

- [ ] **Step 3: Add the fields** to `CardCombat` in `src/shared/combat/systems/poemStrike.ts` (after `多段?: number` at line 43):

```ts
  /** Duel target-selection scope (deckbuilder duel only; grid uses shape/范围目标). Default 单体. */
  目标模式?: '单体' | '随机' | '群体'
  /** X for 随机 (default 1 when 目标模式==='随机'). */
  随机次数?: number
```

- [ ] **Step 4: Parse the duel tags** in `parseCardItem` (`src/shared/combat/systems/poemD20.ts`), inside the `for (const raw of asArr(it.标签))` loop. Add two branches to the `if/else if` chain **before** the `/范围|爆发|…/` shape branch (so they win for these specific tags; they don't overlap the shape regex anyway — it has no 群体/AOE/随机):

```ts
    else if (/^(?:群体|群|全体|AOE)$/i.test(t)) {
      out.目标模式 = '群体'
    } else if ((m = t.match(/^随机[:：]?\s*(\d+)?/))) {
      out.目标模式 = '随机'
      out.随机次数 = m[1] ? parseInt(m[1], 10) : 1
```

(Insert these as the first two `else if`s after the `攻击/防御` numeric branches and before `else if (/范围|爆发|直线|锥形|单体|自身|环境/.test(t))`. The `m` variable already exists in the loop.)

- [ ] **Step 5: Run the test — expect PASS.** Then the full gate.

Run: `npm run typecheck && npm run check:deps && npm run test`

- [ ] **Step 6: Commit**

```bash
git add src/shared/combat/systems/poemStrike.ts src/shared/combat/systems/poemD20.ts test/combat/duelScope.test.ts
git commit -m "feat(duel): 目标模式/随机次数 card field + duel-scope tag parsing"
```

---

## Task 2: scope-driven target selection (`deckResolve`)

**Files:**
- Modify: `src/shared/combat/deckbuilder/deckResolve.ts`
- Test: `test/combat/duelScope.test.ts` (extend)

**Interfaces:**
- Consumes: `CardCombat.目标模式`/`随机次数` (Task 1); the existing `applyAbilityEffect(combatants, actorId, ability, targetIds, rng, derive, events)` signature (unchanged).
- Produces: the same signature, scope-aware selection. The `'attack'` event still carries `delta.targets` (the resolved id list) — the assertable selection output.

- [ ] **Step 1: Write the failing selection test** (extend `test/combat/duelScope.test.ts`). Build minimal combatants + an ability and assert the resolved `delta.targets` from the `'attack'` event. Read `src/shared/combat/types.ts` for the exact `Combatant`/`StatBlock` shape and `src/main/services/combatService.ts`'s `block(...)` helper, then:

```ts
import { applyAbilityEffect } from '../../src/shared/combat/deckbuilder/deckResolve'
import { makeRng } from '../../src/shared/combat/dice'
import type { AbilityDef, Combatant, CombatEvent } from '../../src/shared/combat/types'

// minimal combatant with just enough ext for poemHit/HealOne; confirm StatBlock fields vs types.ts
const mk = (id: string, side: 'party' | 'enemy', hp = 100): Combatant => ({
  id, side, name: id, pos: [0, 0],
  block: { hp, maxHp: hp, ac: 10, mods: {}, abilities: [], conditions: [] },
  ext: { attrs: { 力量: 5, 精神: 5 }, tier: 1, maxHp: hp }
} as unknown as Combatant)

const ability = (ext: Record<string, unknown>): AbilityDef =>
  ({ id: 'a/x', name: 'X', ext } as unknown as AbilityDef)

const resolvedTargets = (combatants: Combatant[], actorId: string, ab: AbilityDef, picked: string[]): string[] => {
  const events: CombatEvent[] = []
  applyAbilityEffect(combatants, actorId, ab, picked, makeRng(1), undefined, events)
  const atk = events.find((e) => e.kind === 'attack')
  return ((atk?.delta?.targets as string[]) ?? [])
}

describe('scope-driven target selection', () => {
  it('单体 damage hits exactly the picked enemy', () => {
    const cs = [mk('hero', 'party'), mk('e1', 'enemy'), mk('e2', 'enemy')]
    expect(resolvedTargets(cs, 'hero', ability({ 威力: 20 }), ['e2'])).toEqual(['e2'])
  })
  it('群体 damage hits all living enemies', () => {
    const cs = [mk('hero', 'party'), mk('e1', 'enemy'), mk('e2', 'enemy')]
    expect(resolvedTargets(cs, 'hero', ability({ 威力: 20, 目标模式: '群体' }), []).sort()).toEqual(['e1', 'e2'])
  })
  it('随机X damage resolves X hits among enemies (with replacement)', () => {
    const cs = [mk('hero', 'party'), mk('e1', 'enemy'), mk('e2', 'enemy')]
    const hits = resolvedTargets(cs, 'hero', ability({ 威力: 20, 目标模式: '随机', 随机次数: 4 }), [])
    expect(hits.length).toBe(4)
    expect(hits.every((id) => id === 'e1' || id === 'e2')).toBe(true)
  })
  it('群体 heal targets all living allies, not enemies', () => {
    const cs = [mk('hero', 'party'), mk('ally', 'party'), mk('e1', 'enemy')]
    const t = resolvedTargets(cs, 'hero', ability({ 治疗: true, 威力: 10, 目标模式: '群体' }), []).sort()
    expect(t).toEqual(['ally', 'hero'])
  })
  it('单体 heal targets the picked ally', () => {
    const cs = [mk('hero', 'party'), mk('ally', 'party'), mk('e1', 'enemy')]
    expect(resolvedTargets(cs, 'hero', ability({ 治疗: true, 威力: 10 }), ['ally'])).toEqual(['ally'])
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (群体/随机/heal selection not implemented; 群体 currently hits only the passed `targetIds`).

- [ ] **Step 3: Implement scope-driven selection** in `applyAbilityEffect` (`src/shared/combat/deckbuilder/deckResolve.ts`). Replace the current target block (lines 51-54, the `isHeal`/`targets`/`范围目标` lines) with:

```ts
  const isHeal = !!ext.治疗 || (ext.治疗量 ?? 0) > 0
  const side = isHeal ? actor.side : actor.side === 'party' ? 'enemy' : 'party'
  const pool = combatants.filter((c) => c.side === side && isAlive(c))
  const mode = (ext as { 目标模式?: '单体' | '随机' | '群体' }).目标模式 ?? '单体'
  let targets: Combatant[]
  if (mode === '群体') {
    targets = pool
  } else if (mode === '随机' && pool.length) {
    const n = Math.max(1, (ext as { 随机次数?: number }).随机次数 ?? 1)
    targets = Array.from({ length: n }, () => pool[Math.floor(rng() * pool.length)])
  } else {
    // 单体 (default): the picked target (must be on the resolved side + alive), else first living
    const picked = pool.find((c) => targetIds.includes(c.id))
    targets = picked ? [picked] : pool.length ? [pool[0]] : []
  }
```

Add `目标模式`/`随机次数` to the local `PlayExt` interface (lines 15-22) so the cast is typed:
```ts
  目标模式?: '单体' | '随机' | '群体'
  随机次数?: number
```
The downstream loop (`for (const target of targets) …`) is unchanged. Remove the old `范围目标` slice (it was the grid cap; the duel now uses scope).

> `rng` is the `Rng` already passed into `applyAbilityEffect`. `isAlive` is the existing local helper. The `'attack'` event push (lines 56-60) already records `targets.map(t => t.id)` — keep it; that's what the test asserts.

- [ ] **Step 4: Run the tests — expect PASS** (all 5 selection cases + Task 1's parse test). Then the full gate.

Run: `npm run typecheck && npm run check:deps && npm run test`

- [ ] **Step 5: Commit**

```bash
git add src/shared/combat/deckbuilder/deckResolve.ts test/combat/duelScope.test.ts
git commit -m "feat(duel): scope-driven target selection (单体/随机/群体) for damage + heal"
```

---

## Task 3: mock duel deck — one card per mode + a heal card

**Files:**
- Modify: `src/main/services/duelService.ts`

**Interfaces:**
- Consumes: the parser (Task 1) — the mock skills carry the duel-scope tags. Produces: a mock deck exercising 单体/群体/随机 + heal, for the manual UI check in Task 4.

- [ ] **Step 1: Add scope + heal skills to the mock** Read `src/main/services/duelService.ts`'s `MOCK_STAT_DATA`. Add three skills to `主角.技能` (alongside `火球术`) so the built deck contains every mode + a heal:

```ts
    技能: {
      火球术: {
        品质: '稀有', 类型: '主动', 消耗: '攻击: 200 MP',
        标签: ['智力', '范围: 爆发', '威力: 300', '有效距离: 6'], 效果: { 灼烧: '30+2回合' }, 描述: ''
      },
      横扫: {
        品质: '优良', 类型: '主动', 消耗: '攻击: 60 SP',
        标签: ['力量', '威力: 90', '群体'], 效果: {}, 描述: ''
      },
      连环箭: {
        品质: '优良', 类型: '主动', 消耗: '攻击: 50 SP',
        标签: ['敏捷', '威力: 40', '随机3'], 效果: {}, 描述: ''
      },
      治愈术: {
        品质: '优良', 类型: '主动', 消耗: '攻击: 120 MP',
        标签: ['精神', '威力: 200', '治疗'], 效果: {}, 描述: ''
      }
    },
```

(横扫 = 群体 attack; 连环箭 = 随机3 attack; 治愈术 = 单体 heal — defaults to 单体 since no scope tag, so it'll exercise the new ally picker. Optionally give 艾莉亚 a 群体-heal for the AOE-heal path, but one heal in the mock is enough.)

- [ ] **Step 2: Confirm the mock still builds + gate**

Run: `npx vitest run test/combat/duelService.test.ts` (the existing mock-duel tests must still pass — the deck now has more cards; if a test asserts an exact card count, update it deliberately). Then the full gate `npm run typecheck && npm run check:deps && npm run test`.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/duelService.ts
git commit -m "feat(duel): mock deck exercises 群体/随机/heal scopes"
```

---

## Task 4: DuelView scope-aware targeting + ally picker

**Files:**
- Modify: `src/renderer/src/components/workspace/DuelView.tsx`

**Interfaces:**
- Consumes: `state.cards`/`catalog` (the card ext now carries `目标模式`/`治疗`); the existing `flyThenPlay`/`flyingRef`/`play`/`pickCard`/`clearSelection`.

- [ ] **Step 1: Extend `cardOf` + add scope helpers.** Read the current `DuelView.tsx`. Widen `cardOf`'s `ext` type to expose the scope + heal fields, and add helpers above `onCardClick`:

```tsx
  const fullExt = (cid: string) =>
    (catalog[state.cards[cid]?.abilityId]?.ext ?? {}) as {
      威力?: number; 治疗?: boolean; 治疗量?: number; 格挡?: boolean; 目标模式?: '单体' | '随机' | '群体'
    }
  const isHealCard = (cid: string): boolean => {
    const e = fullExt(cid)
    return !!e.治疗 || (e.治疗量 ?? 0) > 0
  }
  // What the card needs the player to pick: an enemy, an ally, or nothing (auto-resolve).
  const targetKind = (cid: string): 'enemy' | 'ally' | 'auto' => {
    const e = fullExt(cid)
    if (cardOf(cid).ability?.name === '格挡' || e.格挡) return 'auto' // self
    if ((e.目标模式 ?? '单体') !== '单体') return 'auto' // 群体/随机 resolve over all/random
    return isHealCard(cid) ? 'ally' : 'enemy' // 单体: pick enemy (damage) or ally (heal)
  }
  const selectedKind = selection.mode === 'card' ? targetKind(selection.cardId) : null
```

- [ ] **Step 2: Rewrite `onCardClick` + generalize the unit click.** Replace `needsEnemyTarget` + `onCardClick` + `onEnemyClick` with:

```tsx
  const onCardClick = (cid: string): void => {
    if (selection.mode === 'card' && selection.cardId === cid) {
      clearSelection()
    } else if (targetKind(cid) === 'auto') {
      pickCard(cid)
      void play(profileId, [])
    } else {
      pickCard(cid) // wait for an enemy/ally click
    }
  }
  // One handler for clicking any targetable unit (enemy for damage, ally for heal). The flyingRef
  // guard + fly-to-target are unchanged from the v1 fix wave.
  const onUnitClick = (id: string): void => {
    if (flyingRef.current || selection.mode !== 'card') return
    flyingRef.current = true
    const cardEl = document.querySelector('.rpt-duel-card.picked') as HTMLElement | null
    flyThenPlay(cardEl, id)
  }
```

(Delete the old `needsEnemyTarget` and the old `onEnemyClick`; `flyThenPlay` is unchanged — it flies the ghost toward whatever `[data-cid]` unit was clicked.)

- [ ] **Step 3: Make enemies + party scope-targetable.** In the enemies map, change `targetable` + the click:

```tsx
              const targetable = selectedKind === 'enemy' && c.block.hp > 0
              // …
                  <button
                    className={`rpt-duel-unit foe${targetable ? ' targetable' : ''}`}
                    disabled={!targetable || busy}
                    onClick={() => onUnitClick(c.id)}
                    data-cid={c.id}
                  >
```

In the **party** map, turn each unit from a `<div>` into a `<button>` (so allies are clickable for 单体-heal), keeping the lead ring + data-cid:

```tsx
              const targetable = selectedKind === 'ally' && c.block.hp > 0
              return (
                <button
                  key={c.id}
                  className={`rpt-duel-unit ally${c.id === state.lead ? ' is-lead' : ''}${targetable ? ' targetable' : ''}`}
                  disabled={!targetable || busy}
                  onClick={() => onUnitClick(c.id)}
                  data-cid={c.id}
                >
                  {/* ava + name + UnitBars unchanged */}
                </button>
              )
```

(The `.rpt-duel-unit` class already resets button chrome — enemies use it as a button today, so allies-as-button match. The `.rpt-duel-unit.ally.targetable` reuses the existing `.targetable` affordance, or add a tinted ally-target rule in index.css if you want a distinct ally highlight — token-only.)

- [ ] **Step 4: Gate + manual check**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: PASS.
**Manual:** `npm run dev` → Duel view → Start mock duel. Confirm: 普攻/火球术 (single attack) → pick an enemy (today); **横扫 (群体)** → plays immediately, damage floats on **both** goblins; **连环箭 (随机3)** → plays immediately, 3 damage floats scattered across enemies; **治愈术 (heal)** → the **party** units highlight, click 主角/艾莉亚 → that ally heals (green float, HP bar rises). 格挡 still self-plays. End turn still works.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/workspace/DuelView.tsx
git commit -m "feat(duel): scope-aware targeting + ally picker for single-target heals"
```

---

## Self-Review

**Spec coverage:** new `目标模式`/`随机次数` field + parse, grid untouched (spec §1) → Task 1. Scope-driven selection, side-by-isHeal, 随机 with-replacement (§2) → Task 2. Heal completion = ally targeting (§3) → Tasks 2+4. DuelView scope-aware targeting + ally picker (§4) → Task 4. Enemy intents inherit (§5) → free (they call `applyAbilityEffect`; no task needed — verified by the shared path). Mock exercises modes (§6) → Task 3. Tests for 单体/群体/随机 × damage/heal + parse (§6) → Tasks 1-2. Engine pure, default 单体, no math change (constraints) → honored. ✓

**Placeholder scan:** Two grounded read-then-match points — the `Combatant`/`StatBlock` shape for the test `mk` helper (Task 2 step 1, vs `types.ts`/`combatService.block`) and the exact insert position in the parser chain (Task 1 step 4). Both name the source + what to confirm; not missing logic. All code steps show complete code. ✓

**Type consistency:** `CardCombat.目标模式`/`随机次数` (Task 1) read by `applyAbilityEffect`'s `PlayExt` (Task 2) and by `DuelView.fullExt`/`targetKind` (Task 4). `applyAbilityEffect` signature unchanged across tasks. `targetKind` returns `'enemy'|'ally'|'auto'` consumed by `selectedKind` + the unit `targetable` flags (Task 4). The mock skills' tags (Task 3) match the parser branches (Task 1). ✓

---

## Execution

Build in order (1 field+parse → 2 engine selection → 3 mock → 4 UI). Each task ends green on `npm run typecheck && npm run check:deps && npm run test`; Task 4 adds the manual mock-duel check (the engine selection is fully unit-tested in Task 2). Execute via subagent-driven development or executing-plans.
