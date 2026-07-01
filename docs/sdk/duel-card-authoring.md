# Duel Card Authoring Guide — 命定之诗 卡牌对决 (RP Terminal deckbuilder)

Creator-facing contract + authoring guide for the **Slay-the-Spire-style duel mode** combat cards. It
covers (1) how to write lorebook entries so the AI generates skills/cards the engine can read, (2) every
data contract the duel-card system uses, (3) the duel-scoped script API for code-carrying cards, and (4)
general authoring guidelines.

> **Read this with the design spec.** The full system design is
> [docs/superpowers/specs/2026-06-30-poem-sts-card-duel-design.md](../superpowers/specs/2026-06-30-poem-sts-card-duel-design.md).
> This guide is the *authoring contract*; the spec is the *why*.

## Implementation status — read first

The duel system ships in phases. **Author against what's LIVE; treat DESIGNED surfaces as forthcoming.**

| Surface | Status |
| --- | --- |
| The duel **engine** (deck / energy / turn loop / intents) — `src/shared/combat/deckbuilder/` | ✅ **LIVE** (D1–D3) |
| The **field grammar** (`标签` / `效果` / `消耗`) parsed off MVU `技能`/`装备` — `parseCardItem` | ✅ **LIVE** |
| The **resolution math** (检定→评级→伤害→护盾→状态) — `poemStrike` | ✅ **LIVE** |
| Cards built from a character's MVU `技能` (build = deck) — `deckBuild` | ✅ **LIVE** |
| The AI **enemy roster** on the combat-start cue (A1) — `buildEncounterFromMvu({ roster })` | ✅ **LIVE** |
| **HP cost** in `消耗` (血祭 archetype) | ⚠️ **PARTIAL** — the engine deducts `消耗.hp`, but the MVU `消耗`-string parser reads only MP/SP today (see §4.2) |
| Authored `deck.cards` catalog + **two-file drop-in** card import (`<name>_卡面` + `<name>.card.json`) | 🚧 **DESIGNED (D6) — not built** |
| **Scripted** cards (the `onPlay` sandbox) | 🚧 **DESIGNED (D7) — not built** |
| Native **board UI** (`DuelView`) + per-encounter mode chooser | 🚧 **DESIGNED (D4) — not built** |

Sections below tag each contract `✅ LIVE`, `⚠️ PARTIAL`, or `🚧 DESIGNED`.

---

## 1. Mental model — where a duel card comes from

A duel is played as a hand of **cards**. Each card is backed by an **ability** with parsed combat numbers.
There are three ways an ability becomes a card; only the first is live today.

1. **From the character's MVU `技能` (build = deck).** `✅ LIVE`
   When a duel starts, the engine reads the lead's (and companions') `技能`/`装备` from `stat_data`, parses
   each with `parseCardItem`, and assembles a deck: copies of `普攻`, a synthesized `格挡`, and copies of
   each active 技能 by 品质 (§5). **This is the only authoring path that works right now** — you author a
   card by making the AI write a well-formed `技能` (§3, §4).
2. **From an authored `deck.cards` catalog (bundle).** `🚧 DESIGNED (D6)`
   Hand-designed cards shipped inside the character card's `extensions.rp_terminal.combat` bundle (§9).
3. **From a drop-in two-file card** (`<name>_卡面.<ext>` picture + `<name>.card.json` definition) imported
   via the World Assets pathway (§9). `🚧 DESIGNED (D6)`

All three converge on the **same card schema** the resolver understands (§4). Author your numbers once;
they mean the same thing whichever delivery path lands.

---

## 2. The number system in one paragraph (so your values make sense)

命定之诗 combat is **NOT D&D**. There is **no AC**. Attributes (`力量/敏捷/体质/智力/精神`) feed *检定
modifiers*, not flat damage. A hit rolls `d20`, adds your `命中` minus the target's `闪避`, and the total
picks a **评级 (rating)** multiplier from 0 to 2.0. Damage is built from `关联属性 × 10 × 层级系数 + 威力 +
武器攻击`, reduced by the target's `防御` (as `防御/(防御+2000)`) and attribute mitigation, multiplied by the
评级, then reduced by `DR%` and absorbed by `护盾`. Resources (HP/MP/SP) scale with `生命层级` (tier 1–7).
Numbers are **big** (HP in the thousands at mid tiers) — see the scale tables in §6.

---

