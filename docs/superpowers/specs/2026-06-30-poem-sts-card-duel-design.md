# 命定之诗 — 卡牌对决 (Slay-the-Spire duel mode) — Design

Status: **Design in progress (2026-06-30).** A **second native combat mode** for RP Terminal: a
single-encounter Slay-the-Spire deckbuilder, sitting beside the existing grid combat
([combat-system-design.md](../../combat-system-design.md)) as a peer game engine. The app provides the
**native STS engine + board view**; the card supplies the **ruleset** (via the existing resolver seam)
and the **UI theme** (skin). 命定之诗 is the first and (for that card) **only** combat system — it ships
the duel bundle + ruleset + theme and does **not** ship the grid bundle.

Motivating decision (owner, 2026-06-30): *"This will be the card's only combat system. Design it so the
app gives native support for the STS game, with custom ruleset from the card and theme for the UI."* This
revises an earlier framing (a self-contained card plugin) — the engine is **native**, mirroring the
tiered model the grid combat already uses (native core + card-override seam + card skin;
[combat-system-design.md](../../combat-system-design.md) §2, §5).

---

## 0. Locked decisions (owner Q&A, 2026-06-30)

1. **Single-encounter duel.** A combat-scene resolver, no roguelike climb / node-map / meta-progression.
2. **命定之诗 `<战斗协议>` math underneath.** The deckbuilder is the *presentation + turn structure*; the
   numbers are the card's own protocol (检定→评级→伤害→护盾→状态, 防御/DR, MP/SP). The card owns the
   ruleset; the app ships **no generic default deckbuilder ruleset** yet (the seam is built so one can slot
   in later when a second world wants STS).
3. **Literal draw pile (true STS).** Draw / hand / discard / reshuffle / exhaust. The deck is **built from
   the character's kit** (build = deck), copies by 品质 — not a hand-picked loadout (that's deferred).
