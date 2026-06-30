# Native DuelView (interactive STS duel) — Design

Status: **Design approved (2026-06-30).** Give the already-built **headless STS duel engine** a native, playable
**DuelView** in the RPT app — the interactive counterpart to the read-only 战斗 build-preview tab. The fight is
rendered **natively** (paralleling the grid `CombatView`), with the 命定之诗 card supplying the ruleset + display
strings. **v1 = core fight loop only.**

Builds on: the headless duel engine ([2026-06-30-poem-sts-card-duel-design.md](2026-06-30-poem-sts-card-duel-design.md),
D1–D3 built) and realizes the deferred "interactive fight stays in the app's native DuelView" decision from the
build-preview design ([2026-06-30-duel-build-preview-tab-design.md](2026-06-30-duel-build-preview-tab-design.md) §0.1, §5).

---

## 0. Locked decisions (owner Q&A, 2026-06-30)

1. **Native RPT DuelView**, not a card-side fork UI. The playable fight is a native workspace view — the same
   architecture as the grid `CombatView` (RPT renders; the card supplies ruleset + data). This keeps engine
   control in-process (no per-action IPC to card code) and is generic over any duel card.
2. **v1 = core fight loop only.** Start a duel, see hand/energy/board/enemy intents, play cards (with targeting
   where a card needs it), end turn, automated ally + enemy phases, win/lose. **Polished and theme-customizable**
   (§5 Theming) — a designed surface, not a debug skeleton.
3. **Mirror the grid combat stack.** The 4 new units (`duelService` / `duelIpc` / `duelStore` / `DuelView`) parallel
   `combatService` / `combatIpc` / `combatStore` / `CombatView` exactly; no new engine logic is written.
4. **Debug mock launcher is a v1 deliverable.** A "Start mock duel (debug)" button (mirroring `CombatView`'s
   "Start mock battle (debug)") spins up a hardcoded duel with no card/AI needed — the immediate click-test path.
5. **Polished + theme-customizable in v1; card *art* deferred.** The UI is a clean, designed surface — proper card
   components (rarity frame, energy gem, cost, effect lines), a readable board (HP/block/intent), hover/active
   states, light transitions, a win/lose overlay. **Every color is an RPT theme token** (`var(--rpt-*)` + derived
   `--rpt-duel-*`), so the DuelView re-colors with the app's themes (dark / carbon / light) by construction (§5).
   Display strings (品质 labels, card names, effect lines) come from the card's ruleset / `CardCombat`. Deferred:
   card **art images** and bespoke per-card skins/palettes — theme *customization across RPT's themes* is in v1; a
   card supplying its own art/skin is not.
6. **Card-agnostic at the view layer.** `DuelView`/`duelStore`/`duelService` are generic over `DuelState`; the poem
   ruleset supplies content. Consistent with the generic-engine principle (memory `rpt-keep-app-engine-generic`).

---

## 1. The pure engine (exists — reused unchanged)

The interactive STS engine is already built and **pure** (`DuelState → DuelState` transitions), in
`src/shared/combat/deckbuilder/`:

- `startDuel(...)` ([deckEngine.ts:69](../../../src/shared/combat/deckbuilder/deckEngine.ts)), `drawHand(state)` (`:54`),
  `playCard(...)` (`:125`), `endLeadTurn(state)` (`:149`), `checkDuelVictory(state)` (`:29`), `swapLeadIfDown(state)` (`:37`).
- `buildDuelFromMvu(...)` ([deckbuilder/index.ts:20](../../../src/shared/combat/deckbuilder/index.ts)) — builds a duel from
  current MVU `stat_data` + the card's combat bundle (the same build path the preview uses).
- `DuelState` ([deckTypes.ts:31](../../../src/shared/combat/deckbuilder/deckTypes.ts)) =
  `{ status, lead, energy{current,max}, piles{draw,hand,discard,exhaust}, intents: Record<id,Intent>, combatants[], phase: 'lead'|'allies'|'enemies', handSize }`.

This spec adds **no** engine logic; it wraps the existing transitions in a service/IPC/store/view, exactly as the
grid combat stack wraps the grid engine.

---

## 2. Architecture — mirror the grid combat stack

