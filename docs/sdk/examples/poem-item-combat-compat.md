# 命定之诗 — item-format combat compatibility (lorebook addendum)

The combat engine reads an item's combat numbers **only if the AI writes them in the token shapes the
parser (`parseCardItem`) recognizes**. The card's `[技能装备道具生成规则]` / `[品质效果限定]` already
emit most of them; this addendum closes the two gaps that would otherwise silently degrade to defaults,
and documents exactly which effects are **mechanical** (the engine applies them) vs **narrative-only** in v1.

> **Applied:** `patch-poem-card.cjs` appends the `<战斗数据规范>` block below into the card's
> `[技能装备道具生成规则]` worldbook entry (in `v4.2.1+combat.png`). Use the paste-in form only if
> integrating into a different card by hand.

## Two required tightenings
1. **`威力` must be a literal number** in the 技能 标签 (e.g. `威力: 300`), chosen from `<核心数值表>` —
   never a quality word. If it's missing/non-numeric the engine treats the skill as a basic attack
   (普攻威力 20).
2. **`有效距离: X` is mandatory** on every active skill and weapon (cells). Missing ⇒ the engine assumes
   melee (range 1).

Paste-in tightening:
```
<战斗数据规范>
- 技能标签中「威力」必须为具体数值（参照<核心数值表>），如「威力: 300」，不得写品质词。
- 每个主动技能/武器必须带「有效距离: X」（格数）；范围技能额外带「范围: [爆发/直线/锥形/单体/范围:X]」。
- 装备战斗数值用「攻击: N」「防御: N」；技能消耗用「消耗: 攻击/动作: X MP/SP」；关联属性用五维之一作为独立标签。
- 战斗类效果优先用规范效果名作为键（命中/闪避/固伤/伤害增幅/减伤增幅/护盾/穿透/暴击倍率/治疗/治疗增幅/附加效果），
  数值写在值里；若沿用风味名（如「充能」），须在值的描述中写明机制（如「提高12%伤害」「获得50点护盾」「额外造成5点伤害」），以便解析。
</战斗数据规范>
```
**Robustness:** the engine's `parseCardItem` reads the structured keys above AND **scans the value prose**
for the same mechanics (提高X%伤害→伤害增幅, X点护盾→护盾, 额外X点伤害→固伤, 减伤/减少X%→DR, X%穿透→穿透,
恢复X点→治疗), so the existing **flavor-keyed catalog items** (e.g. `充能: 提高12%伤害`) parse too — the
tightening just makes AI-authored items cleaner/less ambiguous.

## Effect contract — what the engine consumes (`效果` keys)
**Mechanical (applied by the 战斗协议 resolver):**
- `命中` / `闪避` / `先攻` / `状态抵抗` (检定 modifiers; "命中检定: +2" also matches) — multi-source = max.
- `固伤` (→ 额外固定伤害), `穿透: X%`, `暴击倍率`.
- `DR: X%` **and `减伤增幅: X%`** (both reduce incoming damage — they fold into the same DR step).
- **`伤害增幅: X%`** (百分比) — multiplies the attacker's outgoing damage ×(1+X%).
- **`护盾: N`** (资源) — a flat pool that absorbs damage before HP (aggregated from gear/passives at
  combat start, depleted during the fight).
- 附加效果 `状态名: 数值+持续回合` (e.g. `灼烧: 30+2回合`) → a condition applied on hit (crit auto;
  有效/勉强 via an opposition check).
- **Healing** — a skill with 核心功能 `治疗` heals (`base = 关联属性×10×层级系数 + 威力`); a flat
  `治疗: N` / `恢复: N` (资源) adds to it; `治疗增幅: X%` multiplies. Heals auto-apply to same-side
  targets (no 命中检定), clamp to maxHp, and aren't reduced by 防御/属性减免/DR.

**Narrative-only in v1 (the engine does NOT yet apply these — keep them as flavor or avoid relying on
them mechanically):**
- `资源消耗减免: X%` — MP/SP cost reduction (not applied to 消耗 yet).
- typed-damage split proportions (物理/能量/精神/真实 %) — the resolver currently treats all damage as
  物理 for 属性减免 (typed split is a later refinement).
- 集群 (cluster ×1.5), 意图/部位 (×系数), 战意/morale — deferred (see the design doc).

See [combat-poem-of-destiny-expansion.md](../../combat-poem-of-destiny-expansion.md) for the full
`<战斗协议>` mapping, and [poem-preset-combat-instructions.md](poem-preset-combat-instructions.md) for the
combat-start roster snippet.
