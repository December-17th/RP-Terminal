# 命定之诗 Combat Extension — Implementation Plan (2026-06-25)

**Design / spec:** [docs/combat-poem-of-destiny-expansion.md](../../combat-poem-of-destiny-expansion.md)
(field spec, stat_map/derive, modes — **signed off 2026-06-25**).
**Builds on:** the app combat engine from [2026-06-25-combat-system.md](2026-06-25-combat-system.md)
(branch `feat/combat-system`, P1–P8, all green).

> **STATUS (2026-06-26): card-side extension complete; in-app validation + a couple app affordances remain. 109 combat tests green.**
> Shipped on branch `feat/poem-combat-extension`: BP1 (bundle `stat_map`/`derive` + `ext` bag),
> BP2 (`parseCardItem` + `buildEncounterFromMvu` + `poemD20` buildCombatant), BP3 (the `<战斗协议>`
> resolver on the `resolveAction` seam), BP4-core (the resolver is injected via `getSystem`/`runHookFor`;
> `startFromCard` imports the party from MVU when the bundle has a `stat_map`), BP6 (SDK docs: §8a +
> rpt-api §4). **Remaining:** BP4 UI/runtime — per-encounter mode choice (Classic / Narrate /
> Deterministic) + the AI combat-entry prompt that generates enemy `char_info`→combatants (needs the
> running app); BP5 — the standalone status MVU-UI regex (the bundle config + end-to-end integration
> test shipped as [sdk/examples/poem-combat-bundle.json](../../sdk/examples/poem-combat-bundle.json));
> BP7 deferred. **BP4 enemy generation (static)**: `buildEncounterFromMvu` now also builds enemies from
> the bundle's `enemies` templates resolved against the combat-start cue — a fight is playable in-app
> with bundle-defined opponents (dynamic AI `char_info` enemies still deferred). Manual-test checklist:
> [combat-poem-manual-tests.md](../../combat-poem-manual-tests.md). **BP4 AI enemy generation (channel A1,
> owner-chosen 2026-06-26)**: the AI emits a JSON enemy **roster** in the `<rpt-combat-start>` body;
> `parseCombatStart` extracts it → `cue.roster` → `buildEncounterFromMvu({ roster })` builds each entry
> (×数量, `阵营:'友方'`→party) via `buildCombatant`. Paste-in `<战斗启动协议>` snippet in
> [poem-preset-combat-instructions.md](../../sdk/examples/poem-preset-combat-instructions.md). **Still
> needed for in-app combat:** add that snippet to the card preset (the app doesn't auto-inject). 676 tests.
> **Since BP6 (2026-06-26):** combat **sheet BUILT**
> ([poem-combat-sheet.regex.json](../../sdk/examples/poem-combat-sheet.regex.json), trigger `<战斗状态栏/>`,
> parchment-themed, mirrors parse/derive); **lorebook applied to the card** via
> [patch-poem-card.cjs](../../sdk/examples/patch-poem-card.cjs) — `<战斗启动协议>` (binary mode choice) +
> `<战斗协议>` gate + `<战斗数据规范>` + the bundle; **百分比 伤害增幅 / 护盾 / healing** + `scanEffectProse`
> for the card's flavor-keyed effect prose; **lifecycle/UX** — re-roll/swipe clears the encounter,
> always-available **Quit-combat → AI演绎**, no-viable-party guard, combat no longer reshapes the layout,
> empty-body lorebook fix; var write-back loop fixed app-side (value-diff guard + WCV exclude-sender).
> **Remaining:** per-encounter narration cadence chooser (Classic/Narrate/Deterministic, app UI) ·
> end-of-combat fold-back verify (in-app) · deferred depth (typed-damage/集群/意图/战意/revive) · BP7
> creative-input. Full build status: [combat-poem-of-destiny-expansion.md](../../combat-poem-of-destiny-expansion.md)
> §"Build status".

**Goal:** Ship a **combat extension (mod) for the 命定之诗 character card** that imports the party's
DND-style combat stats from MVU variables and resolves combat with the card's _own_ `<战斗协议>` (a
complete 层级-d20 system), displayed through the card's MVU UI. We build it **co-developed with the app
combat SDK on purpose**: the extension is the first real consumer of the combat seam, so every gap it
hits becomes a generic, documented app/SDK affordance. **The card content (命定之诗 numbers, UI) is the
mod; the generic machinery it forces into existence is the SDK.**