4. **Dual-axis economy.** **Energy = 3/turn, refreshed STS-style** (per-turn tempo). **On top**, each card
   carries an **HP/MP/SP cost** from the finite pools (the card's 消耗, extended to allow HP) — the
   attrition + risk layer. Energy gates *how many* cards/turn; pools gate *sustained affordability*.
5. **评级 rolls per attack card.** Because the protocol sits underneath, an attack card runs the real
   `<战斗协议>` strike (a 评级 ×0–2.0 roll), so damage is a *range*, not a fixed STS value (a dice-deckbuilder
   texture). Kept deliberately; the card UI shows the 评级 odds.
6. **Block = 护盾**; statuses = 状态效果/附加效果 (层数+回合); powers = 被动技能; relics = 装备 (today
   aggregated by `buildCombatant` into `ext.equip`) + 登神长阶 权能/法则 (a **new** relic source to parse);
   potions = 道具. Most reuse the card's existing grammar already parsed by
   [poemD20.ts](../../../src/shared/combat/systems/poemD20.ts) `parseCardItem`; 登神长阶 is the one addition.
7. **Party = lead + support.** The **lead** (one party member) hand-plays the shared deck; ≤3 companions
   are **semi-autonomous** (own telegraphed intents, soak/redirect as the front line, occasional triggerable
   support cards). Only the lead's deck is hand-played. Lead-swap mid-fight = optional later toggle.
8. **Enemies & companions run on plugin-derived deterministic intent patterns** (telegraphed STS-style).
   **Mode ① (built first).** An **agent-driven enemy** mode (③) and **per-turn AI narration** (②) both
   depend on the not-yet-built agentic capability → **deferred, recorded**. v1 narrates at the **bookends**
   (scene at start, result at end).
9. **Forgiving stakes — "down, not dead."** 0 HP = downed (out for the duel), not killed. Lead down →
   auto-swap to a living member; party wipe = an AI-narrated defeat/capture/retreat. Survivors fold back at
   low HP + an injury 状态. The minigame never permakills a story character on its own. (A per-fight 生死战
   flag is a deferred escalation.)
10. **Hybrid fold-back.** The engine writes the hard resources (HP/MP/SP/状态) directly to the allowed MVU
    fields; the AI narrates + handles soft consequences (loot, injury flavor, story beats) through its
    normal fold.
11. **Authored signature duel cards (2026-06-30 addition).** Beyond the kit→deck derivation, characters can
    carry **hand-authored duel cards** (defined in the card's bundle/lorebook): each with **art** (a card
    picture), a **declarative effect**, and an **optional script** that runs **on play**, sandboxed to the
    **duel state + duel-local variables only** (no MVU/app/fs/network), using the **seeded RNG**. A
    character's signature cards join the deck when that character is the lead or a support contributor.
    Granting/drafting authored cards *mid-duel* is **deferred** (it overlaps the 命运点数 fate-card draft).

---

## 1. Where this sits — reuse, don't reinvent

This is a **new front-end + turn engine over the existing combat substrate**, not a greenfield system.

| Need | Reused from the grid combat | File |
| --- | --- | --- |
| Card-ruleset seam (the "custom ruleset from the card") | `CombatSystem` (`parseItem`/`buildCombatant`/`resolveAction`) + `ResolverContext` | [bundle.ts:243](../../../src/shared/combat/bundle.ts) |
| The 命定之诗 ruleset itself | `poemD20System` — `parseCardItem` (kit→combat numbers), `buildCombatant` (五维+resources+kit), the strike math `poemHitOne`/`poemHealOne` | [poemD20.ts](../../../src/shared/combat/systems/poemD20.ts) |
| Party + enemy build from MVU + the A1 roster channel | `buildEncounterFromMvu({ roster })` (主角 + 关系列表 + AI roster) | [bundle.ts:280](../../../src/shared/combat/bundle.ts) |
| Combatant + stat block + `ext` bag + conditions + events | `Combatant` / `StatBlock` / `Condition` / `CombatEvent` | [types.ts](../../../src/shared/combat/types.ts) |
| Seeded determinism + resume | `makeRng`, `(seed, rngCursor)` pattern | [dice.ts](../../../src/shared/combat/dice.ts), [engine.ts:35](../../../src/shared/combat/engine.ts) |
| Native view registration | the `combat` view registry entry → a peer `duel` entry | [viewRegistry.tsx:72](../../../src/renderer/src/components/workspace/viewRegistry.tsx) |
| Ephemeral per-chat encounter persistence + lifecycle (re-roll/swipe clear, quit, no-viable-party guard) | `combat_encounters` + `combatService` | [combatService.ts](../../../src/main/services/combatService.ts), [db.ts](../../../src/main/services/db.ts) |
| AI touchpoints (combat-start cue, bookend narration, MVU fold-back) | the combat generation pipeline | [combatService.ts](../../../src/main/services/combatService.ts), [mvuParser.ts](../../../src/main/parsers/mvuParser.ts) |
| Card art + drop-in/zip card import | the World Assets layer (`assetUrl`/`rptasset://`, `importAssetsZip`, the `.assets/` folder convention) — **extended** for a `卡面` image type + `*.card.json` def-sidecar ingestion (§6.1) | [worldAssetService.ts](../../../src/main/services/worldAssetService.ts) |

The genuinely new work: the **`DuelState` model** (piles/energy/intents on top of combatants), the
**deck-construction rule** (kit→draw pile), the **deck turn engine** (draw/play/discard/exhaust + the
lead+support+enemy intent round), a **grid-free strike path** (refactor `poemHitOne`/`poemHealOne` so the
deck resolver reuses them without grid/LoS targeting), the **native `DuelView`** board, and the
**deckbuilder bundle config + skin contract**.

---

## 2. STATE / LOGIC / VIEW (inherited principle)

Same separation as the grid combat ([combat-system-design.md](../../combat-system-design.md) §2), which is
what lets a native engine and AI narration coexist over one world.

- **STATE — `DuelState`** (§3): the ephemeral per-encounter blob (combatants + piles + energy + intents +
  turn), seeded + resumable, persisted per chat. Distinct from the persistent `stat_data`.
- **LOGIC — the native deck engine** (§5) in `src/shared/combat/deckbuilder` (pure). Owns draw/energy/turn
  flow + intents; defers every *number* to the card ruleset through the `CombatSystem.resolveAction` seam.
- **VIEW — a native `DuelView`** (§7), a panel view in `viewRegistry`. **Not a card WCV** — the board is
  the native game-engine target; the card supplies content + skin, never the renderer.

---

## 3. `DuelState` (the new model)

A new pure model alongside `CombatState`, reusing its primitives. Sketch (final field names firm up in the
plan):

```ts
interface DuelState {
  seed: number
  rngCursor: number              // (seed, rngCursor) → reproducible + resumable, as CombatState
  combatants: Combatant[]        // reused; pos/grid unused (targeting is by id, not cell)
  lead: string                   // the party member id whose deck is hand-played
  energy: { current: number; max: number }   // 3/3, refreshed each lead turn
  piles: { draw: CardId[]; hand: CardId[]; discard: CardId[]; exhaust: CardId[] }
  cards: Record<CardId, CardInstance>         // the built deck (see §4)
  intents: Record<string, Intent>             // per non-lead combatant (companions + enemies)
  turn: 'lead' | 'allies' | 'enemies'
  round: number
  status: 'active' | 'party' | 'enemy'
  log: CombatEvent[]             // reused event shape (attack/damage/heal/condition/death/turn/info)
  vars: { duel: Record<string, unknown>; card: Record<CardId, Record<string, unknown>> }  // §6.1 duel-scoped scratch for sandboxed card scripts; ephemeral
}

interface CardInstance { id: CardId; abilityId: string; owner: string; energyCost: number; exhaust?: boolean; script?: boolean }
interface Intent { kind: 'attack' | 'block' | 'buff' | 'heal'; abilityId?: string; target?: string; preview?: number }
```

- **MP/SP/护盾** live in `Combatant.ext` exactly as `buildCombatant` writes them today
  ([poemD20.ts](../../../src/shared/combat/systems/poemD20.ts): `ext.mp/maxMp/sp/maxSp/shield`).
- **Down-not-dead**: a downed combatant stays in `combatants` (HP 0) but is skipped by intents/targeting;
  `checkVictory` is "any party member alive" vs "any enemy alive" (mirrors
  [engine.ts:41](../../../src/shared/combat/engine.ts)).

---

## 4. Deck construction — the kit → draw pile rule

The deck is assembled **deterministically at duel start** (seeded shuffle), from the lead's sheet + support
contributions. Source data is whatever `buildCombatant` already parses; this layer only decides *how many
of each card* and what's a card vs a passive.

| 命定之诗 source | becomes | copies |
| --- | --- | --- |
| 普攻 (auto-added by `buildCombatant`, 威力 20) | 攻击牌 ("Strike") | N (config, e.g. 4) |
| a native **格挡** basic (grants 护盾) — **new** | 防御牌 ("Defend") | M (config, e.g. 4) |
| active 技能 | skill cards | by 品质, from a `deck.copies` table (e.g. 普通 2 · 优良 2 · 精良 1 · 史诗 1 · 传说/神 1 signature) |
| 被动 技能 | **powers** (folded into resolution — already `ext.passives`) | not drawn |
| 装备 | **relics** (already aggregated into `ext.equip`/mods) | not drawn |
| 登神长阶 权能·法则 | **relics** (new source — not parsed today) | not drawn |
| 道具 (consumables) | **potions** (off-deck belt, `数量` = charges) | not drawn |
| companion top 技能 (≤2 each) | **support cards** (shuffled into the shared deck or a support tray) | config |
| **authored signature cards** (bundle `deck.cards` **or** drop-in card files — §6.1) | **designed cards** (art + declarative effect + optional on-play script) | as authored (default 1 each) |

- **Energy cost per card** is assigned from 品质 / a `deck.energy` table (basics = 1). The **resource cost**
  is the card's parsed `消耗` (MP/SP, extended to HP — see §6). A card is playable iff `energy ≥ energyCost`
  **and** the owner's pools cover the resource cost.
- Thin-deck mitigation (a 1-skill early character): basics + gear-relics carry the floor; the copy table is
  tunable per world.
- **Authored signature cards** (§6.1) are layered on *after* the derived deck: a character's authored cards
  (by `owner`, from the bundle **or** the drop-in card catalog) are added when that character is the
  lead or a support contributor. They augment — never replace — the build=deck derivation.

---

## 5. The deck turn engine (LOGIC)

Pure module `src/shared/combat/deckbuilder/deckEngine.ts`. Mirrors the determinism discipline of
[engine.ts](../../../src/shared/combat/engine.ts) (clone-then-mutate, `seedFor(state)`, `rngCursor++`).

- **`startDuel(built)`** — build the deck (§4), seed + shuffle draw pile, telegraph round-1 intents, draw
  the lead's opening hand. Initiative/round structure: a round = **lead phase → allies phase → enemies
  phase** (simpler than per-combatant initiative; the lead+support model doesn't need interleaving).
- **`drawHand(state)`** — draw to hand size (config, ≈5); reshuffle discard→draw (seeded) when the draw pile
  empties.
- **`playCard(state, cardId, targetIds)`** — gate on energy + pools; deduct both; resolve the card via the
  **card ruleset** (the `resolveAction` seam, §5.1); move the card to discard (or exhaust if one-shot);
  recompute 护盾/statuses/victory.
- **`endLeadTurn(state)`** — discard the hand; run **allies phase** (each companion resolves its telegraphed
  intent through the ruleset), then **enemies phase**; tick statuses + decay defend-护盾; **re-telegraph**
  next intents; refresh energy to max; draw a new hand. (Pools do **not** regen — they're the attrition
  axis; energy is the per-turn reset.)
- **Intents** (`deckbuilder/intents.ts`) — a deterministic policy picks each non-lead combatant's next
  action from its abilities (cyclic/weighted, mirroring [policy.ts](../../../src/shared/combat/policy.ts));
  the telegraph `preview` is the 评级-expected damage / 护盾 / status. This is the readable-pattern core of
  STS and the seam where **mode ③ (agent enemy)** later substitutes the agent.

### 5.1 Reusing the card ruleset (the "custom ruleset from the card")

The card's resolution math is **already** `poemD20System.resolveAction`
([poemD20.ts](../../../src/shared/combat/systems/poemD20.ts)). Its inner strike functions
`poemHitOne`/`poemHealOne` are **grid-independent** (they take actor/target/ability and run
检定→评级→伤害→护盾→状态); only the outer `poemResolveAction` does grid targeting (`distance`, `lineOfSight`,
`templateCells`). The refactor: **extract `poemHitOne`/`poemHealOne`** so both resolvers call them, and add
a **deck resolver** that targets by explicit id (no grid/LoS/AoE-template) and applies multi-target by the
card's `范围目标` count. One module per change: extract behind the shared functions first (grid tests stay
green), then add the deck resolver.

Same `ResolverContext` shape (`state` is cloned, `rng` seeded, `derive` tables passed). The seam stays the
documented SDK surface; a future generic default ruleset slots in here.

---

## 6. The card bundle + skin (the card-facing contract)

Extend the existing `combat` bundle ([bundle.ts:92](../../../src/shared/combat/bundle.ts),
`CombatBundleSchema` in [character.ts](../../../src/main/types/character.ts)) with a **mode discriminator**
+ a deckbuilder config, reusing `skin`/`stat_map`/`derive`/`scripts` unchanged:

```jsonc
"combat": {
  "mode": "deckbuilder",                 // NEW: 'grid' (default) | 'deckbuilder'
  "ruleset": "poem",                     // the CombatSystem id (poemD20System)
  "stat_map": { "...": "..." },          // reused — party from 主角 + 关系列表 (already authored)
  "derive":   { "...": "..." },          // reused — the 核心数值表 tables
  "deck": {                              // NEW: deck-construction + economy config
    "hand_size": 5,
    "energy": 3,
    "basics": { "普攻": 4, "格挡": 4 },
    "copies": { "普通": 2, "优良": 2, "精良": 1, "史诗": 1, "传说": 1, "神": 1 },
    "support_cards": 2                    // top 技能 per companion mixed into the shared deck
  },
  "skin": {                              // theme — the card supplies art + tokens, never the renderer
    "card_frames": { "普通": "...", "史诗": "..." },   // per-品质 frame art
    "backdrop": "...", "portraits": "by-assetUrl",     // board bg; portraits via window.assetUrl(name,'头像')
    "icons": {}, "css_tokens": { "--rpt-...": "..." }
  }
}
```

**Cost-grammar delta (HP cost):** the card's `消耗` grammar is `攻击/动作: X MP/SP` today; allow an HP cost
(`消耗: 攻击: 10% HP` / a 反噬 effect) → `parseCardItem` and the resolver deduct it. Small parser +
lorebook-authoring change (the 血祭 archetype).

**Skin contract:** the native `DuelView` reads `skin.*` for card-frame art (by 品质), board backdrop,
portrait frames (portraits resolved via `window.assetUrl` by name — the World Assets layer), ability icons,
and `--rpt-*` CSS tokens; a built-in default theme applies when a slot is absent. App UI strings route
through `t()` (en/zh) per the i18n rule in `CLAUDE.md`.

### 6.1 Authored duel cards (catalog + scripted effects)

Beyond the derived kit-cards (§4), `deck.cards` is a catalog of **hand-authored cards** attached to
characters. A card lists its `owner` (a character id/ref); the owner's signature cards join the deck when
that character is the lead or a support contributor.

```jsonc
"deck": {
  "cards": [
    { "id": "destiny_flare", "owner": "主角", "name": "命运之焰", "品质": "传说",
      "art": "命运之焰",                          // → window.assetUrl('命运之焰','卡面')
      "cost": { "energy": 2, "mp": 40 },
      "effect": { "damage": { "威力": 200, "关联属性": "精神", "范围": "单体" },
                  "status": { "燃烧": { "数值": 30, "回合": 2 } } },
      "copies": 1 },
    { "id": "fate_gambit", "owner": "主角", "name": "孤注一掷", "品质": "史诗",
      "art": "孤注一掷", "cost": { "energy": 1 },
      "script": "onPlay" }                        // declarative `effect` omitted → the script does it all
  ]
}
```

- **Declarative `effect`** reuses the engine's effect vocabulary (伤害 via 威力/关联属性, 护盾, 状态, draw,
  energy) — parsed like `parseCardItem`, resolved by the same `poemHitOne`/heal path. Covers most cards with
  no code.
