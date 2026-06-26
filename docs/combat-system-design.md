# Local Grid Combat System — Design

Status: **Built (2026-06-25) — branch `feat/combat-system`, P1–P7 + P8-partial; 71 combat unit
tests.** The deep-dive for the agentic track's **Phase I** ("deterministic combat math in a worker
sandbox", [agentic-mode-design.md](agentic-mode-design.md) §8) and the **native Combat view** reserved
by [mvu-panel-workspace-design.md](mvu-panel-workspace-design.md). Implementation + per-phase status:
[plans/2026-06-25-combat-system.md](superpowers/plans/2026-06-25-combat-system.md). The SDK surface a
card authors against is enumerated in [sdk/component-inventory.md](sdk/component-inventory.md) §8a and
[rpt-api.md](rpt-api.md) §4 (Combat).

**As-built deltas from this design (the doc below is the intent; the plan records the rest):**

1. **The override seam is ONE coarse `resolveAction` hook** (whole-action override), not the granular
   `resolveAttack`/`applyDamage`/… hooks in §5 — those names are reserved in `shared/combat/hooks.ts`
   `HookName` as a forward-compatible refinement.
2. **The encounter persists in a new `combat_encounters` table** (one serialized `EncounterRecord` per
   chat), **not** `rpg_entities` (which stays unused) — §7's "ephemeral, in rpg_entities" is superseded.
3. **Per-action RNG derives from `(seed, rngCursor)`** (a `rngCursor` field on `CombatState`) so a fight
   is deterministic AND resumes after an app restart without persisting live RNG state.
4. **P8 partial:** line-of-sight + stunned/restrained/prone condition mechanics shipped; cover,
   opportunity attacks/reactions, flanking, and the hex grid remain deferred.

Motivating world: **命定之诗** (a World Card; MVU JSON-Patch dialect). The system is built generic —
any world opts in by shipping a `combat` bundle — and does **not** require a world to retrofit its
`stat_data`.

---

## 0. The decisions that shape everything (locked with the owner, 2026-06-25)

1. **Combat is a game the player plays — not an auto-simulation.** The player makes their party's
   decisions turn by turn on a grid. The engine resolves every die deterministically; it never
   decides the player's moves and never "plays out the fight" on its own.
2. **Enemies are driven by a pluggable controller:** a native **weighted decision policy**
   (default — fast, free, deterministic) **or** the **AI** (richer, costs a call; batched per
   round). The AI is otherwise only a **narrator + referee**, never the source of numbers.
3. **Rules authority is hybrid, with a real card-override seam.** RP Terminal ships a native lean
   d20 core; a world's `combat.scripts` can **override or extend** specific resolver hooks (or
   replace the resolver) through one documented contract — "native support for a card-authored
   engine."
4. **The combat stat block is fresh + ephemeral.** Because 命定之诗 (and most worlds) carry no
   combat-ready stats, the block is **built at encounter start** (card templates / AI-supplied
   stats) and **discarded at the end**. Only narrative **consequences** (injuries, death, spent
   resources, loot) fold back into the persistent `stat_data`.
5. **Lean grid first.** v1 = positions, movement, range, AoE shapes, basic conditions. Line-of-
   sight, cover, opportunity attacks, reactions, flanking are a later phase.

---

## 1. Where this sits — most of the substrate already exists

This is not greenfield. The combat track is "build out Phase I richly + add a grid + a native
view." Reused, not invented:

| Need                                     | Already in the codebase                                                                                   | File                                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic dice/math engine           | `runScript` — quickjs WASM sandbox, **seeded mulberry32 RNG**, `emit`/`log` collectors, hard timeout/kill | [sandboxRunner.ts](../src/main/services/sandboxRunner.ts)                                                                                                                                              |
| Off-thread harness + in-process fallback | the worker entry + service wrapper around the same core                                                   | [sandboxWorker.ts](../src/main/workers/sandboxWorker.ts), [sandboxService.ts](../src/main/services/sandboxService.ts)                                                                                  |
| Combatant storage                        | `rpg_entities` (per-chat: `id / name / data TEXT`) — created, unused                                      | [db.ts:70](../src/main/services/db.ts)                                                                                                                                                                 |
| Persistent world state + write-path      | `stat_data` MVU tree; `<UpdateVariable>` / `<JSONPatch>` folded by the clean-room parser                  | [mvuParser.ts](../src/main/parsers/mvuParser.ts)                                                                                                                                                       |
| Combat-mode UI swap                      | per-FSM-mode workspace layouts; views resolved via a registry                                             | [workspaceStore.ts](../src/renderer/src/stores/workspaceStore.ts), [viewRegistry.tsx](../src/renderer/src/components/workspace/viewRegistry.tsx), [layoutDefaults.ts](../src/shared/layoutDefaults.ts) |
| AI ⇄ engine transport                    | `<rpt-action>` / `<rpt-result>` tags + L4-append cache discipline                                         | [agentic-mode-design.md](agentic-mode-design.md) §4–8                                                                                                                                                  |
| Action/event parse + state fold          | `<rpt-event>` parser; `applyEvent` fold in `generate()`                                                   | [contentParser.ts](../src/main/parsers/contentParser.ts), [generationService.ts](../src/main/services/generationService.ts)                                                                            |
| Per-mode system prompt addendum          | `composeAddendum` (`agent.prompts[mode]`, e.g. `combat`)                                                  | [generationService.ts:44](../src/main/services/generationService.ts)                                                                                                                                   |
| Card bundle slot                         | `extensions.rp_terminal.combat` (loose `z.record`, reserved)                                              | [character.ts:103](../src/main/types/character.ts)                                                                                                                                                     |

The genuinely new work: the **`CombatState` model + grid math**, the **native d20 resolver + the
card-override hook contract**, the **enemy controllers**, the **native `CombatView`**, the
**`CombatState` ⇄ prompt serializer**, and the **`combat` bundle schema**.

---

## 2. Core principle — STATE / LOGIC / VIEW stay separate

Inherited from [mvu-panel-workspace-design.md](mvu-panel-workspace-design.md); it is what lets a
native engine and AI narration coexist over the same world.

- **STATE** — a per-encounter **`CombatState`** (grid, combatants, positions, initiative, turn,
  log) persisted in `rpg_entities`. **Ephemeral**, distinct from `stat_data`.
- **LOGIC** — a **native deterministic d20 engine** that runs in `sandboxRunner` (seeded). It owns
  every number. Card scripts plug in through one hook contract (§5).
- **VIEW** — a **native `CombatView`** registered in `viewRegistry`. **Not a card WCV** — combat is
  the native game-engine target; the card supplies content + skin, never the renderer.

`stat_data` is the persistent world ledger; `CombatState` is the scratch space for one fight.

---

## 3. The combat loop (the two AI touchpoints)

```
RP Session (free chat)
   │  AI emits <rpt-combat-start enemies="…" map="…"> ⚔   → "Enter Combat" button in the message
   ▼
Setup: build a FRESH combat block (card templates / AI-supplied stats) + place tokens on the grid
   ▼
┌───────────────────────────── Played Tactical Game ─────────────────────────────┐
│  the engine resolves EVERY d20 in the seeded sandbox · records a combat log     │
│                                                                                 │
│   Player turn  ──round──▶  Enemy turn                                           │
│   (move/attack/            (controller picks an action, then the engine          │
│    ability on grid)         resolves it)  ── controller = weighted | ai          │
│        ▲                         │                                              │
│        └─────────── round ───────┘                                              │
└───────┬─────────────────────────────────────────────────────┬─────────────────┘
        │ mid-fight: out-of-system action                       │ combat ends
        ▼                                                       ▼
  Improvise: snapshot + player prose                     Combat log → narration prompt
   → adjudication prompt → AI returns result              → AI "describes the fight fully"
   → fold into CombatState → CONTINUE                       (prose over verified numbers)
                                                              ▼
                                       fold CONSEQUENCES (injuries/death/loot) → stat_data (MVU)
                                                              ▼
                                                          resume RP
```