**Why the card's protocol, not the engine's native d20:** the engine's native resolver
([resolver.ts](../../../src/shared/combat/resolver.ts)) is classic D&D (STR…CHA, `d20≥AC`, dice damage,
tens-scale HP). 命定之诗 is a different, calibrated game (5 attrs, `d20+命中−闪避→评级` tiers,
`防御/(防御+2000)` mitigation, no AC, attrs→检定 mods, thousands HP). So the expansion supplies a
**card resolver** through the existing `resolveAction` hook; the engine contributes the grid /
positioning / turn-order / action-economy / range·LoS / AoE templates the card only narrates.

## Architecture deltas (on top of the phase-A engine)

- **`combat` bundle gains `stat_map` + `derive`** (`CombatBundleSchema`,
  [character.ts](../../../src/main/types/character.ts)) — the MVU-import contract.
- **Optional `ext` bag** (`ext?: Record<string,unknown>`) on `Combatant`/`AbilityDef`
  ([types.ts](../../../src/shared/combat/types.ts)) — carries the parsed `CardCombat` + the character's
  五维; native cards ignore it. Non-breaking.
- **`buildEncounterFromMvu`** (sibling to `buildEncounter` in
  [bundle.ts](../../../src/shared/combat/bundle.ts)) — reads player+party from MVU via `stat_map`,
  derives resources, attaches parsed items to `ext`.
- **A named combat-system registry** `src/shared/combat/systems/` — the `resolveAction` hook dispatches
  to a resolver selected by the bundle (`derive.system` / a `resolver` id). The 命定之诗 `<战斗协议>`
  resolver is the first entry, built as **trusted built-in TS for v1**; the card-_shipped_ sandboxed
  resolver path (untrusted, via `combat.scripts`) is documented as the SDK seam and **deferred** as a
  hardening step. This is the SDK-discovery payoff.
- **Per-encounter mode** (Classic / Combat-system Narrate / Combat-system Deterministic), chosen at the
  AI-prompted combat entry, in [combatService.ts](../../../src/main/services/combatService.ts) — extends
  phase-A's `narrationMode` + `<rpt-combat-start>` cue.

**Tech stack / constraints:** `src/shared/combat/**` stays **pure** (no electron/window/fs). Any new
user-facing string routes through `t()` + lands in both `locales/en.ts` & `zh.ts`. Clean-room (no JSR).
`derive` is pure data (no eval). Each phase: **review → test → typecheck/lint/build green → commit.**
Each phase records its **SDK delta** (what card-facing API it added → `docs/sdk/`).

---

## BP0 — Branch + baseline

Branch `feat/poem-combat-extension` off `feat/combat-system`. Confirm the suite is green
(`npm test`, typecheck, lint, build) before touching anything.
**SDK delta:** none.

## BP1 — App/SDK: bundle schema (`stat_map`/`derive`) + `ext` bag

- `CombatBundleSchema` += `stat_map` (player/party/paths) + `derive` (属性 names, 层级系数, hp乘数,
  mpsp乘数, 评级 table, 属性减免, 装备减免常数), permissive/passthrough to match the existing bundle style.
- `Combatant` & `AbilityDef` += optional `ext`.
- **Tests:** schema accepts the 命定之诗 sample bundle; `ext` optional; existing `buildEncounter` path
  unaffected.
- **SDK delta:** `combat.stat_map` + `combat.derive` + the `ext` bag — documented in `docs/sdk/` +
  `docs/rpt-api.md §4` as the "MVU-driven encounter import" contract.

## BP2 — Parser (card grammar) + `buildEncounterFromMvu` (generic plumbing)

