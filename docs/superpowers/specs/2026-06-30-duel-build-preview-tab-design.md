# Duel Build-Preview — host API + card-UI 战斗 tab — Design

Status: **Design in progress (2026-06-30).** Surface a character's **duel build** (the deck their kit
becomes, plus combat resources/relics) inside the **命定之诗 card's own status UI**, fed by a new
**read-only RPT host API**. The card UI is the forked status app
(`FrontEnd-for-destined-journey-TPR-STS`, at `E:\Projects\FrontEnd-for-destined-journey-TPR-STS`); RPT
provides the engine-computed data. Two cooperating halves, one contract.

Builds on: the headless duel engine ([2026-06-30-poem-sts-card-duel-design.md](2026-06-30-poem-sts-card-duel-design.md),
D1–D3 built) and the card-runtime `Host` seam used by the party panel
([2026-06-27-poem-party-panel-v2-design.md](2026-06-27-poem-party-panel-v2-design.md)).

---

## 0. Locked decisions (owner Q&A, 2026-06-30)

1. **Build & loadout viewer, not a live-duel companion.** It shows the *build* (deck/resources/relics)
   derived from the current MVU state. The interactive fight stays in the app's native `DuelView`.
2. **RPT-only extension; no vanilla-ST portability.** The card UI may use RPT-specific features
   (World Assets, the host API). This *removes* the need to reparse the card grammar in the fork — RPT
   computes; the fork renders.
3. **Centerpiece = "your deck, as cards."** Each 技能 / basic renders as the duel card it becomes
   (rarity frame, energy cost, power, effects, 评级 estimate), shown as a collection with **×N copies**.
   Resources + relics + a party-member selector are supporting elements.
4. **Fidelity = RPT-fed.** RPT runs the engine over the current build and exposes the result; the fork
   never reimplements the deck/parse/评级 rules.
5. **Feed channel = a dedicated read-only host API** (`getDuelPreview()`), not the shared per-chat KV —
   clean producer/consumer separation, typed, an SDK surface the card can't clobber.
6. **Flexible layout (wide *and* tall) + multi-theme from day one.** The tab reflows to the panel's
   shape via container queries, and every color comes from the fork's existing theme-token system (8
   themes, incl. light) — no hardcoded palette.
7. **The standalone party panel (PR #23) and this tab coexist.** The panel manages party *membership*;
   this tab is strictly combat *builds* (its selector only picks whose build to view).
8. **The host API + its contract are GENERIC** (card-agnostic), per [[rpt-keep-app-engine-generic]]: the
   `DuelPreview` shape uses neutral field names; the card's combat *ruleset* supplies the values + any
   poem-specific display strings; the fork applies poem labels/theming.

---

## 1. Architecture — two halves, one contract

```
 RPT app (producer)                                 Forked status app (consumer)
 ─────────────────────                              ────────────────────────────
 current MVU stat_data                              战斗 tab (new)
   │  buildDuelPreview()  (engine over the build,     │  calls getDuelPreview()
   │  NO live duel: buildCombatant → buildDeck)        │  → render: selector · resources/relics · deck-as-cards
   ▼                                                    ▲
 Host.getDuelPreview(): Promise<DuelPreview> ──────────┘   (read-only; both transports at parity)
   exposed via createThRuntime on the card page
```

- **Producer (RPT, generic):** a `buildDuelPreview` computation + a new `getDuelPreview()` method on the
  card-runtime `Host` seam. The computation runs the **active card's combat ruleset** (today
  `poemD20System`; post-genericization, the card-supplied ruleset — see §6) over the current build.
- **Consumer (the fork):** a new **战斗 tab** that calls `getDuelPreview()`, holds the result in a small
  zustand store (mirroring `mvu-data.store`), and renders it — zero engine logic in the fork.
- **Interface:** the `DuelPreview` contract (§2). It is the only coupling between the halves.

---

## 2. The `DuelPreview` contract (generic, card-agnostic)

Neutral field names (§0.8); the ruleset fills values + formats display strings, the fork themes/labels.