- **`script` (optional escape hatch)** — for a card whose behavior the vocabulary can't express; runs a
  sandboxed function **on play**, receiving a **duel-scoped context** and emitting the same `CombatEvent[]`
  the engine logs:

  ```ts
  onPlay(ctx: {
    self: CardView; owner: ReadonlyCombatant; targets: ReadonlyCombatant[];
    duel: DuelProjection;            // pile sizes, energy, round, combatants (read-only), 护盾/状态
    vars: DuelVars;                  // duel-local scratch: vars.duel[...] + vars.card[...] (read/write)
    rng(): number;                   // SEEDED — deterministic; Math.random is unavailable
    deal(t, n): void; heal(t, n): void; gainBlock(t, n): void;
    applyStatus(t, id, 数值, 回合): void; draw(n): void; gainEnergy(n): void; exhaust(cardId): void;
  }): void
  ```

- **Sandbox & determinism:** the script runs in the **existing combat-scripts quickjs worker sandbox**
  (main-process; the pure engine never imports it — `combatService` injects a runner per
  [hooks.ts](../../../src/shared/combat/hooks.ts) / [combat-system-design.md](../../combat-system-design.md)
  §13). It reads a projection of `DuelState` and reads/writes **duel variables** only — **no** MVU
  `stat_data`, app, filesystem, or network. All randomness is the **seeded RNG**, so a scripted card keeps
  the duel reproducible. Untrusted (card-authored) → behind the per-card permission model. `playCard` is
  **async** when a card carries a script (mirrors the async `applyAction` override path,
  [engine.ts:118](../../../src/shared/combat/engine.ts)).
