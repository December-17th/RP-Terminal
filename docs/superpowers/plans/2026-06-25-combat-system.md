# Local Grid Combat System — Implementation Plan (2026-06-25)

**Design / spec:** [docs/combat-system-design.md](../../combat-system-design.md)

> **STATUS (2026-06-25): P1–P7 DONE; P8 partially done — the combat track is end-to-end playable.**
> Shipped: pure engine — types/dice/grid (P1), native d20 resolver + turn engine + card-override seam
> (P2), weighted enemy policy (P3); main-process `combatService` + `combat_encounters` persistence +
> sandbox hook bridge + IPC/preload (P4); native `CombatView` + combat store + Combat-mode layout
> (P5); AI touchpoints — `<rpt-combat-start>` cue, `<rpt-combat-result>` adjudication, narration, `ai`
> enemy controller (P6); combat bundle schema + `buildEncounter` + Enter-Combat wiring + SDK docs
> (P7). **P8 (tactical depth):** line-of-sight + the stunned/restrained (immobilize) and prone
> (attacker advantage) condition mechanics are **done**; **deferred** within P8 — cover, opportunity
> attacks/reactions, flanking, hex grid, smarter policy. **71 combat unit tests (640 total), all green
> (typecheck/lint/build).**
>
> **Notes / design changes made while building:**
> - **P2 seam:** shipped as a single coarse `resolveAction` hook (whole-action override) rather than
>   the granular `resolveAttack`/`applyDamage`/… hooks in §5/design §5; those names are reserved in the
>   `HookName` union as a forward-compatible refinement.
> - **Per-action RNG:** the engine derives each action's RNG from `(seed, rngCursor)` (a `rngCursor` on
>   CombatState) so fights are deterministic AND resume after restart without persisting live RNG.
> - **Verification gap:** P5 (renderer UI) and the live AI calls in P6 are exercised by typecheck +
>   build + the existing suite, not by automated UI/provider tests — they need the running app +
>   a configured provider to verify in-app.
> - **命定之诗 content** (actual stats/abilities/bestiary/maps/skin) is authored by the world owner
>   against the P7 `CombatBundleSchema`; it is not fabricated in this repo.
>
> **UI follow-up + deferrals (2026-06-25, owner-decided — see combat-system-design.md §15):** shipped
> action economy (one move / attack / action per turn), LoS-gated abilities (`requiresLoS`), animation
> (token slide, HP tween, floating numbers), a pop-out overlay, narration-to-chat (append / new floor)
> + its steering prompt, and the freeform-action box (own prompt) with an AI-driven mid-fight exit
> (`"end": true`). **Deferred by decision:** (a) **tactical depth** (cover, opportunity attacks,
> reactions, flanking, extended conditions) is **script-authored** — delivered by world-bundled or
> player-installed `combat.scripts` via the hook seam, not the native engine; (b) the **`ai` enemy
> controller** (dormant scaffold) — when built it needs its **own player/world prompt**; (c) **keyboard
> controls** (mouse-only for now).

**Goal:** A player-played, turn-based, square-grid d20 combat system for RP Terminal. The player
makes their party's moves; a native deterministic engine resolves every die (seeded); enemies are
driven by a native weighted policy or the AI; the AI is only a **narrator** (end-of-combat) and
**referee** (mid-fight adjudication of out-of-system actions), never the source of numbers. Worlds
opt in via a `combat` bundle; consequences fold back into `stat_data` via MVU.

**Architecture (the seam that makes hybrid rules work):**

- **`src/shared/combat/` — a pure, realm-agnostic core** (imports nothing electron/window/fs — same
  rule as `src/shared/thRuntime/**`). Holds the state model, grid math, dice, the native d20
  resolver, the weighted enemy policy, and a turn engine. Every function is pure over
  `(state, action, rng, hooks)` and directly unit-testable.