```
 src/shared/combat/deckbuilder/*  (pure engine — exists, unchanged)
        ▲ DuelState transitions
 duelService (main)        ── holds active DuelState per chat; startMockDuel / startDuelFromMvu;
   │                          applies playCard/endLeadTurn/drawHand/swapLeadIfDown/checkDuelVictory;
   │                          runs automated allies+enemies phases, paced.
 duelIpc (main)            ── duel-start-mock · duel-start · duel-get · duel-play · duel-end-turn · duel-end
   │
 duelStore (renderer)      ── zustand mirror of DuelState + card/ability catalog; card→target selection;
   │                          busy + lastEvents/eventSeq feedback; auto-runs ally/enemy phases after end-turn.
 DuelView (renderer)       ── board · hand · energy · intents · play/end-turn · win-lose · "mock duel (debug)".
        ▲ registered in ViewRegistry (viewRegistry.tsx) → pickable workspace view.
```

| New file | Mirrors | Responsibility |
| --- | --- | --- |
| `src/main/services/duelService.ts` | [`combatService.ts`](../../../src/main/services/combatService.ts) (`startMockEncounter` :430, `applyPlayerAction`, `endTurn`, `runEnemyTurn`, `getEncounter`, `endEncounter`) | Hold the active `DuelState` per chat; `startMockDuel(chatId)` (hardcoded setup, no card/AI) + `startDuelFromMvu(...)`; apply one engine transition per action; drive automated `allies`+`enemies` phases. |
| `src/main/ipc/duelIpc.ts` | [`combatIpc.ts`](../../../src/main/ipc/combatIpc.ts) | `duel-start-mock`, `duel-start`, `duel-get`, `duel-play` (cardId, targetId?), `duel-end-turn`, `duel-end`. Keyed by `chatId` (`profileId` for parity). Register in `src/main/ipc/index.ts`. |
| `src/renderer/src/stores/duelStore.ts` | [`combatStore.ts`](../../../src/renderer/src/stores/combatStore.ts) (`startMock` :107, `runAutomated` pacing, `Selection`, `lastEvents`/`eventSeq`) | zustand mirror: `state: DuelState`, card catalog, `selection` (idle / card-picked / card+target), `busy`; `playCard`/`endTurn`; after end-turn auto-run ally+enemy phases paced for visibility. |
| `src/renderer/src/components/workspace/DuelView.tsx` | [`CombatView.tsx`](../../../src/renderer/src/components/workspace/CombatView.tsx) (mock button :131) | Render `DuelState`: board (player+party+enemies with HP/block/intents), hand of cards, energy, play-card (target select when needed), end-turn, win/lose overlay; "Start mock duel (debug)" when no active duel. **Polished, all colors via `var(--rpt-*)` / `--rpt-duel-*` tokens** (no hardcoded palette). |
| `src/renderer/src/assets/index.css` (modify) | the `--rpt-combat-*` token block ([:20-24](../../../src/renderer/src/assets/index.css)) | Add a small derived `--rpt-duel-*` token set in `:root` (energy gem, card surface/border, rarity tints, intent), `color-mix` from base theme tokens, so the duel re-colors per theme + stays WCAG-AA legible. Plus the duel component classes. |
| `src/renderer/src/components/workspace/viewRegistry.tsx` (modify) | the `combat` entry (:72) | Add a `DuelPanel` wrapper + a `duel: { title, Component: DuelPanel, fill: true }` entry — auto-appears in `VIEW_OPTIONS` (:82), so a panel can pick the Duel view. |
| `src/preload/index.ts` (modify) + the `window.api` types | the `combat*` preload methods | Expose `duelStartMock` / `duelStart` / `duelGet` / `duelPlay` / `duelEndTurn` / `duelEnd`. |
| `test/combat/duelService.test.ts` (new) | [`combatService.test.ts`](../../../test/combat/combatService.test.ts) | Headless service tests: mock setup → play a card (energy/pile change) → end turn (allies/enemies resolve) → victory/defeat. |

---

## 3. Data flow

Identical to grid combat: the **renderer never holds engine logic**. `DuelView` dispatches a `duelStore` action →
the store invokes `window.api.duel*` → `duelIpc` → `duelService` applies one pure engine transition to its held
`DuelState`, returns the new state → the store mirrors it → `DuelView` re-renders. After the player's `end-turn`,
the store auto-runs the automated `allies` then `enemies` phases (each transition paced with a short delay so the
player sees them resolve — mirroring `combatStore.runAutomated`), then redraws the hand for the next lead turn.

