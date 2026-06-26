# RP Terminal — Structural & Maintainability Review (2026-06-26)

_Read-only diagnostic + prioritization. Scope: whole-codebase structural review — overengineering,
over-complexity, duplication/drift, leaky abstractions, premature optimization, speculative generality,
dead code, inconsistency. No runtime behavior was changed; the only edits made for this review are this
file, the companion plan ([maintainability-plan-2026-06-26.md](maintainability-plan-2026-06-26.md)), and a
memory note._

_Builds on [codebase-health-check-2026-06-24.md](codebase-health-check-2026-06-24.md) and
[maintainability-plan.md](maintainability-plan.md) (2026-06-22). Treats those as the baseline and flags
what is now **stale** (the dual-card-host concern) and what is **newly accreted** (combat, the write-back
loop guard, the EJS context drift)._

> **Convention:** point-in-time snapshot. Do not silently rewrite; supersede with a newer dated file. The
> actionable treatment plan derived from this is
> [maintainability-plan-2026-06-26.md](maintainability-plan-2026-06-26.md).

---

## Verdict: **HEALTHY core, with a shifted headline and fresh sediment**

The `Host`-seam refactor (`shared/thRuntime` + inline `cardBridge` + WCV `wcvHost`, both implementing
`Host`) **resolved** the "two parallel TavernHelper implementations" that the 2026-06-22 plan called the
biggest risk — that finding is now **stale**. The single-runtime / two-transports design is the strongest
decision in the codebase. Test coverage on the cores is real.

The headline weak spot has **moved**: the EJS *engine* is now shared, but its execution *context* is
hand-rebuilt three different ways with divergent variable shaping, so the same card EJS expression resolves
differently depending on where it runs. That, not the engine, is the real card-compat liability. New
feature work (combat, the poem expansion, the variable write-back loop) has added a few well-bounded
over-builds and one heuristic band-aid the team already flagged as tech debt.

The three highest-leverage moves:
1. **Unify the EJS context builder** (WS-1) — one shared `buildTemplateContext` so build/render/WCV agree.
2. **De-escalate the L1 "Frozen Core" cache layering** (WS-2) — default-off, unvalidated, threads
   speculative `partition`/`diff` complexity through the hottest function.
3. **Fix the variable write-back loop at the source** (WS-3) — tag change origin, retire the heuristic.

---

## Priority ranking (severity × work order)

Priorities fold **severity** (correctness / card-compat breadth) together with **work order** (a
foundational change that others build on is elevated). The detailed, sequenced treatment is in the plan
doc.

| Pr | ID | Change | Why this tier | Depends on |
| --- | --- | --- | --- | --- |
| **HIGH** | WS-1 | Unify the three EJS context builders into one `shared` builder | Keystone: highest card-compat win; WS-5/WS-2 build on it | WS-9 (recommended precursor) |
| **HIGH** | WS-3 | Variable write-back loop: tag change origin, retire the 25/400ms heuristic | High-severity correctness on the dominant MVU-card pattern | verification spike (real-MVU event semantics) |
| **MED** | WS-5 | Decompose `buildPrompt` (325 LOC) into named, testable steps | Maintainability of the compat heart; enabler for WS-2 | WS-1 |
| **MED** | WS-2 | De-escalate / collapse L1 Frozen Core cache layering | Removes speculative complexity from the hot path | WS-1, WS-5 |
| **MED** | WS-4 | Move the hand-rolled lodash/faker subset out of the engine string into a tested module | Silent-wrong-output risk; currently untyped/unlinted | none (parallel) |
| **MED** | WS-7 | One `broadcastHostEvent` helper; lift the App.tsx fan-out into a module | Transport-parity bug risk | none (parallel) |
| **LOW** | WS-6 | Delete unused DB schema (`rpg_entities`, `pending_lore`) | Reader confusion / migration noise only | none |
| **LOW** | WS-8 | Document the two path dialects (bracket-aware vs split-on-dot) + pin with a test | Documented trade-off; pin so it stays intentional | none |
| **LOW** | WS-9 | Write down the error-handling policy; reference it from the 4 sites | Documentation; cheap precursor that de-risks WS-1/WS-5 | none |

**Suggested execution order** (cheap derisking first, then the keystone, then what builds on it):

