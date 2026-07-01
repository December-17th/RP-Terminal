# AI-authored duel loop — Design

Status: **Design approved (2026-06-30).** Close the end-to-end loop so the AI can **generate duel-capable
abilities into MVU variables**, **start a native STS duel** from its own combat cue, and **narrate the
finished duel back into the story** with lasting consequences folded into `stat_data`. Builds on the native
DuelView ([2026-06-30-native-duelview-design.md](2026-06-30-native-duelview-design.md)) + effect-scope modes
([2026-06-30-duel-effect-scope-modes-design.md](2026-06-30-duel-effect-scope-modes-design.md)) and mirrors
the grid-combat AI touchpoints already in place.

Everything below is grounded against the actual card (extracted from
`example …/命定之诗/v4.2.1+combat+party.png`, 470 worldbook entries) and the current code, this session.

---

## 0. Locked decisions (owner Q&A, 2026-06-30)

1. **Mode selection = world-fixed (bundle mode).** The card's `combat` bundle declares
   `mode: 'grid' | 'duel'` (default `grid`); **every** fight in that world opens the declared system. No
   per-fight AI decision, no player 3-way prompt. Simplest app change; a world can't mix grid + duel (an
   accepted limitation). The `<rpt-combat-start>` cue stays unchanged.
2. **Post-duel narration mirrors grid combat.** Same manual-affordance trigger, same prompt shape
   (outcome + steering + final state + blow-by-blow log + "record consequences in `<UpdateVariable>`"),
   same fold-back into the floor's `stat_data`. A duel is still "combat"; it **reuses** the card's existing
   `combat.narration_prompt` / `narration_mode` steering.
3. **Ability generation = lorebook grammar edit only** (no app parse change — the parser already reads the
   duel-scope tags). Teach the AI the `群体` / `随机X` tags in the card's generation-rule entry.
4. **Extract, don't duplicate.** The grid narration plumbing moves to a shared main helper both combat and
   duel call — DRY, per the project's "one surface" convention. No second copy in `duelService`.
5. **Sequencing A → B → C.** Duel start → post-duel narration → grammar edit. A + B are app code; C is a
   doc/asset edit with no code.

---

## 1. Background — the three mechanisms this wires together (verified)

**Ability → variables (today).** The AI authors a skill per the card's `[技能装备道具生成规则]` worldbook
entry (skill format + 标签 vocabulary + the appended `<战斗数据规范>` block), then writes it via the card's
MVU dialect from `[mvu_update]变量输出规则`:
`<UpdateVariable><JSONPatch>[{ "op": "insert", "path": "/主角/技能/<名>", "value": {…} }]</JSONPatch></UpdateVariable>`.
Our [applyJsonPatch:467](../../../src/main/parsers/mvuParser.ts) routes `insert`/`add`/`set`/`replace` →
`setAtSeg`, which correctly **creates the keyed object** at `/主角/技能/<名>` (only `-`/numeric next-segments
become arrays). [buildCombatant:247](../../../src/shared/combat/systems/poemD20.ts) then reads
`Object.entries(技能)` and turns each active skill into a duel card. **The write plumbing already works** —
what's missing is the grammar for the new duel-scope tags (Piece C).

**Combat start (today).** The `[战斗启动协议]` entry tells the AI to narrate to the brink, emit
`<rpt-combat-start map="">[roster]</rpt-combat-start>` (hidden; roster uses stat_data field names incl.
`技能`), and offer 【进入战斗系统】vs【AI演绎】. [parseCombatStart:98](../../../src/main/parsers/contentParser.ts)
strips the tag into a `combat_cue` var; [ChatView:183-197](../../../src/renderer/src/components/ChatView.tsx)
renders "Enter Combat" → `combatStartFromCard` → grid `CombatView`. `CombatStartCue` carries **no mode
discriminator** — every cue routes to grid. The duel is reachable only via the debug mock button
(`duel-start-mock`) or the unused, enemyless [startDuelFromMvu:170](../../../src/main/services/duelService.ts)
("no UI invokes this yet"). Piece A closes this.