```ts
interface DuelPreview {
  config: { energyPerTurn: number; handSize: number }
  lead: CombatantPreview
  party: CombatantPreview[]            // support members (在场 / chosen), each viewable
}

interface CombatantPreview {
  id: string; name: string
  tier: number; level: number
  resources: { hp: number; maxHp: number; mp: number; maxMp: number; sp: number; maxSp: number }
  modifiers: { key: string; label: string; value: number }[]   // aggregated relic/gear/passive mods
                                                                // (label is the ruleset's display text)
  conditions: { id: string; label: string; stacks?: number; turns?: number; kind: 'buff'|'debuff' }[]
  deck: CardPreview[]
}

interface CardPreview {
  id: string; name: string
  rarityKey: string                    // a stable rarity id (maps to a theme quality token, e.g. 'epic')
  rarityLabel: string                  // the ruleset's display label (e.g. '史诗')
  kind: 'attack' | 'defend' | 'skill' | 'heal' | 'power'
  energyCost: number
  resourceCost: { hp?: number; mp?: number; sp?: number }
  scalingAttr?: string                 // e.g. '智力' (display)
  power?: number
  effectLines: string[]                // pre-formatted, display-ready (e.g. '锥形 · 燃烧 30/2回合')
  ratingEstimate?: number              // a single 评级 expectation, not a distribution
  copies: number
  artKey?: string                      // World Assets '卡面' key; null today → rarity frame (D6 art later)
}
```

- `rarityKey` is a neutral id the fork maps to a **theme quality token** (`--theme-quality-*`, §4);
  `rarityLabel` is what's shown. This keeps the host API card-agnostic while letting the fork theme it.
- `effectLines` / `modifiers[].label` / `conditions[].label` are **formatted by the ruleset**, so the
  fork displays strings without knowing the grammar.

---

## 3. RPT app-side (producer)

### 3.1 `buildDuelPreview` — compute the build, no live duel

A new pure computation (reuses the engine, adds no live `DuelState`): for the player + present party,
run `buildCombatant` ([poemD20.ts](../../../src/shared/combat/systems/poemD20.ts) today / the card
ruleset post-§6) and `buildDeck` ([deckbuilder/deckBuild.ts](../../../src/shared/combat/deckbuilder/deckBuild.ts)),
then map to `DuelPreview`: aggregate identical cards into `copies`, pull `energyPerTurn`/`handSize` from
`DeckConfig`, read resources/modifiers/conditions off the built combatant's `ext`. Reuses
`buildEncounterFromMvu` / `buildDuelFromMvu`'s combatant build; it does **not** shuffle, draw, or hold a
turn loop.

### 3.2 The `getDuelPreview()` host method

Add to the card-runtime `Host` seam — the same one `getVariables`/`assetUrl` use, exposed on the card
page via `createThRuntime` ([thRuntime](../../../src/shared/thRuntime/index.ts), `Host` in
[thRuntime/types.ts](../../../src/shared/thRuntime/types.ts)), implemented by **both transports at
parity** (WCV preload [wcvHost.ts](../../../src/preload/wcvHost.ts) via a new
`wcv-host-duel-preview` IPC in [wcvIpc.ts](../../../src/main/ipc/wcvIpc.ts); inline
[cardBridge/host.ts](../../../src/renderer/src/cardBridge/host.ts) via `window.api`):

```ts
// Host
getDuelPreview(): Promise<DuelPreview>
// card page (createThRuntime)
getDuelPreview(): Promise<DuelPreview>   // RPT computes from the active chat's latest stat_data
```

- **Read-only.** No setter; the card can read but not write it (the clean producer/consumer split, §0.5).
- **Source:** the active chat's **latest floor** `stat_data` (mirrors how `StatusView` reads the latest
  variables) + the card's `combat` bundle (`stat_map`/`derive`/`DeckConfig`).
- **SDK obligation:** `getDuelPreview` + the `DuelPreview` contract are a card-facing surface →
  document in `docs/sdk/component-inventory.md` + `docs/rpt-api.md` in the same change (per `CLAUDE.md`).

---

## 4. Fork-side (consumer) — the 战斗 tab