```
WS-9 (error policy doc)  ┐  quick, no-behavior, derisks WS-1/WS-5
WS-6 (delete dead schema)├─ quick wins, independent, parallelizable
WS-8 (path dialects doc) │
WS-7 (broadcast helper)  ┘
        │
WS-1 (unify EJS context) ── keystone refactor (after WS-9)
WS-4 (lodash → module)   ── independent, parallel to WS-1
        │
WS-5 (decompose buildPrompt) ── after WS-1
WS-2 (cache decision)        ── after/with WS-5
        │
WS-3 (write-back loop) ── verification spike anytime; impl is its own track
```

---

## Findings

Each: **location** · **what's wrong** · **category** · **blast radius** · **recommendation** (small fix
vs architectural).

### WS-1 — Three divergent EJS context builders for one shared engine `[HIGH]`
- **Location:** build-time [generationService.ts:208-245](../src/main/services/generationService.ts);
  render-time [renderTemplate.ts:15-34](../src/renderer/src/plugin/renderTemplate.ts); WCV
  [wcvPreload.ts:212-223](../src/preload/wcvPreload.ts). Engine: [templateEngine.ts:388](../src/shared/templateEngine.ts).
- **What's wrong:** the engine was unified but each caller builds its own `TemplateContext` with different
  semantics:
  - **`vars` shape:** build-time passes `workingVars` **un-hoisted** (`getvar('stat_data.主角')` works,
    `getvar('主角')` does not); render-time and WCV **hoist** stat_data to root (both forms work).
  - **`globals`:** build-time wires real per-profile globals; render-time and WCV pass `globals: {}`, so
    `getglobalvar()`/`getGlobalVar()` silently return empty at display/WCV time.
  - **`constants`:** build-time exposes `userName/charName/lastUserMessage/chatId/characterId/runType/
    lastMessageId/…`; render-time exposes only `userName/charName`; WCV only what's passed in. A card EJS
    referencing `runType`/`chatId` evaluates in the prompt and to `undefined` on screen.
- **Category:** duplication / inconsistency (semantic drift).
- **Blast radius:** every card using ST-Prompt-Template EJS in both a prompt entry and a display/`[RENDER]`
  context — the central supported stack. Most likely future source of "works in prompt, broken in panel."
- **Recommendation (architectural, contained):** extract one `buildTemplateContext(vars, opts)` in
  `src/shared`; fix the vars-hoisting rule and the constants set once; callers feed realm-specific data
  (globals, message list) via params. Pin the agreed shape with a test. **Update SDK docs** (the EJS surface
  is card-facing).

### WS-2 — L1 "Frozen Core" prompt-cache layering is premature optimization in the hot path `[MED]`
- **Location:** [cacheLayers.ts](../src/main/services/cacheLayers.ts); consumed at
  [promptBuilder.ts:285-294](../src/main/services/promptBuilder.ts) (frozen-vars frontier render),
  [promptBuilder.ts:570-576](../src/main/services/promptBuilder.ts) (`buildStateBlock` tail),
  [generationService.ts:140-143](../src/main/services/generationService.ts) (`frozenVarsFor`).
- **What's wrong:** a whole sub-system (frozen floor-0 snapshot, `partition` vs `diff` placeholderization,
  relocated live-state tail) exists to make the prefix byte-stable for provider caches, but it is
  **default-off** (`settings.cache?.level ?? 0`) and unvalidated against real OpenAI/Anthropic cache
  behavior (the meter measures a *proxy* stable-prefix %, not provider hits). It forks `buildPrompt`'s
  rendering (`frontierTemplate` re-points `vars` at `frozenVars`), entangling with WS-1, and adds a second
  state representation the model sees (`[Current State]` tail).
- **Category:** premature-optimization / speculative-generality.
- **Blast radius:** maintenance tax on the most-changed function; raises the cost of WS-1's fix.
- **Recommendation (architectural):** keep the token/cache **meter** (legit feature); **collapse the two L1
  sub-modes to ≤1**, or gate the whole frozen path behind an explicit "experimental" flag with a written
  validation plan. If it can't beat plain append-only ordering on a real provider, retire it.

### WS-3 — Variable write-back loop contained by a guessed heuristic, not fixed at source `[HIGH]`
- **Location:** [generationService.ts:425-493](../src/main/services/generationService.ts) (`writeLoopGuard`,
  `LOOP_WINDOW_MS=400`, `LOOP_MAX=25`); echo paths [wcvManager.ts:276](../src/main/services/wcvManager.ts)
  (`notifyVarsChanged` exclude-sender) + [thRuntime/index.ts:55-83](../src/shared/thRuntime/index.ts)
  (byte-diff guard). Self-documented as tech debt in [progress-log.md (2026-06-26)](progress-log.md).