- **`vars` (the duel game variables):** a per-duel scratch namespace on `DuelState.vars` — `vars.duel`
  (duel-global, e.g. a combo counter) and `vars.card` (per-card-instance) — **ephemeral**, discarded with the
  duel. Distinct from MVU `stat_data` and the per-chat card KV.
- **Trigger scope (v1):** **on play** only (the stated need). on-draw / on-turn-start / persistent
  power·relic scripts are a later extension.
- **Art:** `card.art` resolves through the World Assets layer (`window.assetUrl(name, '卡面')` / `rptasset://`),
  the same mechanism as portraits; a default 品质 frame renders when art is absent.

#### Delivery — two forms, one card schema

A duel card's definition (`id/name/品质/owner/cost/effect/script`) can arrive two ways; both feed the same
per-world **duel-card catalog** the deck builder reads, matched to characters by `owner`:

1. **Bundle-authored** — `deck.cards` embedded in the character card PNG (above). Travels with the card.
2. **Drop-in card (two files)** — a duel card is delivered as **two files that share a base name**: the
   **picture** (`<cardName>_卡面.<ext>`, an image) and a **definition sidecar** (`<cardName>.card.json` —
   `id/name/品质/owner/cost/effect/script`). The player adds cards through the **existing World Assets import
   pathway** ([worldAssetService.ts](../../../src/main/services/worldAssetService.ts)): **drop both files into
   the world's assets folder** **or import a zip** (the same `.assets/`-mirroring zip that already carries the
   character's portraits — it now also carries the duel cards' picture + def). Conflicts overwrite (re-import
   = update). The picture is resolved by `assetUrl(cardName, '卡面')`; the sidecar feeds the catalog.