**Targeting:** `DuelView` selection is a small state machine like `combatStore.Selection` — `idle` → pick a card →
(if the card needs a target) pick an enemy → `duelPlay(cardId, targetId)`; self/AoE cards resolve immediately on
pick. (The exact `playCard` target parameter is grounded in the engine when the plan is written.)

---

## 4. Launch (v1)

- **Debug:** `DuelView` shows a **"Start mock duel (debug)"** button when there's no active duel → `duel-start-mock`
  → `duelService.startMockDuel` (a hardcoded `DuelState` via the engine, no card/AI). The immediate click-test path
  (the owner's original ask).
- **From the build:** `duel-start` → `startDuelFromMvu` (reuses `buildDuelFromMvu` over the active chat's
  `stat_data` + the card's combat bundle) — plays the player's actual current build.
- **Deferred:** a real in-game / AI-driven duel trigger (a card script or narrative cue starting a duel) — out of v1.

`DuelView` is reached as a **pickable workspace view** (the `duel` entry in `ViewRegistry`), the same way `CombatView`
is today.

---

## 5. Theming, module boundaries, testing

- **Theming (requirement — polished + customizable).** All DuelView colors are RPT theme tokens (`var(--rpt-*)`),
  plus a small derived `--rpt-duel-*` set added to `assets/index.css :root` — mirroring the existing
  `--rpt-combat-*` block ([index.css:20-24](../../../src/renderer/src/assets/index.css)), `color-mix` from base
  tokens so the duel re-colors automatically when `applyTheme()` ([theme.ts:75](../../../src/renderer/src/theme.ts))
  swaps themes. **No hardcoded palette.** Per the contrast rule (`theme.ts` header / `docs/ui-rehaul-design.md` §7),
  every fill token is paired with a text / on-* token and verified legible (WCAG AA) across **all three** themes
  including light. "Polished" = designed card/board components, hover/active/selected states, light transitions, and
  a clear win/lose overlay — not card-art images (deferred). The card's ruleset still supplies the display strings.
- **Engine stays pure** (`shared/combat/deckbuilder/*` — no renderer/main/IPC imports; already true). `duelService` is
  main and may import the shared engine; `duelStore` reaches main only through the typed IPC surface; `DuelView`
  imports no main internals. `npm run check:deps` must stay green.
- **Tests:** headless `duelService.test.ts` (start→play→end-turn→victory + the mock setup), mirroring
  `combatService.test.ts`; the engine itself is already characterization-tested. The UI is verified manually via the
  mock-duel button (no UI test harness, consistent with `CombatView`) — **including a cross-theme legibility pass
  (dark / carbon / light)**. `npm run typecheck && npm run check:deps && npm run test` is the gate.

---

## 6. What this is NOT (v1 non-goals)

- **No rewards / relic progression / post-duel results screen.** (Fight loop only; results = the win/lose overlay.)
- **No deck editing / card management UI.**
- **No card *art images*, cinematic animations, or bespoke card-supplied skins/palettes.** (v1 IS polished +
  themeable via RPT theme tokens across dark/carbon/light; light transitions only; per-card art/skins are later.)
- **No real AI/narrative duel trigger.** (Debug button + from-MVU only.)
- **No card-side fork duel UI.** (That was the rejected architecture; the fight is native.)

---

## 7. Decomposition

A single implementation plan is appropriate (one cohesive stack mirroring an existing pattern). Natural task order:
(1) `duelService` + mock setup + headless tests → (2) `duelIpc` + preload + `window.api` types → (3) `duelStore` →
(4) `DuelView` + the mock-launch button → (5) `viewRegistry` entry. Each task ends green on the verification gate;
the UI tasks add the manual mock-duel check.

---

## 8. Related

- Duel engine + authoring: [2026-06-30-poem-sts-card-duel-design.md](2026-06-30-poem-sts-card-duel-design.md).
- The read-only counterpart (build preview): [2026-06-30-duel-build-preview-tab-design.md](2026-06-30-duel-build-preview-tab-design.md).
- The grid combat stack this mirrors: `combatService` / `combatIpc` / `combatStore` / `CombatView`.
- Generic-engine principle: memory `rpt-keep-app-engine-generic`.