**Post-combat narration (today, grid only).** `combat-narrate` → [narrate:632](../../../src/main/services/combatService.ts)
builds [buildNarrationPrompt:66](../../../src/shared/combat/serialize.ts) (outcome from `state.status` +
optional steering + `describeState` + blow-by-blow `state.log` + "record consequences in `<UpdateVariable>`"),
and [writeNarrationToChat:597](../../../src/main/services/combatService.ts) lands the prose (append / new
floor per `narration_mode`) while [foldNarrationMvu:552](../../../src/main/services/combatService.ts) applies
the `<UpdateVariable>`/`<JSONPatch>` into that floor's `stat_data`. The duel's [duelIpc](../../../src/main/ipc/duelIpc.ts)
only exposes `duel-end` → `endDuel` (clears the in-memory record) — **no narration, no fold-back.** Piece B
closes this. `DuelState` already has `log: CombatEvent[]` + `status`
([deckTypes.ts:42-43](../../../src/shared/combat/deckbuilder/deckTypes.ts)), so the duel can mirror the grid
prompt directly.

---

## 2. Piece A — Duel start (world-fixed bundle mode)

**A1. Bundle schema.** Add `mode: z.enum(['grid', 'duel']).optional()` to
[CombatBundleSchema:69](../../../src/main/types/character.ts) (default `grid` when absent — no regression for
existing grid worlds). A duel-world card sets `data.extensions.rp_terminal.combat.mode = 'duel'`.

**A2. Stamp the mode on the cue (main-side).** When main resolves the `<rpt-combat-start>` cue into the
`combat_cue` variable, it reads the active card's `combat.mode` and stamps it onto the cue object
(`combat_cue.mode = 'grid' | 'duel'`). This keeps bundle-reading in **main** — the renderer never imports
main internals (module-boundary clean; `renderer → main` only via typed IPC). `CombatStartCue`
([contentParser.ts:68](../../../src/main/parsers/contentParser.ts)) is unchanged on the wire; the `mode`
lives on the stored `combat_cue` var the renderer already reads.

**A3. Renderer routing.** [ChatView.enterCombat:187](../../../src/renderer/src/components/ChatView.tsx)
branches on `combatCue.mode`:
- `grid` (or unset) → `window.api.combatStartFromCard(profileId, chatId, cue)` + `setMode(profileId, 'combat')` (today).
- `duel` → `window.api.duelStartFromCue(profileId, chatId, cue)` + `setMode(profileId, 'duel')`. The `duel`
  view is already registered ([viewRegistry.tsx:79](../../../src/renderer/src/components/workspace/viewRegistry.tsx)).

**A4. Consume the roster.** Generalize [startDuelFromMvu:170](../../../src/main/services/duelService.ts) into
a cue-aware entry (`startDuelFromCue(profileId, chatId, cue)`): gather `stat_data` + the card's combat bundle
(as `duelPreviewService` does) and call
`buildEncounterFromMvu(statData, statMap, poemD20System, { derive, seed, roster: cue.roster })` — the **exact**
path [createMockDuel:106](../../../src/main/services/duelService.ts) uses with `MOCK_ROSTER`. AI-authored
enemies (character-shaped objects carrying `技能`) become duel enemies whose skills drive their telegraphed
intents. Expose `duel-start-from-cue` in [duelIpc](../../../src/main/ipc/duelIpc.ts) + the preload surface.

**A5. Touch-ups.**
- The cue affordance ([ChatView.tsx:258](../../../src/renderer/src/components/ChatView.tsx)) hides when
  `activeChatMode` is `combat` **or** `duel`, and its label follows the mode (进入战斗 / 进入对决). New i18n
  keys in `locales/en.ts` + `locales/zh.ts` (e.g. `combat.enterDuel`).