**App/SDK delta (the generic, reusable part):** the picture is just a new image type, which the existing
image-only asset layer handles once registered; the **definition sidecar** is the genuinely new bit. Drop-in
cards add: (a) a **`卡面` image type** (+ its category — co-located under `character/`, or a dedicated `card/`
category); (b) the importer **ingests the `*.card.json` sidecars** into the per-world **duel-card catalog**
(today `importAssetsZip` / `buildIndex` accept convention-named **images only** and would skip a def file —
this extends them to also accept the def sidecar); (c) `assetUrlForWorld` (which hardcodes the `character`
category today, [worldAssetService.ts:166](../../../src/main/services/worldAssetService.ts)) handles the card
category. Documented in `docs/sdk/`. (A picture with no def sidecar is just unused art; a def with no picture
renders on the default 品质 frame — neither crashes.)

**Trust:** a drop-in **scripted** card's def sidecar carries executable (sandboxed) content arriving by
file-drop (lower friction than repacking a card). Its `onPlay` script still runs only in the duel sandbox
(duel-scoped, seeded, no MVU/app/fs/network), and drop-in scripted cards honor the **per-card permission/trust
gate** — the same posture as bundled card scripts.

---

## 7. The native `DuelView` (VIEW)

A new **`duel`** view in [viewRegistry.tsx](../../../src/renderer/src/components/workspace/viewRegistry.tsx)
(a peer of `combat`), driven by `DuelState`. Regions (per the approved mockup
`poem_of_destiny_sts_duel_board`):