## 3. Writing lorebook entries that generate skills / cards `✅ LIVE`

The engine reads what the AI already writes into MVU. Your lorebook/preset job is to make the AI emit
`技能` objects whose `标签` / `效果` / `消耗` follow the grammar in §4. Two existing deliverables are the
canonical references — keep them in sync with this guide:

- [docs/sdk/examples/poem-item-combat-compat.md](examples/poem-item-combat-compat.md) — the item/skill
  format audit + the two required tightenings (below).
- [docs/sdk/examples/poem-preset-combat-instructions.md](examples/poem-preset-combat-instructions.md) — the
  combat-start cue + (A1) enemy-roster instruction.

**Two hard rules for AI-authored skills (else they degrade):**

1. **`威力` must be a literal number** in `标签` (e.g. `"威力: 140"`). A missing/non-numeric 威力 falls back
   to the unarmed `普攻` value (20).
2. **Active skills/weapons must declare `有效距离: X`** in `标签`. (Grid mode uses it for range; duel mode
   currently ignores positioning, but author it anyway for cross-mode compatibility — a missing value means
   melee/1.)

**Prefer structured effect keys over flavor prose.** The parser keys off the `效果` *key* first
(`命中`/`护盾`/`伤害增幅`/…); only unrecognized keys get their *value prose* scanned (§4.3). Structured keys
are reliable; prose scanning is best-effort. When you can write `"护盾": "50"`, do — not
`"凝护": "每次攻击获得50点护盾"`.

A minimal well-formed skill the AI should emit (this is a runtime `stat_data.技能` entry — Chinese keys):

```jsonc
"烈焰斩": {
  "品质": "史诗",
  "类型": "主动",
  "消耗": "攻击: 30 MP",
  "标签": ["智力", "威力: 140", "有效距离: 1", "范围: 锥形"],
  "效果": { "燃烧": "30+2回合" },
  "描述": "挥出一道烈焰，灼烧锥形范围内的敌人。"
}
```

---

## 4. Field grammar reference (`parseCardItem`) `✅ LIVE`

This is exactly what the live parser
([src/shared/combat/systems/poemD20.ts](../../src/shared/combat/systems/poemD20.ts) `parseCardItem`)
reads off one `技能`/`装备` MVU object. Parsing is **tolerant** (heuristic, pinned by tests), so unknown
extras are ignored, not rejected.

Top-level keys read: `品质` (rarity string), `类型` (`主动` active → a card; `被动` passive → a folded
power, not drawn).

### 4.1 `标签` (string array)

| Tag form | Meaning | Notes |
| --- | --- | --- |
| a bare attribute `力量`/`敏捷`/`体质`/`智力`/`精神` | `关联属性` (scaling + 检定 attribute) | the first one wins |
| `有效距离: X` | range in cells | author it; duel mode ignores positioning today |
| `威力: X` | skill power (the 威力 term) | **must be a literal number** |
| `攻击: N` | equipment weapon attack | aggregated as `武器攻击` |
| `防御: N` | equipment armor defense | aggregated (sum) |
| `范围: 爆发` (`半径: r`) / `直线` / `锥形` | AoE shape (grid mode) | length follows `有效距离` |
| `范围: X` (a number) | pick up to **X** targets (multi-single-target) | duel uses this cap |
| `单体` | single target | |
| `多段: N` / `连击: N` | multi-hit ×N (固伤 applied per hit) | default 2 if unspecified |
| `治疗` (as a 核心功能 tag) | marks a healing ability | 威力 becomes the heal power |
| `群体` (aliases `群`/`全体`/`AOE`) | **duel-mode** target scope: all living enemies (or all living allies, for a 治疗 skill) | sets `目标模式: '群体'`; duel-only, independent of the grid `范围` shape above |
| `随机X` (e.g. `随机3`; bare `随机` → 1) | **duel-mode** target scope: X random hits, with replacement | sets `目标模式: '随机'` + `随机次数: X`; duel-only |

### 4.2 `消耗` (string) — `⚠️ HP PARTIAL`