- **The native resolver runs as trusted main-thread TS, NOT in the quickjs sandbox.** Determinism
  comes from a seeded RNG (mulberry32), not from isolation — and our own code is trusted, so there's
  no reason to pay quickjs overhead or stringify it. **The sandbox (`runSandbox`) is used ONLY to run
  untrusted card-override hooks.** (This sharpens the design doc's loose "the engine runs in
  sandboxRunner.")
- **The hook seam is dependency-injected.** `engine.applyAction(state, action, { rng, runHook })`
  takes an async `runHook(name, input, seed)` injected by the caller. The pure core defaults to its
  native implementations; the main-process `combatService` injects a `runHook` that dispatches to a
  card's `combat.scripts` override via `runSandbox` ([sandboxService.ts](../../../src/main/services/sandboxService.ts))
  when one exists. This keeps `shared/` pure while letting a world override/extend resolution.
- **`src/main/services/combatService.ts`** — persistence, the `runHook` injection over `runSandbox`,
  IPC, the `CombatState ⇄ prompt` serializers, and the consequence fold-out (reusing the
  `applyJsonPatchToFloor` write-back pattern, [generationService.ts:420](../../../src/main/services/generationService.ts)).
- **`src/renderer/src/components/workspace/CombatView.tsx`** + a `combatStore` — the native grid UI,
  registered in [viewRegistry.tsx](../../../src/renderer/src/components/workspace/viewRegistry.tsx).

**Tech Stack:** TypeScript (strict), Vitest (`test/`), electron-vite (main + preload + renderer),
Zustand, better-sqlite3.

## Global constraints

- Prettier: **no semicolons, single quotes, 2-space indent, printWidth 100, no trailing commas**.
- `src/shared/combat/**` imports **nothing realm-specific** (no `electron`/`window`/Zustand/`fs`/
  `better-sqlite3`). Pure functions + injected dependencies only.
- All combat RNG is **seeded** and stored on `CombatState.seed` so a "re-evaluate" replay reproduces
  the fight (mirrors the MVU replay, [generationService.ts:393](../../../src/main/services/generationService.ts)).
- Every AI touchpoint **appends at L4** — never edits the cached L1–L3 prefix
  ([agentic-mode-design.md](../../agentic-mode-design.md) §11).
- Combat **never writes `stat_data` directly** — only the consequence fold-out (via the AI's MVU
  JSON-Patch) does.
- New user-facing strings route through `t()` and land in **both** `locales/en.ts` + `locales/zh.ts`.
- Run `npm run typecheck`, `npm test`, `npm run build` before each task's commit; no new lint errors.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Design review — refinements verified against the code

1. **Native resolver on the main thread; sandbox for card hooks only** (see Architecture). `runSandbox`
   ([sandboxService.ts](../../../src/main/services/sandboxService.ts)) returns `{ ok, result, events, logs }`:
   a card hook script `return`s the new (partial) state and `emit()`s `CombatEvent`s — a clean fit.
2. **`mulberry32` must be shared.** It currently lives privately in
   [sandboxRunner.ts:46](../../../src/main/services/sandboxRunner.ts). Factor an identical
   `makeRng(seed)` into `shared/combat/dice.ts` so the native path and a sandboxed card-override
   (same seed) stay consistent. Do **not** import sandboxRunner into `shared/`.
3. **Storage: a new `combat_encounters` table, not `rpg_entities`.** `rpg_entities`
   ([db.ts:70](../../../src/main/services/db.ts)) is shaped per-entity (`id/name/data`), but the engine
   is pure over the *whole* `CombatState` (grid + combatants + initiative + turn + log + seed). Store
   the serialized `CombatState` as one JSON blob keyed by `chat_id`:
   `combat_encounters (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, data TEXT NOT NULL, updated_at TEXT)`
   added to `SCHEMA` (it's `CREATE TABLE IF NOT EXISTS`, so no migration needed). One active encounter
   per chat. `rpg_entities` is left untouched for a possible future normalized/query use. **Decision —
   reversible.**
4. **Wiring point for the AI touchpoints is the parse/fold block in `generate()`** — `parseContent`
   (line 332) + `parseMvuCommands` (335) + `applyEvent`/MVU fold (340–348)
   ([generationService.ts](../../../src/main/services/generationService.ts)). `<rpt-combat-start>` parses
   alongside `<rpt-event>` in [contentParser.ts](../../../src/main/parsers/contentParser.ts) (same regex
   pattern); `<rpt-result>` adjudication results fold the same way.
5. **Adding a view is trivial.** `ViewRegistry` is a plain map and `VIEW_OPTIONS` auto-derives
   ([viewRegistry.tsx:62](../../../src/renderer/src/components/workspace/viewRegistry.tsx)) — add a `combat`
   entry + Component. Combat-mode layout uses the existing per-mode `workspaceStore`.
6. **Keep the `combat` slot loose until P7.** `extensions.rp_terminal.combat` is `z.record(any)` today
   ([character.ts:103](../../../src/main/types/character.ts)); only tighten it into a real
   `CombatBundleSchema` when content authoring lands (P7), to avoid churning the card type early. The
   SDK-doc update is part of P7 (per `CLAUDE.md` / [sdk/README.md](../../sdk/README.md)).

---

## Phase 1 (P1) — Pure core foundations: types, dice, grid

**Files (new):** `src/shared/combat/types.ts`, `dice.ts`, `grid.ts`; tests in `test/combat/`.

- **`types.ts`** — `CombatState` (`seed`, `grid`, `combatants[]`, `initiative[]`, `turnIndex`, `round`,
  `log: CombatEvent[]`, `status: 'active'|'player'|'enemy'`), `Combatant` (`id`, `side: 'party'|'enemy'`,
  `name`, `pos: [x,y]`, `block: { hp, maxHp, ac, speed, mods: Record<Ability,number>, abilities: string[],
  conditions[] }`), `Action` (`{ kind: 'move'|'ability'|'end'|'improvise', actor, target?, path?, abilityId?,
  prose? }`), `AbilityDef` (range, `shape`, `toHit`, `save`, `damage`, `effects`), `CombatEvent`
  (`{ text, kind, delta? }`), `GridSpec` (`w`, `h`, `cellFt`, `tiles: TileFlags[]`).
- **`dice.ts`** — `makeRng(seed)` (mulberry32, shared per refinement #2); `rollD20(rng, {adv,dis})`;
  `rollExpr(rng, '2d6+3', mods)` (parse `NdM±K`, resolve ability tokens like `+STR`); crit/fumble flags.
- **`grid.ts`** — coords/occupancy; `distance` (Chebyshev); `reachable(state, id)` (BFS over passable
  cells within `speed`, difficult-terrain cost); `cellsInTemplate(origin, shape)` for
  `burst|line|cone|self|aura`; `targetsInCells(state, cells)`.
- **Tests:** seeded determinism (same seed ⇒ same rolls), dice-expression parsing, BFS reachability +
  difficult terrain, each AoE template's affected-cell set. Pure, no quickjs.

**Commit:** `feat(combat): pure core — types, seeded dice, grid + targeting`

## Phase 2 (P2) — Native resolver + turn engine + hook seam

**Files (new):** `src/shared/combat/resolver.ts`, `engine.ts`, `hooks.ts`; tests.

- **`hooks.ts`** — the hook contract + a `RunHook` type: `(name: HookName, input, seed) => Promise<{
  result?: Partial<CombatState>|CombatEvent-shaped, events: CombatEvent[] } | null>` (null ⇒ no override,
  use native). Hook names: `seedCombatant`, `onTurnStart`, `onTurnEnd`, `resolveAttack`, `applyDamage`,
  `enemyPolicy`, `checkVictory` (design §5).
- **`resolver.ts`** — native implementations: `resolveAttack` (d20+mod vs AC, adv/dis, crit), `applyDamage`
  (typed, resist/vuln), `applyAbility` (range/AoE check → per-target attack or save), `tickConditions`.
- **`engine.ts`** — `rollInitiative(state, rng)`; `applyAction(state, action, { rng, runHook }) =>
  { state, events }` (validates legality, runs the native impl unless `runHook` returns an override,
  appends to log, advances turn); `checkVictory`. **Async** because `runHook` may be (sandbox).
- **Tests:** attack hit/miss/crit at fixed seeds; AoE save-for-half; movement legality; a stub `runHook`
  proving override precedence over native; victory detection. Card hooks NOT run here (that's P4) — the
  stub validates the seam.

**Commit:** `feat(combat): native d20 resolver + turn engine + card-override seam`

## Phase 3 (P3) — Enemy controllers

**Files (new):** `src/shared/combat/policy.ts`; tests.

- **`weightedPolicy(state, enemyId, rng) => Action`** — score legal actions (threat / kill-secure /
  positioning / range-or-AoE value / self-preservation), pick top (rng breaks ties). Pure, deterministic.
- **The `ai` controller is an interface, not logic here:** `engine` takes an optional
  `chooseEnemyAction(state, enemyId) => Promise<Action>`; when absent (or controller = `weighted`), use
  `weightedPolicy`. The `ai` implementation (one batched call per round) lands in P6 alongside the other
  AI touchpoints.
- **Tests:** the policy prefers a lethal in-range attack, repositions when out of range, retreats at low
  HP; determinism at fixed seed.

**Commit:** `feat(combat): native weighted enemy policy + controller interface`

## Phase 4 (P4) — Main-process service, persistence, card-hook sandbox bridge, IPC

**Files (new):** `src/main/services/combatService.ts`, `src/main/ipc/combatIpc.ts`; **edit:**
`src/main/services/db.ts` (add `combat_encounters` to `SCHEMA`), `src/preload/index.ts` (expose
`window.api.combat*`), the main IPC bootstrap.

- **`combatService.ts`** — `startEncounter(chatId, setup)` (build the fresh combat block from setup +
  templates, roll initiative, persist), `getEncounter(chatId)`, `applyPlayerAction(chatId, action)`,
  `runEnemyTurn(chatId)`, `endEncounter(chatId) => outcome`, `clearEncounter(chatId)`. Wraps the pure
  `engine` and persists `CombatState` to `combat_encounters` after each step.
- **The `runHook` injection** — `combatService` builds the `RunHook` passed into the engine: for each
  hook, if the active card's `combat.scripts` defines an override, call
  `runSandbox({ code, input: { state, action }, seed })` and map `{ result, events }`; else return null
  (native). This is the only place the sandbox is touched.
- **IPC + preload** — mirror the existing IPC/preload registration pattern (e.g. `wcvIpc`/`pluginIpc`).
- **Tests:** service-level start→action→enemy-turn→end against a fake card (no real sandbox needed; the
  in-process `runScript` fallback works under Vitest per [sandboxService.ts:50](../../../src/main/services/sandboxService.ts));
  persistence round-trips; `endEncounter` produces the structured outcome.

**Commit:** `feat(combat): combat service, encounter persistence, card-hook sandbox bridge + IPC`

> **End of first milestone (P1–P4): a fully deterministic, tested combat engine driveable over IPC,
> no UI, no AI calls.**

## Phase 5 (P5) — Native CombatView + Combat-mode layout

**Files (new):** `src/renderer/src/components/workspace/CombatView.tsx`, `src/renderer/src/stores/combatStore.ts`;
**edit:** `viewRegistry.tsx` (register `combat`), `layoutDefaults.ts` (a combat-mode default layout),
both locale files.

- Grid renderer (tokens, terrain, reachable-cell highlight, AoE template preview on hover before
  commit), initiative tracker, action bar (move / abilities / end turn / **Improvise**), combat log.
- `combatStore` mirrors `CombatState` from IPC and dispatches actions; live-updates after each
  `applyPlayerAction`/`runEnemyTurn`. Card `combat.skin` tokens/CSS applied via `--rpt-*`.

**Commit:** `feat(combat): native CombatView, combat store + Combat-mode layout`

## Phase 6 (P6) — AI touchpoints (detect, adjudicate, narrate, fold-out)

**Files:** **edit:** `contentParser.ts` (`<rpt-combat-start>`), `generationService.ts` (wire at the
parse/fold block); **new:** `src/shared/combat/serialize.ts` (`stateToPrompt` for narration +
adjudication; `parseAiResult` → ops), the `ai` enemy controller (batched per round).

- `<rpt-combat-start enemies="…" map="…">` → an **"⚔ Enter Combat"** affordance in the message → setup
  → P4 `startEncounter`.
- **End-of-combat narration:** the combat log → narration prompt → AI prose (append at L4).
- **Mid-fight Improvise:** snapshot + player prose → adjudication prompt → AI returns narrative +
  `<rpt-result>` ops → fold into `CombatState` → continue.
- **Consequence fold-out:** `endEncounter` outcome → the AI emits MVU `<JSONPatch>` → folded into
  `stat_data` via the existing write-back ([generationService.ts:420](../../../src/main/services/generationService.ts)).

**Commit:** `feat(combat): AI touchpoints — combat-start tag, adjudication, narration, MVU fold-out`

## Phase 7 (P7) — `combat` bundle schema + 命定之诗 content + SDK docs

**Files:** **edit:** `character.ts` (tighten `combat` into `CombatBundleSchema`, design §10),
`characterService.ts` (import gating/summary), `docs/sdk/component-inventory.md` + `docs/rpt-api.md`
(the card-facing contract — required in the same change), author 命定之诗's templates/abilities/
bestiary/maps/skin.

**Commit:** `feat(combat): combat bundle schema + 命定之诗 content; docs(sdk): combat contract`

## Phase 8 (P8) — Tactical depth + polish

LoS rays + cover, opportunity attacks, reactions, flanking, a fuller conditions library, the hex-grid
option, smarter weighted policy. Each its own small commit.

---

## Decisions locked before P1 (owner, 2026-06-25)

- **Party scope: multi-member party.** The player commands several party members each turn; the core
  models a list on either side (`Combatant.side: 'party'|'enemy'`) from the start, and the P5 action bar
  cycles members. No extra P1–P3 core cost.
- **Initiative: d20 round-robin.** Every combatant rolls `d20 + DEX-mod` once; one shared initiative
  order interleaves party and enemies (P2 `rollInitiative`).

Everything else (`<rpt-combat-start>` grammar, AI-supplied stats vs templates, death stakes, map source,
`ai`-controller batching) is downstream of P4 and parked in [combat-system-design.md](../../combat-system-design.md) §14.