- **What's wrong:** a card writing a changing value on its own `mag_variable_update_ended` self-loops; the
  change is echoed back via **two** paths (direct WCV sibling broadcast + indirect floor-update →
  `wcv-broadcast-vars`). The defense drops a write after the same changed-path signature repeats 25× in
  400ms — thresholds the team itself calls guesses (a slower loop escapes; a legit rapid same-path animation
  is at risk).
- **Category:** shortsighted / misplaced-boundary (fix at the symptom, not the cause).
- **Blast radius:** any MVU/status card that chains init through its own update events (the dominant
  pattern) — both correctness (dropped writes) and the prompt-injection reads that depend on those vars.
- **Recommendation (architectural, gated):** tag the change **origin** (model-fold vs card-write)
  end-to-end and fire `mag_variable_update_*` only on model/external folds. **Prerequisite:** verify
  real-MVU event semantics (does a programmatic `insertOrAssignVariables` fire the update events?) — do that
  spike first.

### WS-4 — Hand-rolled lodash + faker subset (~130 lines) inside a JS string `[MED]`
- **Location:** [templateEngine.ts:239-369](../src/shared/templateEngine.ts) — the `boot` string
  reimplements ~70 lodash methods + faker, injected via `vm.evalCode`.
- **What's wrong:** a large, untyped reimplementation of a public lib embedded as a string literal → **no
  typecheck, no lint, no direct unit tests** (only indirect via `templateHelpers.test.ts`), maximizing
  drift risk against real lodash (e.g. `orderBy` is a "single-key ascending approximation").
- **Category:** over-complexity / duplication (vs the real lib).
- **Blast radius:** card display panels using `_` — silent wrong output if a method diverges. Bounded but
  real for the supported stack.
- **Recommendation (small→medium):** keep clean-room (sandbox + licensing require it), but move the
  lodash/faker source into a real `.ts` module bundled to a string at build time, so it gets typecheck +
  lint + targeted tests. Add methods with a test each; stop expanding reactively.

### WS-5 — `buildPrompt` is a 325-line orchestrator carrying every concern at once `[MED]`
- **Location:** [promptBuilder.ts:253-578](../src/main/services/promptBuilder.ts).
- **What's wrong:** one function does macro pre-pass, EJS strict-vs-graceful rendering, lorebook partition
  (regular/marker/forced/depth/render), preset iteration, ≥4 "safety-net" insertions each re-scanning for
  `convoStart`, depth-injection planning, `[GENERATE]`/`@INJECT` marker draining, and L1 tail relocation.
  `messages.findIndex(m => m.role !== 'system')` recurs 5× with subtly different splice logic.
- **Category:** over-complexity (low cohesion / long function).
- **Blast radius:** the heart of compatibility; its size makes every prompt-format change risky and
  entangles WS-1/WS-2.
- **Recommendation (architectural, incremental):** extract `partitionLore()`, `renderPresetBlocks()`,
  `applyInjectionMarkers()`, `applyCacheTail()`, each independently testable; characterization tests green
  at each step. No behavior change.

### WS-6 — Speculative DB schema with no readers `[LOW]`
- **Location:** [db.ts:70](../src/main/services/db.ts) `rpg_entities` (no reader; only a comment in
  `profileService`); [db.ts:51,130](../src/main/services/db.ts) `pending_lore` column (created+migrated,
  never used); [db.ts:84](../src/main/services/db.ts) `episodic_memory` (reserved per the episodic-memory
  plan).
- **What's wrong:** reserved tables/columns ship with zero consuming code — "just-in-case" surface that
  misleads readers + adds migration weight.
- **Category:** speculative-generality.
- **Blast radius:** low (reader confusion + migration noise).
- **Recommendation (small):** create tables with their feature (schema is created idempotently at
  startup — no cost to deferring). Drop `rpg_entities` + `pending_lore` now; keep `episodic_memory` only if
  its plan is imminent.

### WS-7 — Dual event/variable broadcast wiring duplicated at the App level `[MED]`
- **Location:** [App.tsx:47-120](../src/renderer/src/App.tsx) — every host event is emitted **twice**
  (`window.api.wcvBroadcastEvent(...)` for WCV cards **and** `emitCardHostEvent(...)` for inline cards);
  same for the streaming-token forward.
- **What's wrong:** the transport fan-out is hand-duplicated in a 70-line `useEffect` with 7 subscriptions;
  add a host event and you must remember both calls in both blocks.