Form: `"攻击: 50 MP"` or `"动作: 30 SP"`. Parsed into `{ slot, mp?, sp? }`:
- `slot` = `attack` if the string contains `攻击` (default), `action` if it contains `动作`. (In duel mode
  this maps to the card's energy slot; see §5.)
- `mp` / `sp` = the `N MP` / `N SP` amounts, deducted from the owner's pools on play.

> **HP cost (血祭):** the duel resolver **does** deduct `消耗.hp` if present, but `parseCardItem` does
> **not yet** extract an HP amount from the `消耗` string. So an HP-cost card cannot be authored via an MVU
> `技能` string today — it will be authorable through the `deck.cards` / drop-in card def (§9, D6) which set
> `消耗.hp` directly. Until then, do not rely on `... HP` in a `技能` `消耗`.

### 4.3 `效果` (record: key → value string)

Recognized **keys** (the value is a number or `N%`):

| Key (regex) | Field | Multi-source rule |
| --- | --- | --- |
| `命中` | hit bonus | **max** |
| `闪避` | dodge | **max** |
| `先攻` | initiative | **max** |
| `抵抗` (状态抵抗) | status resist | **max** |
| `固伤` / `额外固定` | flat extra damage | **sum** |
| `DR` / `减伤` | damage reduction % | **max** |
| `穿透` | armor penetration % | **max** |
| `暴击倍率` | crit multiplier | set |
| `伤害增幅` / `增伤` | outgoing damage ×(1+%) | **sum** |
| `护盾` | flat shield pool (absorbed before HP) | **sum** |
| `治疗增幅` | outgoing healing ×(1+%) | **sum** |
| `治疗` / `恢复` | flat heal amount (`治疗量`) | **sum** |

**Status-on-hit (附加效果):** any *unrecognized* effect key whose value matches `N+M回合` or `M回合` becomes
an on-hit status `{ 状态: <key>, 数值?: N, 回合: M }`. Example: `"燃烧": "30+2回合"` → applies 燃烧 (value 30)
for 2 rounds. Status lands automatically on a 暴击 (评级 ≥ 1.3); on 有效/勉强 (≥ 0.8) it rolls an opposition;
below that it never lands.

**Flavor-prose scan (best-effort):** if an unrecognized key's value isn't a status, the parser scans the
prose for: `提高X%伤害`→伤害增幅, `提高X%治疗`→治疗增幅, `X点护盾`→护盾, `额外X点伤害`→固伤, `减伤X%`→DR,
`X%穿透`→穿透, `恢复X`→治疗量. Reliable only for these patterns — **prefer structured keys**.

---

## 5. Deck & energy model (`deckBuild`) `✅ LIVE`

How a character's parsed abilities become a draw pile
([src/shared/combat/deckbuilder/deckBuild.ts](../../src/shared/combat/deckbuilder/deckBuild.ts)), governed
by `DeckConfig` (defaults shown; a world will be able to override these via the bundle in D6):

- **Energy:** 3 per turn, refreshed each turn (STS tempo). On top of energy, a card also spends its `消耗`
  (MP/SP/HP) from the finite pools (attrition). Energy gates *how many* cards/turn; pools gate *sustained*
  play.
- **Card energy cost:** basics (`普攻`, `格挡`) cost **1**; skills cost by 品质 —
  `普通/优良 = 1, 精良/史诗 = 2, 传说/神 = 3` (fallback 2).
- **Copies in the deck by 品质:** `普通 ×2, 优良 ×2, 精良 ×1, 史诗 ×1, 传说 ×1, 神 ×1`. Higher rarity = fewer
  but stronger (a 神 card is a rare bomb you might draw once).
- **Basics:** `普攻 ×4` (the 威力-20 Strike, always present) + a synthesized **`格挡` ×4** (the Defend) that
  grants `护盾 = round(maxHp × 0.05)`.
- Passive `技能` become **powers** (folded into resolution, never drawn). Equipment 攻击/防御/检定 mods are
  **aggregated** onto the combatant (relics), not drawn.

**Implication for authors:** rarity is a *deck-shaping* lever, not just power — a `神` skill is powerful but
rare in your hand. Tune `威力`/`品质`/`消耗` together.

---

## 6. How the numbers resolve (`poemStrike`) `✅ LIVE`

So you can balance, here is exactly what a played attack card does
([src/shared/combat/systems/poemStrike.ts](../../src/shared/combat/systems/poemStrike.ts)):

1. **检定:** roll `d20` (advantage if attacker `生命层级` > defender's, disadvantage if lower; if attacker is
   2+ tiers above, defender `闪避` is ignored). `总值 = natural + 命中 − 闪避`.
2. **评级 (rating K):** first threshold met in `[[30, 2.0], [25, 1.6], [20, 1.3], [11, 1.0], [8, 0.8],
   [4, 0.3], [0, 0]]`. K = 0 is a miss.
3. **伤害:** `构成 = 关联属性 × 10 × 层级系数 + 威力 + 武器攻击`; then `× 2000/(有效防御 + 2000)` (有效防御 =
   `防御 × (1 − 穿透%)`); then `× (1 − 属性减免)` (属性减免 = `(体质+力量+敏捷) × 0.0025`, capped 0.9); then
   `× K`; then `+ 固伤 × 多段`; then `× (1 + 伤害增幅%)`; then `× (1 − DR%)`. Finally `护盾` absorbs before HP.
4. **状态:** 附加效果 apply per the auto/opposition rule in §4.3.

**Healing** (a `治疗` card or `治疗量`): `base = 关联属性 × 10 × 层级系数 + 威力 (+ 治疗量)`, `× (1 + 治疗增幅%)`,
no 检定, no mitigation, same-side only.

**The 核心数值表 scale tables** (`derive`, supplied per world) — author your numbers on this scale:

| 生命层级 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 层级系数 (damage) | 2.0 | 2.8 | 4.0 | 8.0 | 15.0 | 35.0 | 80.0 |
| HP 乘数 | 1 | 2 | 4 | 10 | 20 | 40 | 100 |
| MP·SP 乘数 | 1 | 2.5 | 6 | 15 | 35 | 80 | 160 |

Resource derivation (when `生命值上限` etc. aren't already in MVU): `HP = 体质 × 100 × HP乘数 + Σ五维`,
`MP = (智力+精神) × 50 × 乘数`, `SP = (力量+敏捷) × 50 × 乘数`.

---

## 7. Combatant data contract (what the engine needs per entity) `✅ LIVE`

To build any combatant (party member, companion, or enemy), the engine needs:
`name`, `生命层级` (→ tier 1–7) and/or `等级`, `属性{力量,敏捷,体质,智力,精神}`, `装备{slot:{标签[],效果{}}}`,
`技能{name:{类型,消耗,标签[],效果{}}}`, `状态效果{}`. **HP/MP/SP are derived** (§6) — never required.
Party members come from `stat_data` (the player + `关系列表` present companions); enemies come from the
roster (§8).

---

## 8. Enemy / NPC roster on the combat-start cue (A1) `✅ LIVE`

Enemies aren't in `stat_data`, so the AI supplies them as a **JSON roster** in the `<rpt-combat-start>` cue
body; `buildEncounterFromMvu({ roster })` builds each via the same parser, so enemy skills use the **exact
same grammar** as §4. Each entry uses the card's own field names:

```jsonc
<rpt-combat-start map="">
[
  { "名称": "哥布林", "数量": 3, "生命层级": "第一层级", "等级": 4,
    "属性": { "力量": 3, "敏捷": 4, "体质": 3, "智力": 1, "精神": 1 },
    "装备": { "利爪": { "类型": "天生武器", "品质": "普通", "标签": ["攻击: 20"], "效果": {} } },
    "技能": {}, "状态效果": {} },
  { "名称": "头目", "数量": 1, "生命层级": "第二层级", "等级": 8,
    "属性": { "力量": 6, "敏捷": 4, "体质": 6, "智力": 2, "精神": 3 },
    "装备": { "巨斧": { "类型": "巨斧", "品质": "优良", "标签": ["攻击: 70","命中: +1"], "效果": {} } },
    "技能": { "横扫": { "类型": "主动", "消耗": "攻击: 60 SP",
      "标签": ["力量","范围: 锥形","威力: 150","有效距离: 2"], "效果": { "流血": "20+2回合" } } },
    "状态效果": {} }
]
</rpt-combat-start>
```

- `数量` defaults to 1. `阵营: "友方"` (or `side: "party"`) puts an entry on the player's side (an ad-hoc
  ally); otherwise it's an enemy.
- Enemies act on **deterministic telegraphed intents** (the engine picks each one's next move from its
  abilities). Give an enemy more than one skill to vary its telegraph.

---

## 9. Authored duel cards — `deck.cards` + two-file drop-in `🚧 DESIGNED (D6) — not built`

Beyond cards derived from a character's kit, a world will be able to ship **hand-designed cards**. The
definition schema (shared by both delivery forms) is:

```jsonc
{
  "id": "destiny_flare",
  "owner": "主角",                 // which character contributes this card (joins their deck when they lead/support)
  "name": "命运之焰",
  "品质": "传说",
  "art": "命运之焰",               // resolves via window.assetUrl(name, '卡面')
  "cost": { "energy": 2, "mp": 40 },          // energy + pool cost (mp/sp/hp)
  "effect": { "damage": { "威力": 200, "关联属性": "精神" },
              "status": { "燃烧": { "数值": 30, "回合": 2 } } },
  "script": "onPlay",              // OPTIONAL — present only for code-carrying cards (§10)
  "copies": 1
}
```

**Delivery form A — bundle:** entries under `extensions.rp_terminal.combat.deck.cards` in the character
card PNG. Travels with the card.

**Delivery form B — two drop-in files** (the moddable path): a duel card is **two files sharing a base
name**, imported through the **existing World Assets pathway**
([src/main/services/worldAssetService.ts](../../src/main/services/worldAssetService.ts)):
- the **picture** `<cardName>_卡面.<ext>` (an image; new `卡面` asset type), and
- the **definition** `<cardName>.card.json` (the schema above).

Drop both into the world's character `.assets/` folder, or import a zip that bundles them with the
character's portraits. Conflicts overwrite (re-import = update). A picture with no def is just unused art; a
def with no picture renders on the default 品质 frame.

> Not built yet: the asset layer indexes images only today, so the `卡面` type + `*.card.json` ingestion are
> the D6 delta. Don't author drop-in cards expecting them to load until D6 lands.

---

## 10. Scripted cards — the `onPlay` API + sandbox scope `🚧 DESIGNED (D7) — not built`

Most cards are **declarative** (the `effect` schema above, resolved by the engine). For behavior the effect
vocabulary can't express (e.g. "deal damage equal to your discard pile size", conditional combos), a card
may carry a **script** that runs **on play**, in a sandbox limited to the duel.

### Supported script scope (the security contract)

A scripted card's `onPlay` runs in the **main-process quickjs worker sandbox** (the same one combat scripts
use), behind the **per-card permission/trust gate**. It can touch **only**:

- a **read** projection of the duel (pile sizes, energy, round, combatants' HP/护盾/状态), and
- **duel-local variables** — a per-duel scratch namespace (`vars.duel` shared, `vars.card` per-card),
  **ephemeral** (discarded when the duel ends).

It has **NO** access to: MVU `stat_data`, the chat/KV, the app, the filesystem, the network, the DOM, or
other cards' internals. All randomness **must** use the provided **seeded `rng()`** — `Math.random` is
unavailable — so a scripted card keeps the duel reproducible.

### The intended API (subject to change until D7 ships)

```ts
onPlay(ctx: {
  self: CardView;                  // this card instance
  owner: ReadonlyCombatant;        // who played it
  targets: ReadonlyCombatant[];    // chosen targets
  duel: DuelProjection;            // read-only: pile sizes, energy, round, combatants (HP/护盾/状态)
  vars: DuelVars;                  // read/write duel-local scratch: vars.duel[...] + vars.card[...]
  rng(): number;                   // SEEDED, deterministic; Math.random is unavailable
  deal(target, n): void;
  heal(target, n): void;
  gainBlock(target, n): void;      // adds 护盾
  applyStatus(target, id, 数值, 回合): void;
  draw(n): void;
  gainEnergy(n): void;
  exhaust(cardId): void;
}): void
```

**Determinism rule (mandatory):** never read wall-clock time, never use `Math.random`, never branch on
anything outside `ctx`. Same seed + same plays ⇒ same result, always.

---

## 11. General authoring guidelines

- **Balance on the 评级 curve, not on fixed damage.** A card's real output is `构成 × K` where K varies 0–2.0
  with the roll. Quote your `威力` knowing the median 评级 is ~1.0 and a 暴击 is ≥1.3. Big single numbers swing
  hard; multi-hit (`多段`) + `固伤` is steadier.
- **Spend the two axes deliberately.** Energy (3/turn) limits *tempo*; `消耗` (MP/SP) limits *sustain*. A
  cheap-energy / high-MP card is a burst you can't repeat; a low-cost basic is your reliable filler.
- **Rarity shapes the deck, not just power.** Higher 品质 = fewer copies. Make a `传说`/`神` card a
  build-around payoff, not a card you expect every turn.
- **Prefer structured `效果` keys over flavor prose** (§4.3) — prose scanning is best-effort.
- **Author `威力` as a literal number and `有效距离` on actives** (§3) — the two degradation traps.
- **Declarative first, script only when needed** (§10). A scripted card is untrusted code behind a trust
  gate; reserve it for effects the vocabulary genuinely can't express, and keep it deterministic.
- **Art naming:** card pictures are `<cardName>_卡面.<ext>`; match the def's base name exactly (§9). Portraits
  remain `<name>_头像` / `<name>_立绘`.
- **`owner` matters:** an authored card joins the deck only when its `owner` character is the lead or a
  support contributor (§9). Name the owner exactly as the character appears in `stat_data` (`主角`, a
  `关系列表` key, or a roster `名称`).
- **i18n:** card-facing display text is the card's own content (it carries its own locale); RP Terminal app
  UI strings are localized separately via `t()` — don't expect the app to translate your card text.

---

## 12. Worked examples (authoring `技能` today, §1 path) `✅ LIVE`

```jsonc
// A reliable mid-rarity attack — INT scaling, MP cost, a burning DoT.
"烈焰斩": { "品质": "史诗", "类型": "主动", "消耗": "攻击: 30 MP",
  "标签": ["智力", "威力: 140", "有效距离: 1", "范围: 锥形"], "效果": { "燃烧": "30+2回合" } }

// A multi-hit physical striker — STR scaling, SP cost, flat extra per hit.
"乱舞": { "品质": "优良", "类型": "主动", "消耗": "攻击: 40 SP",
  "标签": ["力量", "威力: 60", "有效距离: 1", "连击: 3"], "效果": { "固伤": "10" } }

// A heal — 治疗 core function, 精神 scaling, amplified.
"回春术": { "品质": "精良", "类型": "主动", "消耗": "动作: 50 MP",
  "标签": ["精神", "威力: 120", "治疗", "有效距离: 4"], "效果": { "治疗增幅": "30%" } }

// A passive power — folded in, never drawn (aggregates onto the combatant).
"锋锐": { "品质": "优良", "类型": "被动", "标签": [], "效果": { "伤害增幅": "12%" } }

// A 群体 (AOE) nuke — INT scaling, hits all living enemies.
"星陨": { "品质": "史诗", "类型": "主动", "消耗": "动作: 60 MP",
  "标签": ["智力", "威力: 90", "有效距离: 4", "群体"], "效果": {} }

// A 随机3 striker — DEX scaling, three random hits (with replacement) among enemies.
"乱刃连闪": { "品质": "精良", "类型": "主动", "消耗": "攻击: 35 SP",
  "标签": ["敏捷", "威力: 40", "有效距离: 1", "随机3"], "效果": {} }
```

> A 血祭 (HP-cost) example is intentionally omitted — HP cost isn't authorable via a `技能` `消耗` string yet
> (§4.2). It will be authorable through `deck.cards` / a drop-in def (§9, D6).

The AI authors these the same way as any other 技能: an `<UpdateVariable>` block whose `<JSONPatch>` `insert`s
the new skill object at `/主角/技能/<名>` (e.g. `/主角/技能/星陨`), with `群体` or `随机X` included in the
`标签` array exactly as above — no separate authoring path for scope tags.

---

## 13. Quick reference & related docs

- Live engine: `src/shared/combat/deckbuilder/` (`deckTypes`, `deckBuild`, `deckResolve`, `intents`,
  `deckEngine`, `index`) + `src/shared/combat/systems/poemStrike.ts` (resolution) + `poemD20.ts`
  (`parseCardItem`, `buildCombatant`).
- Design spec (D1–D8):
  [docs/superpowers/specs/2026-06-30-poem-sts-card-duel-design.md](../superpowers/specs/2026-06-30-poem-sts-card-duel-design.md).
- Lorebook/preset authoring aids: [examples/poem-item-combat-compat.md](examples/poem-item-combat-compat.md),
  [examples/poem-preset-combat-instructions.md](examples/poem-preset-combat-instructions.md).
- The recovered card protocol this engine implements:
  [docs/combat-poem-of-destiny-expansion.md](../combat-poem-of-destiny-expansion.md).

> **Maintainers:** when D6 (card import) or D7 (scripts) land, flip their status tags here from 🚧 to ✅ and
> remove the "not built" caveats — and per `CLAUDE.md`, update this guide in the SAME change that touches the
> card-facing surface (`deck.cards` schema, the `卡面` asset type, the `onPlay` API).
```
