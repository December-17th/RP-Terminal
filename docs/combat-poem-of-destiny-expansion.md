# 命定之诗 Combat Expansion — Design (in progress)

Status: **Design in progress (2026-06-25).** The RP Terminal **app** combat system is fully built &
committed (branch `feat/combat-system`, see [combat-system-design.md](combat-system-design.md) +
[plans/2026-06-25-combat-system.md](superpowers/plans/2026-06-25-combat-system.md)). This doc is the
**next phase: a combat expansion for the 命定之诗 CARD itself** — the app's native combat engine
(`src/shared/combat`, `combatService`) and the `extensions.rp_terminal.combat` bundle slot are the
**fixed contract** we author against. Some generic app machinery is in scope (the bundle schema, a
`buildEncounterFromMvu`, an `ext` affordance, the resolver seam); the card supplies the config, the
resolver script, the MVU UI, and the preset instruction.

> **2026-06-25 investigation rewrote this doc.** The earlier model (a new `战斗` sub-object holding dice
> like `2d6+智力`, resolved by the engine's native d20) is **wrong on two counts** — see "What changed".

## Scope (owner-locked via Q&A)
- Expansion **for the 命定之诗 character card**, not a redesign of the RP Terminal app.
- Use the **card's own 5-attribute schema** (力量/敏捷/体质/智力/精神, not D&D 6). Map what exists, define
  the rest. Equipment is fully slotted.
- Combat numbers are **AI-authored MVU variables** the AI already writes when it creates an item/ability,
  and the **MVU UI displays them** (same variable system, no separate bundle catalog). ✔ Confirmed: the
  card already does exactly this.
- Card-UI edits ship as a **standalone status-area regex JSON** (the live status UI is a remote loader).

### Why we build this (the strategic frame — owner, 2026-06-25)
The deliverable is an **extension (mod) for the 命定之诗 character card**, NOT a redesign of the app.
But we **co-develop it alongside the app's combat system on purpose**: the card extension is the first
real consumer of the combat SDK, so building it is how we discover **what card-facing APIs the SDK must
expose and what features the app must support.** Rule of thumb for the whole phase: when the extension
needs something the app/SDK doesn't offer yet, that gap is a signal — add the generic affordance to the
app, document it in `docs/sdk/`, and let the card consume it. Keep a running "SDK delta" per phase.

## The 命定之诗 stat_data schema (recovered — authoritative)
From `FrontEnd-for-destined-journey@1.8.2/dist/data_schema/index.js`. Top-level: `事件`, `世界{时间,地点}`,
`任务列表`, **`主角`** (player), `命运点数`, **`关系列表`** (companions keyed by name — same character
fields + `在场`/`好感度`/`性格`/…), `新闻`.

A **character** (`主角` / each `关系列表[name]`):
- `种族`, `身份[]`, `职业[]`, `生命层级`, `等级`(1–25), `累计经验值`, `升级所需经验`, `冒险者等级`, `属性点`
- **`属性`**: `{力量,敏捷,体质,智力,精神}` (start at **0**; grow via 属性点)
- **`生命值`/`生命值上限`**, `法力值`/`上限`, `体力值`/`上限` (flat number pairs)
- **`状态效果`**: record<key,`{类型(增益/减益/特殊),效果,层数,剩余时间,来源}`>
- `金钱`, **`背包`**: record<item,`{品质,类型,数量,标签[],效果:record<str,str>,描述}`>
- **`装备`**: record<slot,`{品质,类型,标签[],效果:record<str,str>,描述,位置}`>
- **`技能`**: record<name,`{品质,类型,消耗,标签[],效果:record<str,str>,描述}`>
- `登神长阶` (ascension): `{是否开启,要素,权能,法则,神位,神国{名称,描述}}`

### Schema strictness — RESOLVED: effectively strict / whitelisted
The remote schema is NOT `.passthrough()`. 技能/背包/character objects end in
`.transform(r => _.pick(r, [whitelist]))`, so **any unknown key is actively deleted** by MVU validation
(not merely stripped). We can't edit the remote schema. → **A free-floating `战斗` sub-object cannot
survive.** Combat data must ride in the **preserved** fields: `标签` (`string[]`), `效果`
(`record<string,string>` — arbitrary keys), `消耗`. The card's *own* convention already puts it there.

## The card's combat protocol (recovered — this is the real system)
The card ships a complete, self-contained d20 combat system in its worldbook. It is explicitly **not**
"copy D&D values" ("而不是照抄dnd设定，本世界无任何社交/感知等日常类检定") and explicitly
**"无任何五维属性加成(转为检定加值)"** — attributes feed **检定 modifiers**, not flat damage.

**`<核心数值表>`** (generation + combat constants):
- 战斗层级系数 (by 生命层级 1→7): `2.0 / 2.8 / 4.0 / 8.0 / 15.0 / 35.0 / 80.0`
- 装备值 单件攻/防 (by 品质): 普 5–25 … 神 1400–2500
- 技能威力 (by 品质): 普攻 20, 普 50–100 … 神 5000–8000
- HP乘数: `1/2/4/10/20/40/100`; MP·SP乘数: `1/2.5/6/15/35/80/160`
- 战术部位与致死意图 (only <user> input triggers; NPC/allies = 常规): part → DC `+5/+10/+15/+20`
  & damage coefficient `×1.0/1.2/1.4/1.6`.

**`<角色生成>`** resource derivation (the attribute→resource scale — open point 2 RESOLVED):
- `HP = 体质 × 100 × HP乘数 + Σ五维`
- `MP = (智力+精神) × 50 × MP/SP乘数`
- `SP = (力量+敏捷) × 50 × MP/SP乘数`
- 五维 = 基础(0–6 each, Σ≤25) + 层级(生命层级−1, per stat) + 分配(Σ = 等级−1)
- char_info panel格式: 技能 `标签:[关联属性][目标类型][核心功能][威力][特性]`; 装备 `标签:[攻击/防御:N]`.

**`<战斗协议>`** resolution (the engine target):
- **行动顺序**: `(敏捷 × (1+%修正)) + d20 + 固定修正` → descending.
- **攻击检定**: d20 pool by 生命层级 gap (higher→2d20 high / lower→2d20 low / same→1d20);
  `检定总值 = d20 + 命中 − 闪避`. **评级**: ≥30 超暴击 2.0 | ≥25 强暴击 1.6 | ≥20 暴击 1.3 |
  11–19 有效 1.0 | 8–10 勉强 0.8 | 4–7 擦伤 0.3 | ≤3 失手 0.
- **伤害**: `初始 = 关联属性×10×层级系数 + 技能威力 + 武器攻击` (÷N for 多段/连击).
  穿透: `有效防御 = 防御×(1−穿透%)`. 装备减免: `构成 × 有效防御/(有效防御+2000)`.
  属性减免: 物理 `(体+力+敏)×0.25%` | 能量 `(精+智)×0.4%` | 精神 `精×0.8%` | 真实 0.
  结算: `((基础×评级系数×意图系数)+额外固定伤害)×攻击次数 × (1−DR%)`; 集群 ×1.5.
- **意图对抗** (only <user>): `(攻方层级×5+d20) vs (守方层级×5+d20+意图难度)`; 层级压制 if
  攻方层级 < 守方层级−1.
- **状态**: crit(≥20) always; 有效/勉强 → opposition `(攻方属性+d20) vs (守方属性+d20)`; control +5 to
  defender resist.
- **战术动作**: 1 [动作]; 逃跑 = opposition on 敏捷. **战意/morale**: non-<user> below HP threshold →
  surrender/flee pool. **战斗结算**: EXP/FP/loot.
- "**根据本次 d20 骰池顺序取骰**" — the card DOES use d20; checks are 命中/闪避/先攻/状态抵抗.

**There is no AC** (open point 3 RESOLVED). To-hit subtracts `闪避`; defense is **damage reduction**
(`防御/(防御+2000)` + 属性减免%). Carry `闪避` and `防御`, not an AC.

## What changed (vs the earlier model in this doc)
1. **No new `战斗` field** — the schema deletes unknown keys. "Formalize the import" = a **parser over the
   card's existing `标签`/`效果`/`消耗` grammar** + a `stat_map`. (The owner's locked "AI authors numbers,
   MVU UI displays them" holds exactly — the card already works this way.)
2. **The engine's native resolver is the wrong game** (it's classic D&D: STR…CHA, `d20≥AC`, dice damage,
   tens-scale HP). 命定之诗 has its own calibrated protocol above. → the expansion ships a **card resolver
   implementing `<战斗协议>`**, plugged into the existing `resolveAction` RunHook. The engine contributes
   the grid / positioning / turn-order / action-economy / range·LoS / AoE templates the card only narrates.