- [chatStore.ts:106](../../../src/renderer/src/stores/chatStore.ts) auto-reset treats `duel` like `combat`
  (reset to `explore` on chat switch).

---

## 3. Piece B — Post-duel narration + MVU fold-back

**B1. Extract shared narration plumbing.** Move `narrationConfig` / `foldNarrationMvu` / `writeNarrationToChat`
out of [combatService.ts:552-623](../../../src/main/services/combatService.ts) into a new small main module
`src/main/services/narrationService.ts`. Both `combatService.narrate` and the new `duelService.narrate` import
it. `narrationConfig` already reads the card `combat.narration_prompt` / `narration_mode` (+ user settings) —
a duel reuses those same fields. Behavior for grid is unchanged (pure extraction).

**B2. Pure duel narration prompt.** Add `buildDuelNarrationPrompt(state: DuelState, extra?: string): string`
in `shared/combat` (alongside or mirroring [buildNarrationPrompt:66](../../../src/shared/combat/serialize.ts)):
- `Outcome:` from `state.status` — party won / party defeated / broke off unresolved (map `DuelStatus`).
- optional `extra` steering line (from `narrationConfig`).
- a duel `describeState` (final HP/energy per combatant) + `Blow-by-blow log:` from `state.log` (the same
  `CombatEvent[]` shape grid uses).
- the closing "record the lasting consequences (injuries, deaths, spent resources, loot) as variable updates
  in an `<UpdateVariable>` block, per this world's schema." Stays **pure** (text in, string out) →
  `check:deps` clean.

**B3. Service + IPC + UI.**
- `duelService.narrate(profileId, chatId)` mirrors [combatService.narrate:632](../../../src/main/services/combatService.ts):
  `generateRaw` with `buildDuelNarrationPrompt(record.state, extra)` → `writeNarrationToChat` (append / new
  floor) → returns `{ narration, mode }`. `foldNarrationMvu` persists any `<UpdateVariable>`/`<JSONPatch>`
  into the floor's `stat_data` via the same `applyMvuCommands` / `applyJsonPatch`.
- `duel-narrate` IPC in [duelIpc](../../../src/main/ipc/duelIpc.ts) + preload; a DuelView affordance shown on
  win/lose ("战后叙事" / "Narrate outcome") that calls it, then `duel-end` to clear the record and returns to
  chat. The renderer reloads floors after (mirrors CombatView).

**B4. Card-side (already correct).** The gated `[战斗协议]` entry already tells the AI: on a **战后叙事**
request, narrate the ending *from the system result — never rewrite the win/loss or numbers*
([patch-poem-card.cjs:30](../../../docs/sdk/examples/patch-poem-card.cjs)). No card change needed for Piece B.

---

## 4. Piece C — Ability-generation grammar (lorebook, no app code)

**C1. Teach the duel-scope tags.** Extend the `<战斗数据规范>` block (the combat-spec section, where duel
semantics belong) with a duel-target-mode line, appended by the `SPEC` const in
[patch-poem-card.cjs:47](../../../docs/sdk/examples/patch-poem-card.cjs):

```
- 【决斗目标模式】主动技能可在标签中额外声明卡牌决斗的目标范围：默认「单体」；
  加「群体」= AOE（打全体敌方 / 治疗全体友方）；加「随机X」= 随机 X 次打击（可重复命中，如「随机3」）。
  治疗技同理，由效果决定作用于友方。此标签仅用于决斗模式，与网格战斗的「范围: [爆发/直线/锥形]」互不冲突。
```

The parser already accepts exactly these tags — [poemD20.ts:129-133](../../../src/shared/combat/systems/poemD20.ts):
`群体|群|全体|AOE` → `目标模式:'群体'`; `随机X`/`随机:X`/`随机` → `目标模式:'随机'` + `随机次数`; absent → 单体.