In `src/status/` of the fork. Add a tab the way the app already does: a `tabs.config.ts` entry + a page +
the `App.tsx` switch case.

- **Tab:** `{ id: 'combat', label: '战斗', icon: 'fa-solid fa-swords' }` (or 卡组). New
  `pages/combat/CombatTab.tsx`.
- **Data:** a small `duel-preview.store.ts` (zustand, mirroring `mvu-data.store`) that calls
  `getDuelPreview()` on mount + when `stat_data` changes, holds `DuelPreview`, exposes the
  currently-viewed member id.
- **Regions** (per the approved mockup `poem_status_deck_tab_mockup`):
  1. **Member selector** — avatar chips for lead + party (`CombatantPreview[]`); pick whose build to view.
     Portraits via World Assets (`assetUrl`) — the fork is RPT-only so this is available.
  2. **Resource + relic header** — HP/MP/SP `ResourceBar`s (reuse the existing component), tier/level,
     condition pills (`StatusEffectDisplay`), and `modifiers` as relic chips.
  3. **Deck grid (centerpiece)** — each `CardPreview` as a card (reuse/extend the `Card` component):
     energy gem, rarity frame (themed, §4-theming), name, kind·rarityLabel, power/scalingAttr,
     `effectLines`, `resourceCost`, `ratingEstimate`, a **×copies** badge; **被动 powers** as
     "常驻 · 不进牌库" cards. A rarity-breakdown bar + deck stats (`N 张 · 行动力 · 手牌`) above it.
  4. **Inspect** — tap a card → the existing `DetailSheet` / `ItemInspectModal`.
- **Reused components:** `Card`, `ResourceBar`, `StatusEffectDisplay`, `DetailSheet`, `Collapse`,
  `EmptyHint`, the `withMvuData` HOC pattern. Minimal new components.
- **Empty/degraded states:** no `getDuelPreview` (older RPT) → `EmptyHint` ("combat preview unavailable");
  empty build → a clear empty state. Never throws.

### Theming (requirement 6a) — token-driven, all 8 themes

The fork applies `Theme.colors` as `--theme-*` CSS variables on the document root (fork
`src/status/core/stores/theme.store.ts` `applyCssVariables`; presets in `config/theme-presets.ts`). The
combat tab uses **only those tokens** — no hardcoded palette:

- **Rarity frames** → `--theme-quality-*` (`qualityCommon…qualityMythic`, already in every preset). The
  fork maps `CardPreview.rarityKey` → the matching quality token (the existing `quality.ts` util).
- **Resource bars** → `--theme-resource-hp/mp/sp`. **Surfaces/text** → `--theme-card-bg`/`content-bg`/
  `text-primary/secondary/muted`. **Accents** → `--theme-primary-bg`, etc.
- **New combat tokens** (the small additions): e.g. `energyGem`, `ratingAccent`, `powerText` — added to
  the `ThemeColors` type **and all 8 presets** so no theme is left half-styled ("multi-theme from start").
- **Light-theme legible:** `ivory` (the default!) and `misty-lilac` are light — because every color is a
  token, the tab inverts correctly. (The dark mockup palette was illustrative only.) Matches RPT's
  contrast-safety rule.

### Responsive (requirement 6b) — wide *and* tall

The tab root uses **CSS container queries** (sizes to the *panel*, not the viewport):

- **Wide** (landscape panel) → resource/relic header beside the deck (two columns); the deck grid gets
  more columns.
- **Tall / narrow** (portrait dock) → everything stacks vertically; the `repeat(auto-fill, minmax(…))`
  deck grid drops to fewer columns.
- No fixed widths/heights; the member selector + header reflow.

---

## 5. What this is NOT (boundaries)

- **Not the live duel.** No hand/board/play here — that's the native `DuelView`. This is a *build* view
  fed a snapshot, recomputed on build change.