## Combat modes (owner-decided 2026-06-25)
At combat entry the AI **prompts the start of combat and generates the combat variables needed** (e.g.
enemy `char_info` via `<角色生成>`; party stats are read from MVU). The player then picks:

- **Classic mode** — let the AI determine the whole fight through chat (today's card behavior; engine not
  entered).
- **Combat system — Narrate** — player plays on the grid; engine resolves **each turn deterministically**;
  AI narrates **at the end of each turn**.
- **Combat system — Deterministic** — player plays; engine resolves the **whole fight**; AI narrates
  **once at the end**.
- **Creative input box** *(DEFERRED — record only)* — on any turn the player may type a freeform action
  into the combat input box; the AI determines that turn's outcome and writes it back to combat state
  (this is phase A's improvise/`adjudicate` path). Build later.

Both combat-system modes ⇒ **deterministic engine resolution** (no AI in the math loop), differing only in
AI narration cadence. The app already has `settings.combat.narrationMode` + the improvise/adjudicate path
from phase A to build on; mode is selected **per-encounter at entry**, not as a global setting.

## Field grammar + parsed shape + stat_map + derive (SIGNED OFF 2026-06-25)
The "战斗 spec" is the canonical **parse** of the card's real fields, not a new MVU field. The parsed
`CardCombat` + the character's 五维 are carried on combatants/abilities via an **optional `ext` bag**
(`ext?: Record<string,unknown>` on `Combatant`/`AbilityDef`, non-breaking; native cards ignore it; the
card resolver reads it). `derive` stays **pure data** (tables + tunables) — formulas live in resolver
code, so there is no eval/formula-string surface.

**Parser source → normalized `CardCombat` (carried on combatant/ability via an optional `ext` bag):**
- 技能 `消耗` `"攻击: 50 MP"` → `{slot:'攻击'|'动作', mp,sp,hp}`
- 技能 `标签`: bare `力量/…` → `关联属性`; `有效距离: X` → range(cells); `范围:[层级][+形状]` →
  AoeShape (爆发→burst, 直线→line, 锥形→cone, 自身→self, 单体→single); `威力: X` (or 品质 fallback) → 威力;
  特性/可选机制 (多段/连击 N).
- 装备 `标签`: `攻击: N` / `防御: N`; `位置` slot.
- `效果` record keys: `命中/闪避/先攻/状态抵抗: +N` (multi-source = **max, not sum**); 固伤 → 额外固定伤害;
  `DR/穿透/暴击倍率`; typed split `物理(60%)/能量(40%)`; 附加效果 `状态名: 数值+回合` → Condition.
- Missing 威力 → unarmed fallback (普攻 20).

```jsonc
"stat_map": {
  "player": "主角",
  "party":  { "from": "关系列表", "filter": { "在场": true } },
  "paths": {                        // logical key (SDK English) → path inside a character (card CJK)
    "attributes":"属性", "hp":"生命值","maxHp":"生命值上限",
    "mp":"法力值","maxMp":"法力值上限", "sp":"体力值","maxSp":"体力值上限",
    "level":"等级", "tier":"生命层级",
    "equipment":"装备", "skills":"技能", "conditions":"状态效果"
  }
}
"derive": {                         // pure DATA tables — formulas live in resolver code (no eval)
  "attributes": ["力量","敏捷","体质","智力","精神"],
  "tier_coefficient":  {"1":2.0,"2":2.8,"3":4.0,"4":8.0,"5":15.0,"6":35.0,"7":80.0},
  "hp_multiplier":     {"1":1,"2":2,"3":4,"4":10,"5":20,"6":40,"7":100},
  "mp_sp_multiplier":  {"1":1,"2":2.5,"3":6,"4":15,"5":35,"6":80,"7":160},
  "rating_tiers": [[30,2.0],[25,1.6],[20,1.3],[11,1.0],[8,0.8],[4,0.3],[0,0]],
  "attr_mitigation": {"物理":0.0025,"能量":0.004,"精神":0.008,"真实":0}, "defense_constant": 2000
}
```
**Key-language convention (BP1):** structural keys (`stat_map`/`derive`/`paths` fields) are the SDK's
English snake_case (`StatMap`/`DeriveConfig` in `src/shared/combat/bundle.ts`); the card's domain terms
appear only in **values** (`主角`, `关系列表`, `力量`, `生命值`) and **record keys** (生命层级 `"1".."7"`;
物理/能量/精神/真实). `buildEncounterFromMvu` reads 生命值上限/法力值上限/体力值上限 **directly** from MVU
(the card already stores them), using the 资源推演 formula only as a fallback when missing.

## Open points — all RESOLVED by the investigation
1. **Strictness** → whitelisted/strict; no `战斗` sub-object; use 标签/效果/消耗. ✔
2. **Attribute→resource scale** → `<角色生成>` formulas (read MVU directly; formula = fallback). ✔
3. **AC** → there is none; carry 闪避 (hit subtrahend) + 防御 (damage reduction). ✔
4. **Field names** → verified grammar (关联属性/有效距离/范围/威力/攻击/防御/命中/闪避/先攻/状态抵抗/消耗). ✔

## Card UI inventory (verified from `v4.2.1.png` `regex_scripts`)
- `角色查看器v3.0.5` — 64 KB inline Vue character sheet (reads `stat_data`).
- `状态栏` — remote loader → `FrontEnd-for-destined-journey@1.8.2/dist/status/index.html` (minified;
  can't hand-edit → ship a standalone regex instead).
- `战斗&生产制作美化` — inline "TRPG战斗面板" beautification of AI-written combat text → the old
  AI-narration paradigm = **Classic mode**'s display; keep it for that mode.

## Key locations
- Card + scripts: `example sillytarvern character card, presets, extensions and scripts/` — `v4.2.1.png`
  (the card; worldbook holds `[战斗协议]`,`[核心数值表]`,`[角色生成]`,`[技能装备道具生成规则]`,
  `[品质效果限定]`,`[战斗生产规则]`), preset `命定之诗Kemini5-3.8Can改v6.1.json`
  (`🛑ROLE主提示`,`🚫正文cot@cancannide`), the MVU loaders (`mvu zod`,`MVU beta` — remote stubs).
- Remote bundle: `https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/`.
- Engine to extend: `src/shared/combat/bundle.ts` (`buildEncounter` → add `buildEncounterFromMvu`),
  `src/shared/combat/types.ts` (optional `ext` bag on Combatant/StatBlock/AbilityDef),
  a card resolver implementing `<战斗协议>` for the `resolveAction` RunHook,
  `src/main/types/character.ts` (`CombatBundleSchema` += `stat_map`/`derive`).

## Implementation
Field spec, stat_map/derive, and the `ext`-bag approach are **signed off (2026-06-25)**. The phased plan
lives in [plans/2026-06-25-poem-combat-extension.md](superpowers/plans/2026-06-25-poem-combat-extension.md)
— it splits each phase into **App/SDK surface** (generic, reusable, documented in `docs/sdk/`) vs
**card-extension content** (命定之诗-specific), and captures an SDK delta per phase. Review/test/commit
after each phase. The creative-input box stays deferred (recorded there).