- **Enemy zone** (top) — each enemy/companion shows its **telegraphed intent** (icon + preview value), HP
  bar, 护盾, status pips.
- **Party rail** (left) — up to **4 portrait frames** (the lead ringed + 行动中); portrait art drops in via
  `window.assetUrl(name,'头像')`; members can be individually downed.
- **Resource cluster** — the **energy orb** (3/3, per-turn) + the lead's **法力/体力 (MP/SP)** pool bars.
- **Hand** (bottom) — fanned cards: cost gem (energy), 品质-colored frame, art (skin icon), name/type, effect
  text, the **HP/MP/SP cost line**, and the **评级 odds** on attack cards. Hover-raise + the draw/discard
  piles + 结束回合 button.

Animation: card hover-raise, deal/draw slide, HP/护盾 tweens, floating damage/heal numbers, intent bob —
all CSS/transform (no heavy deps), paced so auto-acted ally/enemy turns are visible (mirrors the grid
`CombatView` follow-up). Card art comes from the skin; **no 2D/3D character models** — portrait frames are
the only character imagery.

---

## 8. AI touchpoints (reuse the combat pipeline; cache-safe)

- **Entry — lorebook-driven.** `<战斗启动协议>` presents the top-level pick; selecting **卡牌对决** makes the
  AI emit `<rpt-combat-start>` + the **A1 JSON enemy roster** and pause. `<战斗协议>` is **gated** so it only
  resolves in chat for the AI-decided path; entering the duel keeps the AI out until hand-back. The app
  parses the cue → `buildEncounterFromMvu({ roster })` (reused) → `startDuel`.