- **Not party management.** The standalone party panel (PR #23) owns membership; this tab's selector only
  *views* builds (§0.7).
- **Not a card editor.** (The authoring/builder tool was a separate option, declined for now.)

---

## 6. The generic-engine dependency (related)

Per [[rpt-keep-app-engine-generic]] (owner principle, 2026-06-30): RPT's duel engine must be generic;
poem specifics belong in the poem extension. `getDuelPreview`'s shape is generic (§2), but its
**computation runs the poem ruleset**. Two implications:

- The `buildDuelPreview` computation should call the **card-supplied ruleset** (a `CombatSystem` that can
  produce a `CombatantPreview`/`CardPreview`), not hardcode poem rules. This rides the **engine
  genericization cleanup already tracked** (the deckbuilder currently bakes 普攻/格挡/品质/`poemStrike`).
- **Sequencing:** this UI can be built against `poemD20System` directly *now* (interim), but the clean
  end-state is: generic engine + a `ruleset.buildPreview()` hook the poem extension implements. Note the
  coupling in the plan so the preview computation moves with the ruleset during genericization.

This doc does not perform the cleanup; it records the dependency.

---

## 7. Module boundaries, SDK, repos

- **RPT side:** `buildDuelPreview` is a **pure** addition under `src/shared/combat` (no renderer/main
  imports); the `getDuelPreview` host method touches the `Host` seam + both transports + the IPC, like the
  party panel's `chatCardVars`. `npm run check:deps` must stay green.
- **SDK docs (required, same change):** `getDuelPreview` + `DuelPreview` → `docs/sdk/component-inventory.md`
  + `docs/rpt-api.md`. Cross-link the duel-card authoring guide ([docs/sdk/duel-card-authoring.md](../../sdk/duel-card-authoring.md)).
- **Two repos:** the producer lands in the RPT app repo; the consumer (the 战斗 tab) lands in the fork
  (`FrontEnd-for-destined-journey-TPR-STS`). The `DuelPreview` contract is the shared interface; keep a
  copy of the type in each, documented as the contract.

---

## 8. Decomposition — two plans, sequenced by the contract

1. **Plan A (RPT side):** `buildDuelPreview` + the `getDuelPreview()` host method (both transports + IPC)
   + the SDK docs. Headless + unit-tested (the computation), wiring verified. **Prerequisite** for B.
2. **Plan B (fork side):** the 战斗 tab — `duel-preview.store`, `CombatTab`, the card/selector/header
   components, theme tokens (+ the new combat tokens across all presets), container-responsive layout.
   Consumes the contract; mockable against a static `DuelPreview` fixture before A ships.

Each gets its own writing-plans pass. Build A first (or stub `getDuelPreview` with a fixture so B can
proceed in parallel).

---

## 9. Open questions

1. **`buildDuelPreview` ↔ ruleset seam:** add a `buildPreview()` to `CombatSystem` now, or compute the
   preview in `buildDuelPreview` by reusing `buildDeck` + a mapper (interim) and move it onto the ruleset
   during genericization? (Lean: interim mapper now; ruleset hook at genericization.)
2. **Which party members appear:** the player + `在场` companions, or only those the player marked for the
   duel (the party panel's `party.members`)? (Lean: player + 在场, matching the engine's party import.)
3. **New combat theme tokens — exact set** (`energyGem`, `ratingAccent`, …) and their values per preset.
4. **Recompute trigger:** on tab open + on `stat_data` change is enough, or also a manual refresh (like
   `StatusView`'s Re-evaluate)? (Lean: auto on change + a light refresh button.)
5. **Type duplication across repos:** hand-keep the `DuelPreview` type in both, or generate/share it?
   (Lean: hand-keep + document as the contract; it's small and changes rarely.)

---

## 10. Related

- Duel engine + authoring: [2026-06-30-poem-sts-card-duel-design.md](2026-06-30-poem-sts-card-duel-design.md),
  [docs/sdk/duel-card-authoring.md](../../sdk/duel-card-authoring.md).
- The `Host` seam + per-chat KV pattern: [2026-06-27-poem-party-panel-v2-design.md](2026-06-27-poem-party-panel-v2-design.md).
- World Assets (`assetUrl`): the World Assets layer.
- The generic-engine principle: memory `rpt-keep-app-engine-generic`.
- The fork: `FrontEnd-for-destined-journey-TPR-STS` (`src/status/`).