**C2. Regenerate + document.** Re-run `node docs/sdk/examples/patch-poem-card.cjs` to rebuild
`v4.2.1+combat.png` (idempotent, self-verifying). Document the two duel tags in the SDK examples
([poem-item-combat-compat.md](../../../docs/sdk/examples/poem-item-combat-compat.md),
[duel-card-authoring.md](../../../docs/sdk/duel-card-authoring.md)) so the compatibility contract stays
accurate. No renderer/main code changes.

**Note on the live card.** The user's imported card must also pick up the edit — either re-import the patched
PNG or edit the `[技能装备道具生成规则]` entry in the app's 世界书 panel. `patch-poem-card.cjs` is the
in-repo reproducible record of that lorebook change (the PNG is an untracked binary artifact).

---

## 5. End-to-end flow (after all three)

1. AI generates a `群体`/`随机X` skill per the updated grammar → writes it via `<UpdateVariable><JSONPatch>
   insert /主角/技能/<名>` → lands in `stat_data` (Piece C + existing plumbing).
2. Scene turns to a fight → AI emits `<rpt-combat-start>[roster]`; main stamps `mode:'duel'` (Piece A2).
3. Player clicks 进入对决 → `duelStartFromCue` builds the encounter from the roster; the generated skill is a
   duel card with its scope (Piece A4 + effect-scope modes).
4. Fight resolves → player clicks 战后叙事 → `duelService.narrate` writes prose + folds injuries/resources/
   loot into `stat_data` (Piece B).

---

## 6. Boundaries, testing, non-goals

**Module boundaries (`npm run check:deps`).** `shared/combat` stays pure (`buildDuelNarrationPrompt` is
text-in/string-out — no renderer/Electron/IPC). The extracted `narrationService` lives in `main`. The
renderer reaches the new duel-start / duel-narrate only through the typed IPC + preload surface. No transport
or engine boundary is crossed.

**Tests.**
- Engine/pure: `buildDuelNarrationPrompt` for each `DuelStatus` (won / defeated / unresolved), asserting the
  outcome line + that the log is included; a duel built from a cue roster produces enemies with abilities.
- Service: `startDuelFromCue` builds a non-empty enemy side from a roster (vs the old enemyless path);
  `duelService.narrate` writes a floor and folds a sample `<UpdateVariable>` into `stat_data`.
- Routing: a cue with `combat.mode='duel'` stamps `combat_cue.mode='duel'`; `'grid'`/unset stays grid.
- Characterization: existing `buildNarrationPrompt` + grid `narrate` behavior unchanged after the extraction.

**Non-goals.**
- STS card **rewards/relics** UI (narration-driven loot only — the AI folds loot via `<UpdateVariable>`).
- **Cue-level or player-choice** mode selection (world-fixed chosen in §0).
- **Enemy 群体/随机 intent telegraph** (still previews single-target; latent until an enemy AoE card ships —
  tracked with the effect-scope-modes work).
- **Agentic per-turn AI narration** and an **AI enemy controller** for the duel (depend on the not-yet-built
  agentic capability; deferred, as in the STS design).
- No new damage/heal math; no change to the turn loop, energy, or targeting.

## 7. Related
- Native DuelView + its engine: [2026-06-30-native-duelview-design.md](2026-06-30-native-duelview-design.md),
  `src/shared/combat/deckbuilder/*`, `src/main/services/duelService.ts`.
- Grid AI touchpoints being mirrored: `src/main/services/combatService.ts`, `src/shared/combat/serialize.ts`.
- The card contract: `docs/sdk/examples/poem-item-combat-compat.md`,
  `docs/sdk/examples/poem-preset-combat-instructions.md`, `docs/sdk/examples/patch-poem-card.cjs`.
- Generic-engine principle (poem coupling moves with the ruleset at genericization): memory
  `rpt-keep-app-engine-generic`.