- **Category:** duplication / misplaced-boundary (transport fan-out leaking into App).
- **Blast radius:** card event parity — an event wired to only one path silently breaks one transport.
- **Recommendation (small):** wrap the dual-broadcast in one `broadcastHostEvent(chatId, name, payload)`;
  move the chat-store subscriptions into an `initCardEventBridge()` module out of `App.tsx`.

### WS-8 — Path/clone helper proliferation persists (4–5 implementations) `[LOW]`
- **Location:** [objectPath.ts](../src/shared/objectPath.ts) (canonical, bracket-aware) vs
  [macros.ts:22-41](../src/shared/macros.ts) (split-on-dot) vs
  [thRuntime/index.ts:28-34](../src/shared/thRuntime/index.ts) (`getByPath`/`clone`) vs the `_.get`/`_.set`
  `__ks` split inside [templateEngine.ts:274-279](../src/shared/templateEngine.ts) vs `wcvPreload`
  getByPath/setByPath.
- **What's wrong:** Phase 2 (2026-06-22) consolidated the bracket-aware copies but deliberately left the
  split-on-dot variants ([objectPath.ts:5-8](../src/shared/objectPath.ts)). Two path *semantics* coexist;
  `a[0].b` works in some surfaces and not others.
- **Category:** duplication / inconsistency.
- **Blast radius:** medium — MVU paths with array indices behave differently across macro/EJS/runtime.
- **Recommendation (small):** don't force a semantics-changing merge. **Document the two intended path
  dialects** (which surfaces are bracket-aware) in one place + a test pinning each, so divergence is
  intentional, not incidental.

### WS-9 — Inconsistent error-handling philosophy across the template path `[LOW]`
- **Location:** [promptBuilder.ts:304-316](../src/main/services/promptBuilder.ts) preset EJS **throws /
  fails the turn**; [promptBuilder.ts:387-411](../src/main/services/promptBuilder.ts) lorebook EJS **strips
  tags, keeps prose**; [templateEngine.ts:392-394,416](../src/shared/templateEngine.ts) engine returns
  **`''` on eval error**, **strips** on disabled/uninitialized; [macros.ts:176](../src/shared/macros.ts)
  unknown macro **left verbatim**.
- **What's wrong:** four failure policies in one pipeline, each individually justified but with no single
  stated rule, so the next author re-derives "throw, strip, blank, or pass through?" per surface.
- **Category:** inconsistency.
- **Blast radius:** maintenance + predictability; occasionally user-visible (broken preset fails the turn;
  broken lore degrades).
- **Recommendation (small, doc-only):** write the policy down — *presets fail loud; card/lore content
  degrades gracefully; engine-off strips; unknown macros pass through* — and reference it from the four
  sites. Codifying existing behavior is enough.

---

## Per-file notes (the files each finding touches)

> "Specific notes to the files (code + doc) related to the problems." Use this as the change-surface map
> when executing the plan. **Bold** = primary change site.

**Code — main process**
- **`src/main/services/generationService.ts`** — WS-1 (build-time context `:208-245`), WS-3 (`writeLoopGuard`
  `:425-493`), WS-2 (`frozenVarsFor` wiring `:140-143`). Also the `agentic` stub `:118` (leave; documented).
- **`src/main/services/promptBuilder.ts`** — WS-5 (decompose `:253-578`), WS-2 (frozen frontier `:285-294`,
  cache tail `:570-576`), WS-9 (preset-throws `:304-316` vs lore-strips `:387-411`).
- **`src/main/services/cacheLayers.ts`** — WS-2 (the whole module; candidate to collapse/gate).
- **`src/main/services/db.ts`** — WS-6 (`rpg_entities` `:70`, `pending_lore` `:51`/`:130`; `episodic_memory`
  `:84` conditional).
- **`src/main/services/wcvManager.ts`** — WS-3 (`notifyVarsChanged` echo path `:276`).
- **`src/main/services/templateService.ts`** — WS-1 (main re-export surface; engine deps wiring).

**Code — shared**
- **`src/shared/templateEngine.ts`** — WS-4 (lodash/faker boot string `:239-369`), WS-1 (the
  `TemplateContext` type + the new `buildTemplateContext` home), WS-9 (engine error/strip policy
  `:388-428`), WS-8 (`_.get/_.set` `__ks` split `:274-279`).
- **`src/shared/thRuntime/index.ts`** — WS-3 (MVU event refire + byte-diff guard `:55-83`), WS-8
  (`getByPath`/`clone` `:28-34`).
- **`src/shared/objectPath.ts`** — WS-8 (canonical helpers; document the dialect split `:5-8`).
- **`src/shared/macros.ts`** — WS-8 (own `path`/`setPath` `:22-41`), WS-9 (unknown-macro pass-through `:176`).