- **No "auto-resolve everything" path.** The player always plays. "The AI describes the combat
  process fully" = the **end-of-combat narration**: the engine's recorded log → a prompt → the AI
  writes the prose account of numbers that already happened.
- **Improvise** is the mid-fight referee path: when the player wants something the engine can't
  model, the engine snapshots `CombatState` + their prose into an **adjudication prompt**; the AI
  returns a narrative **plus** a structured `<rpt-result>` (effect: damage/positions/conditions)
  that folds back into `CombatState`, and combat continues.
- **Cache-safe by construction:** every AI touchpoint only **appends at L4** (the volatile tail);
  the cached L1–L3 prefix never moves. This is the one hard constraint that touches every phase
  ([agentic-mode-design.md](agentic-mode-design.md) §11).

---

## 4. The grid (lean v1)

- **Square grid** (hex deferred), each cell = a fixed in-world distance (5 ft default).
- **Occupancy** — a combatant occupies one cell (large creatures span an N×N footprint).
- **Movement** — `speed` in cells; BFS/Dijkstra pathfinding over passable cells; difficult terrain
  = a cost multiplier.
- **Targeting (this is "the grid allows range / AoE"):**
  - **Range** — distance check (Chebyshev for square) from origin to target cell.
  - **AoE templates** — each ability declares a shape; the engine computes affected cells and
    auto-collects targets, and the view previews the template on hover before commit:
    - `burst` (radius r), `line` (length × width), `cone` (origin + length), `self` / `aura`.
  - **Terrain layer** — per-cell flags `{ passable, blocksLoS, difficult, hazard }`. The encounter
    supplies a map; default is an open field of a chosen size.
- **Deferred to a later phase:** line-of-sight rays, cover modifiers, opportunity attacks,
  reactions, flanking.

---

## 5. The engine — native default, card-overridable (the resolver seam)

One contract, run in `sandboxRunner` (seeded → deterministic, reproducible, unit-testable):

```ts
// host → sandbox
resolve(state: CombatState, action: Action, seed: number)
  => { events: CombatEvent[]; newState: CombatState }
```

- **Native resolver (`rpt-d20-v1`)** — the built-in d20 core: `d20 + mod vs DC` for attack-vs-AC,
  saving throws, and ability checks; advantage/disadvantage (2d20 high/low); crit on natural 20
  (double damage dice); typed damage with resist/vulnerable; dice expressions (`2d6+STR`); a small
  conditions registry (prone/stunned/poisoned/…) with durations + per-turn hooks.
- **Card-authored resolver** — a world's `combat.scripts` may **override or extend** named hooks, or
  replace the resolver wholesale. Same sandbox, same seeded RNG, same `events`-out shape, so
  determinism + cache discipline hold no matter who wrote the logic. Proposed hook names (v1):

  | Hook                                                | When                              | Default                  |
  | --------------------------------------------------- | --------------------------------- | ------------------------ |
  | `seedCombatant(template, ctx)`                      | building the fresh block at setup | native template fill     |
  | `onTurnStart(state, id)` / `onTurnEnd(state, id)`   | turn boundaries                   | tick conditions          |
  | `resolveAttack(state, action)`                      | an attack/ability action          | native d20-vs-AC         |
  | `applyDamage(state, target, dmg)`                   | after a hit                       | native typed-damage math |
  | `enemyPolicy(state, id) → Action`                   | an enemy decision point           | the weighted policy (§6) |
  | `checkVictory(state) → 'player' \| 'enemy' \| null` | after each action                 | all-one-side-down        |

  A world gets native rules for free and reaches for scripts only where it is special.

- **All RNG is seeded** off the encounter seed (mirrors the injectable `rng` already used for lore
  `probability`). The LLM never produces a die.

---

## 6. Enemy controllers (pluggable)

Because combat is player-played, _something_ must drive the enemies. Two implementations behind one
`enemyPolicy` interface:

- **`weighted` (native, default)** — each enemy scores its legal actions on a small weight set
  (threat / kill-secure / positioning / range-or-AoE value / self-preservation) and takes the
  top-weighted one. Runs in the sandbox; **zero AI calls**; reproducible.
- **`ai`** — the model chooses enemy actions from the **legal action set the engine offers**
  (the model can't invent illegal moves or numbers). To control cost, **batch all enemy decisions
  for a round into one `<rpt-action>` round-trip**, not one call per enemy.

The controller is chosen per encounter (card default + a user toggle). The weighted policy is the
baseline so a fight needs no network at all.

---

## 7. State: the fresh combat block + the persistence boundary

- **Snapshot in (setup):** the `stat_map` is a **derivation**, not a mapping of existing vars. Each
  combatant gets a **fresh** block (HP, AC, speed, ability mods, abilities) from **card class/role
  templates** and/or **AI-supplied stats** carried on the `<rpt-combat-start>` signal (e.g. the AI
  states "3 哥布林, 弱" → the engine seeds from the bestiary template). The block lives only in
  `rpg_entities`.
- **Fold out (end):** combat **never writes `stat_data` directly.** It produces a structured
  outcome (HP → a wounded/injury state, deaths, items/resources spent, loot/XP) that the **AI**
  emits as the canonical `<UpdateVariable>` / `<JSONPatch>` fold — preserving the world's existing
  single MVU write-path. The combat block itself is **discarded**; the persistent world only learns
  the narrative result, never that an "AC stat" existed.

This decoupling is what lets any world opt into combat without retrofitting its variable schema.

---

## 8. Detecting combat & the "Enter Combat" affordance

- The world's preset/agent prompt instructs the model: when a scene turns to combat, emit a
  `<rpt-combat-start>` tag (the `<rpt-action>` family) naming the enemies / map, e.g.

  ```
  <rpt-combat-start enemies="哥布林 x3 (弱); 哥布林头目" map="forest_clearing"></rpt-combat-start>
  ```

- `contentParser` intercepts it and renders an **"⚔ Enter Combat" button** in the message
  (alongside the narration). Clicking opens encounter setup (§7) → the grid. If the player ignores
  it, it degrades to plain text — no forced combat.
- A manual **"Start Combat"** button is also available when the session is in Combat mode, for
  player-initiated fights with no AI signal.

---

## 9. UI — the native `CombatView`

- A new **`combat`** view registered in [viewRegistry.tsx](../src/renderer/src/components/workspace/viewRegistry.tsx);
  entering Combat mode swaps the workspace to a combat layout (grid center · initiative tracker ·
  action bar with AoE preview · combat log · narrow chat) — the per-mode layout machinery already
  exists ([workspaceStore.ts](../src/renderer/src/stores/workspaceStore.ts)).
- **Card skinning:** the `combat.skin` slot supplies token art, tile art, ability icons, and themed
  `--rpt-*` CSS tokens so 命定之诗 combat _looks_ like 命定之诗 — but the engine and renderer are
  native. App UI strings route through `t()` (en/zh), per the i18n rule in `CLAUDE.md`.

---

## 10. The `combat` bundle (the card-facing data contract)

Fills the reserved `extensions.rp_terminal.combat` slot ([character.ts:103](../src/main/types/character.ts)).
Imports through the existing lossless World-Card importer ([world-card-design.md](world-card-design.md))
and runs under the existing per-card permission + sandbox model.

```jsonc
"combat": {
  "ruleset": "rpt-d20-v1",                    // which native core (or "custom" → fully script-driven)
  "grid":   { "type": "square", "cell_ft": 5 },
  "enemy_controller": "weighted",             // default; user can switch to "ai" per encounter
  "stat_map": {                               // DERIVATION for the fresh block (not existing vars)
    "templates": { "warrior": { "hp": "2d10+CON", "ac": 14, "speed": 6, "abilities": ["slash"] } },
    "consequences": { "hp_to": "主角.状态.受伤", "death": "主角.状态.存活" }  // → stat_data on fold-out
  },
  "abilities": [
    { "id": "slash", "name": "斩击", "range": 1, "shape": { "kind": "self" },
      "to_hit": "STR", "damage": "1d8+STR", "save": null, "effects": [] },
    { "id": "fireball", "name": "火球", "range": 8, "shape": { "kind": "burst", "r": 2 },
      "to_hit": null, "save": { "ability": "DEX", "dc": 14 }, "damage": "6d6", "effects": ["burning"] }
  ],
  "bestiary": [
    { "id": "goblin", "name": "哥布林", "tier": "弱",
      "block": { "hp": 12, "ac": 13, "speed": 6 }, "abilities": ["slash"], "policy": "melee" }
  ],
  "maps":    [ { "id": "forest_clearing", "w": 12, "h": 10, "tiles": "…", "spawns": [] } ],
  "scripts": [ "…sandboxed resolver-hook overrides (§5)…" ],
  "skin":    { "tokens": {}, "tiles": {}, "icons": {}, "css": "" }
}
```

> **SDK-docs obligation (when this is built):** the `combat` slot is a card-facing surface, so per
> `CLAUDE.md` and [sdk/README.md](sdk/README.md) the _implementation_ change must update
> [sdk/component-inventory.md](sdk/component-inventory.md) (§4 format) and `rpt-api.md` (any new
> runtime API, e.g. `registerScriptPanel`-style combat hooks) **in the same change**. This design
> doc does **not** edit `docs/sdk/` (nothing is built yet).

---

## 11. Cache discipline (Phase G interplay)

Every AI touchpoint obeys the L1–L4 layering ([agentic-mode-design.md](agentic-mode-design.md) §11):

- Combat-mode L2 (world info) is matched **on the mode transition** and held stable for the fight.
- The combat-start tag, `<rpt-result>` adjudications, the per-round enemy-decision call, and the
  end-of-combat narration block **all append at L4** — the cached prefix is never edited mid-fight.
- The whole encounter is **seeded**, so a "re-evaluate" replay reproduces the same fight.

---

## 12. Phased build order (each slice shippable)

| Phase                                       | Deliverable                                                                                                                                                                                 | Reuses                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **C1 — Engine core + resolver seam**        | `CombatState`; the `resolve(state, action, seed) → events` contract; native d20 resolver; the card-override hooks (§5); `rpg_entities` wiring. Headless, unit-tested deterministic.         | `sandboxRunner`, `rpg_entities`            |
| **C2 — Grid (lean)**                        | occupancy, movement/pathfinding, range, AoE templates, terrain flags. Headless + tested.                                                                                                    | C1                                         |
| **C3 — Enemy controllers**                  | the native `weighted` policy + the `ai` policy (batched per round).                                                                                                                         | C1, `<rpt-action>`                         |
| **C4 — Native `CombatView`**                | grid UI, initiative tracker, action bar + AoE preview, the **Improvise** affordance, combat log; Combat-mode layout.                                                                        | `viewRegistry`, `workspaceStore`           |
| **C5 — AI touchpoints**                     | the `CombatState` ⇄ prompt serializer; end-of-combat narration prompt + mid-combat adjudication prompt; consequence fold-out via MVU; the `<rpt-combat-start>` tag + "Enter Combat" button. | `contentParser`, `mvuParser`, `generate()` |
| **C6 — `combat` bundle + 命定之诗 content** | the bundle schema + importer/permission gating; author 命定之诗's templates, abilities, bestiary, maps, skin. **+ update `docs/sdk/` (§10).**                                               | World-Card importer                        |
| **C7 — Tactical depth + polish**            | LoS, cover, opportunity attacks, reactions, the conditions library, hex option, smarter weighted policy.                                                                                    | C1–C6                                      |

**Recommended first milestone: C1 + C2 + C3 headless** (a fully testable deterministic tactical
engine with no UI), then **C4** makes it playable.

---

## 13. Licensing / clean-room

- The combat engine is **native + clean-room**; no js-slash-runner / TavernHelper code (AFPL,
  non-free) is copied. The MVU fold-out uses the project's existing clean-room `mvuParser`.
- Bundled `combat.scripts` are **untrusted third-party code** → run only in the quickjs worker
  sandbox, behind the existing per-card permission model (same posture as
  [world-card-design.md](world-card-design.md) §11).

---

## 14. Open questions (resolve as the spec firms up)

1. **Party scope** — does the player control a single PC or a multi-member party on the grid? (Drives
   the action bar + turn UI.)
2. **`<rpt-combat-start>` schema** — free-text enemy descriptors the engine maps to bestiary tiers,
   vs a strict id+count grammar. (Lean: tolerant descriptors with a bestiary fallback.)
3. **AI-supplied stats vs templates** — when the AI names an off-bestiary enemy, does it supply a
   stat block inline, or does the engine synthesize one from a tier keyword? (Lean: tier keyword →
   template, AI may override fields.)
4. **Death stakes** — are downed PCs revivable mid-fight, and is death permanent on fold-out? (A
   `consequences` policy in the bundle.)
5. **`ai` enemy controller cost** — one batched call per round (recommended) vs per-decision; and
   whether the weighted policy should _advise_ the AI to cut tokens.
6. **Initiative model** — strict d20-initiative round-robin vs side-based (all players, then all
   enemies). (Lean: d20 round-robin.)
7. **Map source** — card-authored maps only, vs an AI-described layout the engine rasterizes at
   setup. (Lean: card maps first; AI layout later.)

---

## 15. UI design — the native `CombatView` (locked 2026-06-25)

The combat UI is a **clean, tokenized VTT** that stays a **docked workspace panel** (the Combat-mode
layout `chat | combat | status`) with a **focus toggle** that enlarges the grid within the panel; the
reserved `combat.skin` slot layers card art on top per world. Native engine owns the numbers; this is
the view over it. (Owner-locked: docked + focus, clean-native-skinnable.)

**Regions (one panel):** ① **stage** (the grid) · ② **turn-order strip** (initiative avatars across the
top; current ringed, downed struck-through+dimmed) · ③ **side rail** (active/inspected unit card —
name · HP bar · condition pills · resources — over the combat log) · ④ **action bar** (Move + ability
buttons `icon · name · range`, Improvise, End turn).

**Highlight vocabulary (fixed, with a legend) → combat tokens** (added to `index.css`, `color-mix`'d
off the active theme's accent/warning/danger so they follow theming):
`--rpt-combat-reach` (reachable, accent wash), `--rpt-combat-aoe` / `--rpt-combat-aoe-strong` (range /
live AoE preview, warning wash), `--rpt-combat-threat` (danger wash, for later OA), `--rpt-combat-grid`
(grid lines). Tokens are **shape+color+label** (party = `--rpt-accent`, enemy = `--rpt-danger`, 2-char
initials, HP underbar) — never color alone (colorblind-safe). This also fixes the P5 stray
`--rpt-bg` / `--rpt-accent-soft` references (they only worked via CSS fallbacks).

**Interaction state machine:** `idle → select(action) → target(hover-preview) → confirm → resolve`.
Selecting an ability lights in-range cells; hovering paints the AoE template + rings auto-collected
targets before commit. **Esc / re-clicking the active action cancels.** Illegal clicks are inert (no
log spam — a P5 papercut). Clicking a unit while idle **inspects** it (its stats fill the side card).

**Turn feedback:** the engine's structured events drive HP-bar tweens, condition pills, a death fade +
strike-through, and round dividers in the log. While automated combatants act the bar is replaced by a
quiet **"Enemies acting…"** state; during Improvise it shows **"The referee is deciding…"**.

**End-of-combat:** a resolution card over the stage — outcome (winner · rounds) + **Narrate the fight**
(AI prose) and **Return to story** (fold consequences via MVU, clear, restore the prior mode).

**Accessibility:** arrow keys move the cell cursor, `1–9` pick abilities, `Enter` confirms, `Esc`
cancels; the strip + log are ARIA live regions.

**Debug mock scene (until the lorebook/AI side lands):** `combatService.mockEncounterSetup()` builds a
hardcoded encounter (2-member party with melee/ranged/AoE abilities + 3 weighted goblins on a 10×8 map
with a wall + difficult terrain); `startMockEncounter` / the `combat-start-mock` IPC / a **"Start mock
battle (debug)"** button in the empty `CombatView` let the whole loop (move → attack → AoE → enemy
turns → end) be played in-app with no AI cue or `combat` bundle.

**As-built UI follow-up (2026-06-25):**

- **Animation** — tokens render in an overlay above a static cell layer and **slide** via a CSS
  `transform` transition; HP bars **tween**; floating **−N / "miss"** numbers rise + fade over targets
  (`--rpt-combat-float`), driven by `combatStore.lastEvents` + `eventSeq`. Enemy auto-turns are **paced
  (~380 ms)** so each is visible — no more teleporting / instant damage.
- **Presentation** — the header toggle opens a **pop-out overlay** (React portal, ~`min(1100px,92vw) ×
  88vh`, dim backdrop) for cramped docked panels, rather than only enlarging the grid in-panel.
- **Narration placement + steering** — "Narrate the fight" sends the request and lands the prose in the
  **chat**: appended to the current floor **or** as a **new floor**, per `settings.combat.narrationMode`
  (user) or the card's `combat.narration_mode`. An optional steering prompt
  (`settings.combat.narrationPrompt` / card `combat.narration_prompt`) folds into
  `buildNarrationPrompt(state, extra)`; the narration's `<UpdateVariable>` consequences fold into that
  floor's `stat_data`. A **Combat** section in `SettingsPanel` exposes the user-side controls.

**Rules, controls & deferrals (2026-06-25, owner-decided):**

- **Action economy** — each combatant gets **one movement, one attack, one action** per turn
  (`CombatState.turnUsed`, reset on turn start). An ability's slot = `abilityCost(ab)` (attack-roll →
  attack, else action; card-overridable via `AbilityDef.cost`). Enforced in `applyAction`; the
  CombatView shows Move/Attack/Action budget chips and disables spent slots.