- **Bookend narration.** On duel end, the recorded log → a narration prompt → AI prose into the chat
  (append / new floor per `settings.combat.narrationMode` or the card's setting) — reuse
  `buildNarrationPrompt`.
- **Hybrid fold-back.** The engine writes HP/MP/SP/状态 (downed → injury 状态, 存活 preserved) directly to the
  allowed MVU fields; the AI narration carries the soft consequences (loot, injury flavor, story) as its
  `<UpdateVariable>`/`<JSONPatch>` fold — the card's single MVU write-path.
- **Cache discipline.** Every AI touchpoint **appends at L4**; the duel is seeded so a replay reproduces it
  (same constraint as the grid combat, [combat-system-design.md](../../combat-system-design.md) §11).

---

## 9. Lifecycle, determinism, persistence

- **Persisted** as one JSON blob per chat. Decision: a new `duel_encounters` table vs `combat_encounters`
  with a `mode` discriminator (lean: reuse `combat_encounters` + a `mode` field if the row shape stays
  compatible; else a sibling table). Either way, reuse `combatService`'s lifecycle.
- **Seeded + resumable** after an app restart via `(seed, rngCursor)`.
- **Cleared on re-roll/swipe** of the originating message (reuse `clearEncounter`); an always-available
  **Quit** button ends the duel → chat; a **no-viable-party guard** (all party `maxHp 0`) shows a clear
  message instead of an instant loss.

---

## 10. Module boundaries, clean-room, SDK obligation

- **Boundaries** (`npm run check:deps`): the deck engine is **pure** (`src/shared/combat/deckbuilder`, no
  renderer/electron/ipc); the `DuelView` is renderer; persistence + the sandboxed card-script runner are
  main. `shared/combat` stays the single source of the model. Crossing a boundary = a deliberate
  dependency-cruiser change in the same PR.
- **Clean-room**: native engine, no js-slash-runner/TavernHelper code; the MVU fold reuses the existing
  clean-room `mvuParser`. Card `scripts` (resolver overrides) **and per-card duel-card scripts** (§6.1) run
  only in the main-process quickjs worker sandbox behind the per-card permission model — **duel-scoped** (no
  MVU/app/fs/network), **seeded RNG only**, so determinism + reproducibility hold no matter who authored them.
- **SDK docs (required, same change as the implementation):** the `combat.mode:'deckbuilder'` + `deck` +
  skin surface **and** the new `卡面` image type + `*.card.json` def-sidecar import pathway (§6.1) are
  card-facing, so update `docs/sdk/component-inventory.md` (§ combat/format + the asset categories) and
  `docs/rpt-api.md` per [sdk/README.md](../../sdk/README.md). This **design** doc does not edit `docs/sdk/`
  (nothing built yet).

---

## 11. Phased build order (each slice shippable; one module per change)

| Phase | Deliverable | Reuses |
| --- | --- | --- |
| **D1 — model + engine core** | `DuelState`; deck engine (draw/play/discard/exhaust/energy/turn) headless, seeded, unit-tested. | `dice`, `types`, `engine` patterns |
| **D2 — deck + card ruleset** | the kit→deck construction rule; **extract `poemHitOne`/`poemHealOne`**; the grid-free **deck resolver**; build party + A1 roster by reusing `buildEncounterFromMvu` (ignoring its grid/pos output). | `poemD20`, `buildEncounterFromMvu` |
| **D3 — intents + stakes** | deterministic companion/enemy intent policy + telegraph; down-not-dead + lead auto-swap + victory. | `policy` |
| **D4 — native `DuelView`** | the board (mockup), skin contract, `viewRegistry` `duel` entry, persistence + lifecycle (quit / clear-on-swipe / guard). | `viewRegistry`, `combatService`, World Assets `assetUrl` |
| **D5 — AI touchpoints** | the 卡牌对决 entry option + A1 roster wiring + bookend narration + hybrid MVU fold-back. | `combatService`, `mvuParser`, narration path |
| **D6 — bundle + authored cards (declarative) + import pathway** | `combat.mode`/`deck`/skin schema; the `deck.cards` catalog (art + declarative effect, §6.1); the **drop-in card import** (`卡面` image type + `*.card.json` def-sidecar ingestion into the per-world catalog, extending `worldAssetService`); author 命定之诗's deck config, ruleset binding, theme, signature cards. **+ update `docs/sdk/`.** | World-Card importer, World Assets |
| **D7 — scripted duel cards** | the per-card on-play **script sandbox** (§6.1): the duel-scoped API + duel variables + seeded determinism + per-card permission gating; reuse the combat-scripts sandbox runner. | `hooks`, the combat sandbox (`combatService`) |
| **D8 — deferred depth** | agent enemies (③), per-turn narration (②), loadout/draft + 命运点数 fate-cards (+ granting/drafting authored cards mid-duel), lead-swap, typed-damage split, on-draw/power script triggers, 生死战 flag. | D1–D7 |

**Recommended first milestone: D1 + D2 + D3 headless** — a fully testable deterministic deckbuilder with no
UI — then **D4** makes it playable.

---

## 12. Open questions (resolve as the plan firms up)

1. **Bundle shape** — `combat.mode` discriminator on the existing bundle (lean) vs a separate `duel` slot.
2. **Persistence** — reuse `combat_encounters` + a `mode` field vs a new `duel_encounters` table.
3. **Round structure** — lead → allies → enemies phases (lean) vs per-combatant 敏捷-initiative interleave.
4. **Deck copy-count + energy-cost tables** — defaults that make a thin early-game deck fun without making a
   late-game deck bloated.
5. **HP-cost `消耗` grammar** — exact syntax (`X% HP` vs flat) + the 反噬 effect path; the parser + lorebook
   authoring change.
6. **Support-card delivery** — companion cards shuffled into the shared draw pile vs a separate triggerable
   support tray.
7. **Lead selection** — lead = 主角 by default vs chosen at entry; lead-swap (deferred) UI.
8. **Fold-back scope** — only 主角/companion consequences, or also enemy deaths/loot.
9. **Duel-card script API** (§6.1) — the exact helper surface + what `DuelProjection`/`vars` expose to
   sandboxed scripts; trigger points (on-play in v1; on-draw / persistent power scripts later).
10. **Card art source** — `window.assetUrl` by name (`卡面`) vs an embedded asset id in the card's appended
    zip; the default-frame fallback.
11. **Authored-card ownership** — how a card attaches to a character (`owner` ref) and how an owner's
    signature cards behave when that character is a support contributor vs the lead.
12. **Two-file naming/matching** — the picture (`<cardName>_卡面.<ext>`) + def sidecar (`<cardName>.card.json`)
    convention and how the importer pairs them by base name; the def-sidecar schema.
13. **Card asset placement** — both files co-located under the `character/` category vs a dedicated `card/`
    category for cards.
14. **Drop-in scripted-card trust gate** — the permission prompt/flow for a scripted card arriving by
    file-drop vs one bundled in the character PNG.

---

## 13. Related

- App grid combat: [combat-system-design.md](../../combat-system-design.md) +
  [plans/2026-06-25-combat-system.md](../plans/2026-06-25-combat-system.md).
- The 命定之诗 combat protocol + ruleset recovery (the math this reuses):
  [combat-poem-of-destiny-expansion.md](../../combat-poem-of-destiny-expansion.md).
- The card-plugin surface this design *moved away from* (panel + `type:'chat'` KV), still the pattern for
  non-combat card UI: [2026-06-27-poem-party-panel-v2-design.md](2026-06-27-poem-party-panel-v2-design.md).
- World Assets `window.assetUrl` (portrait art): the World Assets plan.