**Code — renderer / preload**
- **`src/renderer/src/plugin/renderTemplate.ts`** — WS-1 (render-time context `:15-34`).
- **`src/preload/wcvPreload.ts`** — WS-1 (WCV `buildEjsCtx` `:212-223`), WS-8 (getByPath/setByPath).
- **`src/renderer/src/App.tsx`** — WS-7 (dual-broadcast `useEffect` `:47-120`).
- **`src/renderer/src/cardBridge/host.ts`** — WS-1 (inline host's `buildRenderContext` use `:250-257`).

**Docs (must move with the code per the SDK contract / point-in-time rules)**
- **`docs/sdk/component-inventory.md`** (§2 runtime API, §3 env) — WS-1 (EJS context/variable surface is
  card-facing → update in the same change), WS-4 (the injected `_`/faker is part of the env).
- **`docs/rpt-api.md`** (EJS surface section) — WS-1, WS-4 (the documented helper/variable surface).
- **`docs/prompt-cache-optimization-design.md`** — WS-2 (record the de-escalation / validation decision).
- **`docs/progress-log.md`** — WS-3 (supersede the band-aid note when the source fix lands), WS-2/WS-6
  (highlights).
- **`docs/maintainability-plan.md`** — superseded by the 2026-06-26 plan (add a pointer).
- **`docs/sdk/README.md`** "if you touch X, update Y" table — sanity-check it still matches after WS-1.

---

## Subsystem verdicts (A–J)

| Area | Verdict | Key issue |
| --- | --- | --- |
| **A. Card-compat runtime (EJS/TH/MVU)** | **REFACTOR** | WS-1 (3 divergent contexts) + WS-4 (lodash-in-string). Async/TH-in-prompt-EJS gap is correctly out-of-contract. |
| **B. Prompt construction & generation** | **WATCH/REFACTOR** | WS-5 (`buildPrompt` cohesion) + WS-2 (L1 speculative). `fitToBudget` two-path + `estimateTokens` heuristic are justified. |
| **C. Card import & format pipeline** | **SOLID** | Coherent `chara_card_v3`+`rp_terminal`; pure, tested parsers. No notable smell. |
| **D. Storage & data model** | **WATCH** | WS-6 (dead schema); `FloorFile` name implies files but floors are SQLite rows. Migrations sound. |
| **E. Plugin & script sandbox** | **WATCH** | Sandbox worker is clean/tested; concern is the *count* of execution surfaces overall (§ Simplification), not this module. |
| **F. Combat / game engine** | **WATCH (over-built for scope)** | ~2,850 LOC for a player-played, one-card system **not yet verified in-app**; `poemD20` (616) hints at speculative generality. Don't grow it until exercised live. |
| **G. WCV card-host & transports** | **SOLID** | `Host` seam gives real parity; off-screen/panel/inline WCVs are role-distinct, not copies. Echo paths feed WS-3. |
| **H. Renderer architecture** | **WATCH** | ~20 stores but most tiny + single-purpose; the smell is App.tsx broadcast wiring (WS-7), not store count. Card-frame variants are role-distinct. |
| **I. IPC surface & boundaries** | **WATCH** | 162 handlers (49 in `wcvIpc`); `check:deps` boundaries hold. `window.api` is a flat ~100-method grab-bag — consider namespacing. |
| **J. Cross-cutting** | **WATCH** | WS-8 (paths), WS-9 (error policy), WS-6 (schema); `agentic` stub is honest. `any` at bridge/IPC is deliberate; real risk is WS-4's untyped string. |

---

## Simplification candidates (delete / merge / unify)

1. **Three EJS context-builders → one** (WS-1). Highest-value unification.
2. **L1 cache dual-mode → one / experimental gate** (WS-2). Deletes `partition`/`diff`, `placeholderize`, a
   `buildPrompt` fork.
3. **`rpg_entities` + `pending_lore` → delete now** (WS-6).
4. **Dual host-event broadcast → one helper** (WS-7).
5. **Main loads quickjs twice** (`templateService` EJS + `sandboxRunner` combat/Zod) — could share one
   `QuickJSWASMModule`. Small, low priority.
6. **lodash/faker out of the engine string** (WS-4).

**Leave as-is (earns its keep / deliberate):** the `Host`-seam two-transport design; the pure sandbox
worker; the pure combat engine's *boundaries* (just not its size); `cardEnv.ts`; the JSON-vs-SQLite split;
API-key masking; the `agentic` placeholder.
