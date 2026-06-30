# Duel effect-scope modes (单体 / 随机 / 群体) + heal targeting — Design

Status: **Design approved (2026-06-30).** Give duel cards a **target-selection scope** — 单体 (single), 随机X (X
random hits), 群体 (AOE) — that the duel resolver applies to a card's damage **or** heal, and finish **heal
targeting** in the UI (the engine already heals; the v1 DuelView never gave heal cards ally targets). Builds on the
native DuelView ([2026-06-30-native-duelview-design.md](2026-06-30-native-duelview-design.md)) and its engine
(`src/shared/combat/deckbuilder`).

---

## 0. Locked decisions (owner Q&A, 2026-06-30)

1. **Duel scope is a new explicit field, separate from grid combat.** The existing `shape` (锥形/爆发…) +
   `范围目标` + `多段` on `CardCombat` are **grid-combat** concepts and stay untouched. The duel gets its own
   `目标模式` field, read only by the duel resolver.
2. **Three modes:** `单体` (single target), `随机` (X hits on random targets), `群体` (all targets on the side).
3. **Orthogonal to damage/heal — all three apply to both.** The mode is a target-selection strategy; the effect
   (damage vs heal) decides the **side** (damage → enemies, heal → allies). 单体 heal = one ally, 群体 heal = all
   allies, 随机 heal = X random allies.
4. **随机 is with-replacement** — each of the X hits picks a random living target independently, so a target can be
   hit more than once (Slay-the-Spire "scatter").
5. **单体 needs a player pick; an ally picker is added for 单体-heal.** 群体/随机 need no pick (the engine expands).
6. **Default 单体.** A card with no `目标模式` behaves exactly as today (single target) — no regression.
7. **Enemy intents inherit scope for free** (they resolve through the same `applyAbilityEffect`).

---

## 1. The new card field

Add to `CardCombat` ([poemStrike.ts:18-45](../../../src/shared/combat/systems/poemStrike.ts)):

```ts
  目标模式?: '单体' | '随机' | '群体'   // duel target-selection scope (default 单体). Grid uses shape/范围目标 instead.
  随机次数?: number                      // X for 随机 (default 1 when 目标模式==='随机' and unset)
```

**Authoring + parse.** A card declares the duel scope via a duel-specific 标签, parsed in
[poemD20.ts](../../../src/shared/combat/systems/poemD20.ts)'s skill-tag parser (the same loop that reads
`多段|连击` → `多段` at `:133` and `治疗` at `:169`). The exact tag syntax (e.g. `目标:单体` / `目标:随机3` /
`目标:群体`, or `随机:3` / `群体`) is finalized in the plan; it MUST NOT collide with the grid shape tags
(单体/锥形/爆发 at `:65-75`, which keep producing `shape`/`范围目标`). When absent → `目标模式` unset → resolver
treats as 单体.

---

## 2. Engine target-selection (`deckResolve.applyAbilityEffect`)

Today [applyAbilityEffect:52-54](../../../src/shared/combat/deckbuilder/deckResolve.ts) uses the caller's
`targetIds` (intersected with combatants, alive-filtered) and a `范围目标` slice. Replace that selection with a
scope-driven `selectTargets`:

```
isHeal = !!ext.治疗 || (ext.治疗量 ?? 0) > 0           // unchanged
side   = isHeal ? actor.side : opposite(actor.side)    // damage → enemies, heal → allies
pool   = combatants.filter(c => c.side === side && alive(c))
switch (ext.目标模式 ?? '单体'):
  单体: targets = [ pool.find(c => targetIds.includes(c.id)) ?? pool[0] ]   // the picked one; else first living
  群体: targets = pool                                                      // all on the side
  随机: targets = Array.from({length: max(1, ext.随机次数 ?? 1)}, () => pool[floor(rng()*pool.length)])  // with replacement
```

Then per target: `poemHitOne` (damage) or `poemHealOne` (heal) — **unchanged**. 格挡/护盾/self abilities
([:42-49](../../../src/shared/combat/deckbuilder/deckResolve.ts)) keep their self branch and ignore scope.

- The `applyAbilityEffect` **signature is unchanged** (still takes `targetIds`); only its interpretation changes —
  单体 reads `targetIds[0]`, 群体/随机 ignore `targetIds` and compute from `pool`.