- **`parseCardItem`** (命定之诗 grammar → `CardCombat`): 标签 (关联属性 / 有效距离:X / 范围:[层级][+形状] /
  威力:X / 特性·多段), 消耗 (攻击|动作: X MP/SP), 效果 (命中/闪避/先攻/状态抵抗 = **max not sum**; 固伤;
  DR/穿透/暴击倍率; 物理/能量/精神/真实 占比; 附加效果 `状态名:数值+回合` → Condition). Missing 威力 →
  unarmed (普攻 20). Lives in the extension layer; **open SDK question (flag, don't decide):** promote a
  default ST-grammar parser to the app later?
- **`buildEncounterFromMvu(statData, stat_map, derive, parseItem)`**: player = `主角`; party = `关系列表`
  where `在场:true`; read HP/MP/SP **directly** from MVU (`资源推演` formula only as fallback); attach
  per-item `CardCombat` + 五维 to `ext`.
- **Tests:** parser token-by-token; `buildEncounterFromMvu` over (a) the recovered `[InitVar]` zero-stat
  主角 and (b) a leveled character with skills/equipment → expected combatant + abilities.
- **SDK delta:** the `parseItem` seam + the read-direct-else-derive rule.

## BP3 — Resolver context + 命定之诗 `<战斗协议>` resolver

- Define & document the **`ResolverContext`** the `resolveAction` hook exposes: seeded `rng` (the d20
  pool), grid/`distance`/`lineOfSight`, combatant lookup + `ext`, `applyDamage`, `addCondition`, `log`,
  state read. ← **the core SDK-discovery artifact.**
- Implement `systems/poemD20` resolver: 行动顺序 `(敏捷×(1+%))+d20+固定`; 攻击检定 (生命层级 gap →
  2d20 high / 2d20 low / 1d20; `d20+命中−闪避` → 评级 tier); 伤害 (`关联属性×10×层级系数+威力+武器攻击`,
  ÷N 多段; 穿透→有效防御; `构成×防御/(防御+2000)`; 属性减免 by type; ×评级系数 ×意图系数 +额外固定 ×次数;
  ×(1−DR%); 集群×1.5; 范围); 状态 (crit auto / 有效·勉强 opposition / control +5). Register it; the
  bundle selects it.
- **Tests:** golden protocol cases (attacker/target/ability → exact 评级 + final damage), advantage
  pool, each mitigation step, multi-hit, cluster, status contest. Deterministic via injected rng.
- **SDK delta:** the documented `ResolverContext` + bundle→resolver selection; note sandboxed
  card-shipped resolvers as the next hardening step.

## BP4 — Per-encounter mode selection + AI combat-entry flow

- Entry: the AI prompts the start of combat and **generates the combat variables needed** (enemy
  `char_info` via `<角色生成>`); read into the encounter. Extends `<rpt-combat-start>`.
- Player picks mode: **Classic** (bypass engine — AI runs it in chat, today's behavior) /
  **Narrate** (engine resolves each turn → narrate per-turn) / **Deterministic** (engine resolves all →
  narrate once at end). Reuse phase-A `narrationMode` + adjudicate/fold path.
- `CombatView`/launcher: the entry mode-choice UI (mouse-only). i18n strings → en/zh.
- **Tests:** mode routing + entry-prompt builder where unit-testable; live AI paths verified in-app.
- **SDK delta:** the combat-entry contract (how a card declares a combat-system encounter + supplies the
  enemy-generation prompt).

## BP5 — Card-extension content: bundle config + status MVU-UI regex

- The 命定之诗 `extensions.rp_terminal.combat` bundle (stat_map + derive values + `resolver:"poemD20"` +
  mode defaults + enemy-gen prompt) — delivered as importable JSON + a note on embedding into the card
  (we don't re-embed the PNG in-repo).
- **Standalone status MVU-UI regex JSON**: a combat sheet reading `stat_data` — 5 attrs + derived 检定
  mods, HP/MP/SP, skills-as-abilities with 威力/有效距离/范围/消耗/命中/effects (parsed via the same
  grammar), equipment 攻击/防御, 状态效果. Computes derived numbers with the same `derive` tables.
- **SDK delta:** confirms MVU-UI ↔ `derive` sharing + any runtime helper the UI needs.

## BP6 — Docs consolidation + compat

- Update `docs/sdk/component-inventory.md §8a` + `docs/rpt-api.md §4` with the full combat-import SDK
  surface (stat_map/derive, `ext`, `ResolverContext`, resolver registry, mode/entry contract, parser
  seam). Reconcile `docs/compat-comparison.md` and the design doc. Citations with file:line.
- **SDK delta:** the consolidated combat SDK section is the artifact.

## BP7 — Deferred (recorded): creative-input box

On any combat-system turn the player types a freeform action → the AI determines that turn's outcome and
writes it back to combat state (phase-A's `adjudicate`/improvise path applied mid-turn). Build later.

---

## Verification

- **Unit-tested:** parser, `buildEncounterFromMvu`, the `poemD20` resolver, schema (Vitest, injected rng).
- **In-app only (needs running Electron + configured provider):** the AI combat-entry/enemy-gen prompt,
  per-turn vs end narration, the mode-choice UI, the MVU-UI regex render. Per
  [rpt-manual-testing-workflow], hand the owner explicit click + log-capture steps; computer-use can't
  drive the dev app.
- **命定之诗 content** (final tuned numbers, full UI polish) is owner-authored against the BP1–BP3
  contract; not fabricated here.