- **Line of sight** — abilities with `AbilityDef.requiresLoS` (e.g. ranged shots) are blocked by
  `blocksLoS` terrain (Bresenham `lineOfSight`: a range gate + a per-target filter); lobbed AoE leaves
  it false and arcs over walls. The CombatView only lights LoS-clear target cells.
- **Freeform actions + mid-fight exit** — the Improvise box is the input for actions the grid can't
  model, *including leaving the fight*. It has its **own steering prompt** (user
  `settings.combat.improvisePrompt` or card `combat.improvise_prompt` → `buildAdjudicationPrompt`'s
  `extra`). The AI may return `"end": true` in `<rpt-combat-result>` to conclude/escape combat → the
  prose lands in the chat (append / new floor) and the encounter clears, returning to Explore.
- **Controls: mouse-only for now.** Keyboard targeting (arrow-key cursor / number-key abilities) is
  **deferred**; only `Esc` / re-click cancel exists.
- **Tactical depth is script-authored, deferred (design decision).** Cover, opportunity attacks,
  reactions, flanking, and an extended conditions library are **NOT** baked into the native engine —
  they are delivered by **combat scripts that ship with a world or are installed by the player**, via
  the card-override hook seam (`combat.scripts`; today the coarse `resolveAction` hook, the granular
  hooks reserved). The native engine stays lean (grid · d20 · move/attack/action · LoS · base
  conditions). Deferred for now.
- **AI enemy controller deferred (design decision).** Enemies use the native weighted policy. The `ai`
  controller scaffold (`aiChooser` + `buildEnemyPrompt`) exists but is dormant (only a combatant with
  `controller:'ai'` triggers it) and is **not yet wired for production**. When built it will need its
  **own prompt, player- or world-provided** — the third combat prompt alongside narration and
  improvise — and the per-round batching from §0. Deferred for now.