- 随机 consumes the `rng` already threaded through (advance the cursor as the engine already does).
- The old `范围目标` slice is removed from the duel path (it stays a grid concept; the duel uses 目标模式).

## 3. Heal "logic" = completing targeting

The engine already heals: `poemHealOne` ([poemStrike.ts:193](../../../src/shared/combat/systems/poemStrike.ts))
restores HP to an ally (no 命中检定/mitigation; `治疗增幅` amplifies), and `applyAbilityEffect` already side-filters
heal targets. The v1 gap was purely the UI giving heal cards no ally targets. With §2, heal cards select allies by
scope — **no new heal math**.

## 4. DuelView targeting UX (scope-aware)

In `DuelView.tsx`, the card-play interaction (currently: attack→pick enemy, else auto-`[]`) becomes scope-aware,
reading the card's `isHeal` + `目标模式`:

| Card | Pick? | Resolve |
| --- | --- | --- |
| 单体 + damage | pick an **enemy** | `play([enemyId])` (today) |
| 单体 + heal | pick an **ally** (NEW) | `play([allyId])` — party units become targetable for the selected heal card |
| 群体 / 随机 (damage or heal) | none | `play([])` on click — engine expands targets |
| 格挡 / self / power | none | self (today) |

- **Ally picker (new):** when a 单体-heal card is selected, party units get the targetable affordance + click handler
  (mirror the enemy-targetable styling, side-aware). The existing `flyingRef` double-fire guard + the fly-to-target
  ghost generalize (fly toward the picked ally for heal; for 群体/随机, skip the directed fly or burst over all).
- **Floats/feedback already adapt:** the engine emits one `damage`/`heal` event **per resolved target**, and the
  float effect spawns over each `[data-cid]` — so 群体 floats on every hit unit, 随机 on the random ones, with zero
  extra UI logic. The targeting helper just decides "pick vs auto" by scope.

## 5. Enemy intents inherit scope for free

Enemy/companion actions resolve through `resolveIntent` → the same `applyAbilityEffect`, so an enemy whose ability
is 群体/随机 hits the party per its scope automatically — no separate code. (Telegraphing the scope in the intent
bubble, e.g. "群体", is an optional later polish, not in scope here.)

## 6. Testing & boundaries

- **Headless engine tests** (`test/combat/`): for a damage card and a heal card at each mode —
  单体 resolves exactly one target (the picked / first living), 群体 resolves all living on the side, 随机 resolves
  `随机次数` hits (assert the event/target count, allowing repeats), heal restores HP toward `maxHp`, and a 单体-heal
  with a picked ally id heals that ally. Add a parse test: the duel tag → `目标模式`/`随机次数` on the ext.
- **Boundaries:** the change is in `deckResolve.ts` (selection) + `poemStrike.ts` (the field) + `poemD20.ts` (parse)
  + the renderer `DuelView.tsx` (targeting + ally picker) + the duel **mock** (`duelService` — give the mock deck one
  card per mode + a heal card so the UI/engine paths are exercised). Engine stays pure; `npm run check:deps` green.
- **Generic-engine note** ([[rpt-keep-app-engine-generic]]): the `目标模式` field lives in the poem `CardCombat` ext
  (poem authoring), but `selectTargets` is generic over sides — consistent with how `applyAbilityEffect` already
  reads `CardCombat`. The interim poem-coupling moves with the ruleset at genericization.

## 7. Non-goals

- No new damage or heal **math** (poemHitOne/poemHealOne unchanged).
- **Grid combat untouched** — its `shape`/`范围目标`/`多段` parsing and resolution are unchanged.
- No change to 护盾/格挡, conditions/附加效果, energy/消耗, or the turn loop.
- No intent-bubble scope label (optional later).

## 8. Related

- The duel engine + resolver: `deckbuilder/deckResolve.ts`, `systems/poemStrike.ts`, `systems/poemD20.ts`.
- The native DuelView + targeting it extends: [2026-06-30-native-duelview-design.md](2026-06-30-native-duelview-design.md).
- Generic-engine principle: memory `rpt-keep-app-engine-generic`.
