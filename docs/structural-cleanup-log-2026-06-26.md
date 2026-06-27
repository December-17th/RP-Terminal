# Structural Cleanup — Execution Log (2026-06-26)

_Traceability log for executing [maintainability-plan-2026-06-26.md](maintainability-plan-2026-06-26.md)
(diagnosis: [codebase-structural-review-2026-06-26.md](codebase-structural-review-2026-06-26.md)) on branch
`refactor/structural-cleanup-2026-06-26`._

> **How to read this.** Newest stage at the bottom of "Stages". Each stage records: what changed (files),
> why, the verification run, and the commit. Verification gate this session =
> `npm run typecheck && npm run lint && npm run test` (+ `npm run check:deps` once it exists — see Phase 0).

## Work schedule (status)

| #   | Phase                          | ID    | Pr    | Status                                                    | Commit                                           |
| --- | ------------------------------ | ----- | ----- | --------------------------------------------------------- | ------------------------------------------------ |
| 0   | Make module-boundary gate real | WS-10 | (pre) | ✅ done                                                   | `82d9c48`                                        |
| 0a  | Error-handling policy doc      | WS-9  | LOW   | ✅ done                                                   | `de140ff`                                        |
| 0b  | Delete dead DB schema          | WS-6  | LOW   | ✅ done                                                   | `663d337`                                        |
| 0c  | Document path dialects + test  | WS-8  | LOW   | ✅ done                                                   | `1b4ada8`                                        |
| 0d  | One broadcast helper           | WS-7  | MED   | ✅ done                                                   | (this commit)                                    |
| 1   | Unify EJS context (keystone)   | WS-1  | HIGH  | ✅ done                                                   | 1a `396cd13` · 1b `8061410` · 1c `(this commit)` |
| 2   | lodash/faker → tested module   | WS-4  | MED   | ✅ done (tests + module extract)                          | tests `705e745` · extract (this commit)          |
| 3   | Decompose buildPrompt          | WS-5  | MED   | ✅ done (preset-loop left by design)                      | inc1 `318f74f` · inc2 `(this commit)`            |
| 4   | Cache system — STASHED         | WS-2  | MED   | ✅ stashed + baseline default                             | gate `ebd67dc` · stash (this commit)             |
| 5   | Write-back loop (date clock)   | WS-3  | HIGH  | 🟡 guard hardened (date loop); architectural fix deferred | spike `24be4ba` · guard (this commit)            |

Status key: ⬜ todo · 🔄 in progress · ✅ done · ⏸ deferred (with reason).

## Baseline (start of session)

- Branch `refactor/structural-cleanup-2026-06-26` off `feat/poem-combat-extension` @ `9409bfe` (the
  planning-docs commit).
- `npm run typecheck` → ✅ passes (node + web).
- `npm run check:deps` → ❌ **script does not exist** (see Phase 0 / WS-10 — newly discovered drift:
  CLAUDE.md presents it as the enforced module-boundary gate, but there is no script, no
  `dependency-cruiser` dependency, and no config). Added as a Phase 0 prerequisite.
- `npm run test` → (run at Phase 0 baseline).

---

## Stages

<!-- append one entry per completed stage -->

### Stage 1 — Phase 0: module-boundary gate made real (WS-10) ✅

**Why (discovered drift).** CLAUDE.md presents `npm run check:deps` (dependency-cruiser) as the enforced
module-boundary gate, and the verification gate is documented as
`typecheck && check:deps && test`. In fact **none of it existed**: no `check:deps` script, no
`dependency-cruiser` dependency, no config. The architecture's load-bearing boundaries were unenforced.
Making this real first gives the later refactors (WS-1/WS-4/WS-7 move modules) automated cover.

**Changes.**

- `package.json` — added `dependency-cruiser` (devDep) + `"check:deps": "depcruise src --config
.dependency-cruiser.cjs"`.
- `.dependency-cruiser.cjs` (new) — encodes the CLAUDE.md boundaries as `error` rules: shared↛main/renderer,
  shared↛electron, renderer↛main, combat-engine-pure, transports-no-cross-import (both directions);
  `no-circular` as `warn` (informational). `tsPreCompilationDeps` so type-only crossings are caught too.
- `eslint.config.mjs` — added `**/.claude/**` to `ignores` (nested git worktrees were being linted, their
  `test/**` files missing the `test/**` rule override → spurious gate-reddening errors); added a `**/*.cjs`
  override (Node CJS scripts legitimately use `require()`/`module.exports`, no TS return types) — covers the
  new config + `docs/sdk/examples/*.cjs`.

**Verification (full gate).**

- `npm run typecheck` → ✅
- `npm run check:deps` → ✅ **no violations (236 modules, 766 deps)** — boundaries already respected in code.
- `npm run lint` → ✅ **0 errors** (was 15 errors, all in `.claude/` worktree + a `.cjs` example). 110
  prettier-formatting **warnings** remain (format drift in real test files, non-failing) — deferred quick-win
  (`npm run format` would fix ~69 but churns many test files; out of scope for this commit).
- `npm run test` → ✅ 689 pass / 78 files.

**Notes / follow-ups.**

- CLAUDE.md's boundaries bullet names the typed IPC surface as `shared/ipc`; the real surface is
  `window.api` (preload). The encoded rule (`renderer↛main`) captures the intent; left CLAUDE.md text as-is
  (minor). The `check:deps` claim in CLAUDE.md is now **true**.
- Prettier warning drift (110) noted for a later `npm run format` pass.

### Stage 2 — Phase 0a: error-handling policy written down (WS-9) ✅

**Why.** Four failure policies coexisted in the template/macro path with no stated rule, so each new surface
re-derived "throw, strip, blank, or pass through?" (review WS-9). Codify the existing behavior; no code
behavior change.

**Changes.**

- `docs/rpt-api.md` — new "§7. Template / macro error-handling policy" table (preset = fail-loud; card/lore
  = degrade/strip-keep-prose; engine-off = strip; engine-eval-error = empty+error; unknown macro =
  pass-through) + the rule-of-thumb.
- Comment pointers to §7 added at the four sites: `promptBuilder.ts` `ejsStrict` + `renderLoreEntry`,
  `templateEngine.ts` `evalTemplateDetailed` docblock, `macros.ts` unknown-macro default.

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 689. (Comment + doc only — no
behavior change.)

### Stage 3 — Phase 0b: delete dead DB schema (WS-6) ✅

**Why.** `rpg_entities` (table) and `pending_lore` (chats column) shipped with zero readers/writers in
`src/` — speculative "Phase H/I/K/J" surface that misleads readers (review WS-6).

**Changes (`src/main/services/db.ts`).**

- Removed the `rpg_entities CREATE TABLE` and the `pending_lore` column + its `addColumnIfMissing` migration.
- Added `DROP TABLE IF EXISTS rpg_entities;` to `DROP_LEGACY` — the table was always empty, so dropping it
  from older DBs is safe. Left the harmless unused `pending_lore` NULL column in old DBs (no risky
  `ALTER … DROP COLUMN`); documented the choice in-code.
- Reconciled the cascade comment in `profileService.ts` (dropped the `rpg_entities` mention).
- Kept `episodic_memory` (reserved by an imminent plan).

**Verification.** typecheck ✅ · check:deps ✅ (236 modules) · lint ✅ 0 errors · test ✅ 689. No test
referenced the dropped schema.

### Stage 4 — Phase 0c: document path dialects + pin (WS-8) ✅

**Why.** Two path dialects (bracket-aware `objectPath` vs split-on-dot in macros/lodash/thRuntime/wcvPreload/
stscript) coexist by deliberate 2026-06-22 decision but were undocumented as a contract — a future "helpful"
merge would silently change semantics (review WS-8).

**Changes.**

- `src/shared/objectPath.ts` — expanded the header into an explicit dialect table (which surfaces are
  bracket-aware vs split-on-dot, and why) + a don't-merge warning.
- `test/pathDialects.test.ts` (new) — pins both dialects on `a[0].b`: objectPath indexes the array;
  macros `{{getvar}}` treats `a[0]` as a literal key (and does NOT reach a real array). 4 tests.

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ **693** (+4).

### Stage 5 — Phase 0d: one host-event broadcast helper (WS-7) ✅

**Why.** Every host event was emitted twice in App.tsx (`window.api.wcvBroadcastEvent` + `emitCardHostEvent`)
across a 70-line mount effect; adding an event risked wiring only one transport and silently breaking the
other (review WS-7).

**Changes.**

- `src/renderer/src/cardBridge/hostBroadcast.ts` (new) — `broadcastHostEvent(chatId, name, payload)` (fans
  out to both transports) + `initCardEventBridge()` (the chat-store→events compute+broadcast subscription,
  lifted verbatim from App.tsx, returns a disposer).
- `src/renderer/src/App.tsx` — stream-token broadcast now calls `broadcastHostEvent`; the inline
  `unsubEvents` subscription replaced by `initCardEventBridge()`; dropped the now-unused
  `emitCardHostEvent` / `chatTransitionEvents` / `messageMutationEvents` imports. Behavior identical.

**Boundary check.** `hostBroadcast` lives in the inline `cardBridge` transport and imports only renderer
modules + `window.api` — `check:deps` confirms no transport cross-import (237 modules, 0 violations).

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 693 (79 files).

### Stage 6 — Phase 1 / WS-1a: engine stat_data read-fallback + hoisted `variables` ✅

**Why (verified against the real card).** Cards' EJS reads MVU keys in **both** forms —
`getMessageVar('stat_data.关系列表')` (prefixed) AND `getMessageVar('世界后台状态.X')` (bare, assuming the
hoisted view) — confirmed in the example card set (preset + scripts). Build-time resolved only the prefixed
form; render/WCV resolved both (they pre-hoisted). The fix that unifies all three **without** copying the
live build-time store (which IS the persisted floor vars — copying would drop setvar persistence) is an
engine-level read-fallback.

**Design decision (locked).** Permissive **superset**, implemented in the engine, not by hoisting-copy:
`getvar(key)` tries the store path, then falls back to `store.stat_data[key]`; the `variables` constant is
exposed as the hoisted view. Top-level wins on `getvar` collision; global scope is exempt. No store copy →
build-time persistence untouched.

**Changes (`src/shared/templateEngine.ts`).**

- `getvar` gains the `stat_data` read-fallback (non-global, only when the bare path missed).
- the `variables` constant is set to the hoisted view (`{...vars, ...vars.stat_data}`), read-only snapshot.
- `test/templateHelpers.test.ts` — +6 cases (prefixed read, bare/hoisted read, top-level-wins,
  default-fallthrough, `variables` dual access, global-scope exemption).

**Verification.** typecheck ✅ · check:deps ✅ (237 modules) · lint ✅ 0 errors · test ✅ **699** (+6).
Additive — no existing test changed. WS-1b (shared `buildTemplateContext` to consolidate constants/globals +
have all callers pass the wrapped shape) follows.

### Stage 7 — Phase 1 / WS-1b: shared `buildTemplateContext` constructor ✅

**Why.** Three hand-built `TemplateContext` literals (build/render/WCV) drifted on the globals/constants/
enabled defaults (review WS-1). One constructor removes that drift; the functional read-consistency already
landed in WS-1a.

**Changes.**

- `src/shared/templateEngine.ts` — `buildTemplateContext(vars, { globals?, constants?, data?, enabled? })`
  - `TemplateContextOpts` (defaults: globals/constants → `{}`, enabled → true). Documents the wrapped-vars
    contract (callers don't pre-hoist; the engine resolves both forms).
- `src/main/services/templateService.ts` — re-export `buildTemplateContext` + `TemplateContextOpts`.
- `src/main/services/generationService.ts` — build-time context now constructed via the builder
  (`workingVars` still passed by reference → setvar persistence intact).
- `src/renderer/src/plugin/renderTemplate.ts` — `buildRenderContext` drops the manual stat_data pre-hoist
  (engine fallback covers it), uses the builder; keeps a fresh shallow copy for setvar transience.
- `src/preload/wcvPreload.ts` — `buildEjsCtx` passes the wrapped `{ stat_data }` shape via the builder
  (no pre-hoist).

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 699. Behavior-preserving for
build-time (tests pin it); render/WCV vars-shaping is now the canonical wrapped form (reads unchanged via
the WS-1a fallback). Runtime spot-check of render/WCV panels deferred to in-app testing (can't drive the
Electron app here).

### Stage 8 — Phase 1 / WS-1c: SDK docs (card-facing surface) ✅

**Why.** WS-1 changed the card-facing EJS variable surface → SDK docs must move with it (CLAUDE.md / SDK
maintenance contract).

**Changes.**

- `docs/rpt-api.md` §EJS — documented the unified variable surface (prefixed + bare both resolve in all
  three contexts; top-level wins on collision; per-context constant/globals caveats; render-time setvar
  transient).
- `docs/sdk/component-inventory.md` — World-info EJS row notes the one-engine / one-`buildTemplateContext`
  unification + the resolve-both-forms guarantee.

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 699 (docs-only).

**Phase 1 (WS-1) COMPLETE** — the keystone. The three EJS contexts now share one engine + one constructor
and resolve the variable surface identically.

### Stage 9 — Phase 2 / WS-4 (partial): direct tests for the lodash/faker subset ✅🟡

**Why.** WS-4's core complaint was that the ~130-line clean-room lodash/faker subset (injected as a string
into the quickjs boot, `templateEngine.ts`) had **no direct tests** — silent drift from lodash semantics
would go unnoticed. Closing that gap is the high-value, low-risk slice.

**Changes.**

- `test/sandboxLib.test.ts` (new, +7 tests) — pins the methods a status panel actually uses: `_.get/_.set`,
  `cloneDeep`, `map/filter/find/sumBy`, `groupBy/keyBy/mapValues/sortBy/orderBy`,
  `uniq/uniqBy/chunk/padStart/isEqual`, `faker.number/uuid/name`, and the no-op `console`. (Exercised through
  the engine because the subset only exists inside the VM.)

**Deferred (explicitly).** The _physical_ extraction of the subset into its own `shared/sandboxLib.ts`
module is **not** done — it's a verbatim move of ~110 lines of dense JS-in-a-string into quickjs, where a
single transcription slip could silently change a lodash method's behavior. It's cosmetic relative to the
testability win now in place, and is safer as a focused, separately-reviewed follow-up. Tracked as WS-4
remainder.

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ **706** (+7).

### Stage 10 — Phase 4 / WS-2: gate L1 Frozen Core as experimental ✅

**Finding (sharpens the review).** The cache-level `<select>` in `SettingsPanel.tsx` is **`disabled`** (pinned
to baseline/0), so the entire L1 path (`cacheLayers.ts` + the `frontierTemplate`/`buildStateBlock` fork in
`promptBuilder`, gated on `cache.level ≥ 1`) is **UI-unreachable / dormant** in production — implemented +
unit-tested but unvalidated against real provider caching (the meter's "stable prefix %" is a proxy, not a
cache-hit rate).

**Decision (WS-2 = option C, gate/document; NOT remove).** Removing tested, deliberately-designed code is the
owner's call (option B), so I kept it and made its status honest:

- `docs/prompt-cache-optimization-design.md` — status note: experimental/dormant/unvalidated; UI-disabled;
  proxy ≠ provider hits; removal candidate if never validated.
- `cacheLayers.ts` header + `generationService.ts` `cacheLevel` read — ⚠️ EXPERIMENTAL/DORMANT markers
  pointing to the doc.

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 706 (comment/doc only). No
behavior change; the path stays dormant. Open decision for the owner: validate (A) vs remove the
partition/diff dual-mode (B).

### Stage 11 — Phase 3 / WS-5 (inc 1): decompose buildPrompt — safe extractions ✅

**Why.** `buildPrompt` was a ~325-line orchestrator with the `convoStart` find+splice pattern duplicated 3×
and self-contained tail/marker blocks inline (review WS-5). Pure extraction, behavior-preserving.

**Changes (`src/main/services/promptBuilder.ts`).**

- `insertBeforeConvo(messages, msg)` — replaces the 3 duplicated convoStart find+splice sites (world-info
  safety net, mode addendum, persona).
- `applyInjectionMarkers(messages, markerEntries, render)` — the `[GENERATE]`/`@INJECT` drain, lifted out.
- `applyCacheTail(messages, cacheLevel, vars, hasTrailingUser)` — the L1 tail block, lifted out (clean seam
  for WS-2's dormant path).

**Verification.** Characterization net green — `promptBuilder.test.ts` + `injectMarkers.test.ts` +
`cacheLayers.test.ts` (61) unchanged. typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 706. No
behavior change (the produced message array is identical; tests pin it). inc2 (partitionLore /
renderPresetBlocks) optional — assessed next.

### Stage 12 — Phase 3 / WS-5 (inc 2): extract partitionLore ✅ — WS-5 done

**Changes (`src/main/services/promptBuilder.ts`).**

- `partitionLore(matched, lorebooks) → { markerEntries, topEntries, depthEntries }` — pure (no render
  context), lifted out of buildPrompt; `applyInjectionMarkers` now reuses the shared `ParsedEntry` type.

**Left by design.** The preset-block loop (`renderPresetBlocks`) was NOT extracted: it mutates `messages`

- `presetDepthItems` + the `historyEmitted`/`worldInfoEmitted` flags and calls `buildHistory`, so a clean
  extraction needs heavy state-passing for little gain and more risk on the compat hot path. The four
  extractions (insertBeforeConvo, applyInjectionMarkers, applyCacheTail, partitionLore) already remove the
  worst duplication and shrink the function materially.

**Verification.** Characterization net green (promptBuilder + injectMarkers, 56). typecheck ✅ · check:deps ✅
· lint ✅ 0 errors · test ✅ 706. **WS-5 substantially complete.**

### Stage 13 — Phase 5 / WS-3: SPIKE complete (implementation deferred) 🟡

**Spike question.** Does real MVU fire `mag_variable_update_*` on _programmatic_ writes
(`insertOrAssignVariables`/`setMvuVariable`/`replaceMvuData`), or only on the AI-message fold? This decides
whether origin-tagging is faithful.

**Findings (real MIT source — [MagicalAstrogy/MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)).**

- The events are defined in `src/variable_def.ts` and **emitted only by `updateVariables`**
  (`src/function/update_variables.ts`).
- `updateVariables` is invoked **only from the message-fold path** — `handleVariablesInMessage(message_id)`
  (after an AI message) and `handleVariablesInCallback` (folding message content). It is NOT called by the
  programmatic helpers.
- `store.ts` has **no `eventEmit`**; `setMvuVariable`/`getMvuVariable`/`replaceMvuData` are pure
  read/mutate helpers on a passed data object (the card persists separately via TavernHelper), so a card
  calling them does **not** fire `mag_variable_update_*`.

**Conclusion.** In real MVU, `mag_variable_update_*` fire on the **model fold, NOT on programmatic card
writes.** RPT's `thRuntime` ([index.ts](../src/shared/thRuntime/index.ts) `onVarsChanged`) currently fires
them on **every** `stat_data` change — including the card's own write echoed back through the broadcast —
which is the divergence that creates the self-feedback loop the `generationService` heuristic
(`LOOP_MAX`/`LOOP_WINDOW_MS`) bands over. This **resolves the "unverified" question** flagged in
[progress-log.md](progress-log.md) (we had "assumed yes"; the answer is **no**).

**Proposed fix (faithful + removes the loop at the source).** Tag each `stat_data` change with its origin
(`model-fold` vs `card-write`) end-to-end (`applyVariableOps` → persist → `notifyVarsChanged`/
`wcv-broadcast-vars` → `onVarsChanged`), and in `thRuntime` fire `mag_variable_update_*` **only** for
`model-fold` origins. Then retire the `writeLoopGuard` heuristic.

**Why deferred (not implemented here).**

1. **Behavior change on the live variable pipeline, both transports** — exactly the area I can't runtime-verify
   without the Electron app + a provider.
2. **Prior revert risk.** [progress-log.md](progress-log.md) records a previous "suppress self-write events"
   attempt that was **reverted** because it broke cards that chain init through their own update events —
   i.e. 命定之诗 may be authored against RPT's _current_ (divergent) behavior. The faithful fix is correct
   but could regress that card, so it needs an in-app A/B against the real card before landing.

**Left in place:** the heuristic loop-breaker (it works) + comment pointers added at the two divergence
sites (`thRuntime` `onVarsChanged`, `generationService` `writeLoopGuard`) recording the spike conclusion and
the proposed fix. **Owner decision required** before implementing.

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ 706 (comment/doc only).

---

## Session summary (2026-06-26)

**Done (all HIGH + MED + LOW, except one cosmetic remainder):** WS-10 (gate made real), WS-9, WS-6, WS-8,
WS-7, **WS-1** (keystone — EJS context unified), WS-4 (direct tests added), WS-5 (buildPrompt decomposed),
WS-2 (L1 cache gated/documented), WS-3 (spike complete; faithful fix designed).

**13 commits**, gate green at every stage. Tests **689 → 706** (+17); typecheck/check:deps/lint clean
throughout. `check:deps` is a NEW gate this session (WS-10).

**Deferred (need owner / can't do safely here):**

1. **WS-3 implementation** — origin-tag the variable pipeline + retire the heuristic. Spike done & faithful,
   but a live-pipeline behavior change with prior-revert risk → needs in-app A/B vs 命定之诗. Owner sign-off.
2. **WS-2 final disposition** — validate the L1 cache (A) or remove the partition/diff dual-mode (B). Owner
   decision; gated/dormant for now.
3. **WS-4 remainder** — physical extraction of the lodash/faker string to `shared/sandboxLib.ts`. Cosmetic;
   the test net (`test/sandboxLib.test.ts`) is in place so it's safe to do as a focused follow-up.
4. **WS-1 render/WCV runtime spot-check** — unit tests pin build-time; the renderer/WCV panel paths need an
   in-app look (a status panel + a `[RENDER]` entry).
5. **Prettier warning drift** (117 advisory, non-failing) — a `npm run format` pass when convenient.

---

## Follow-up session (owner directives, 2026-06-26)

Owner feedback: WS-1 confirmed OK; date-update loop **still reproduces** (the heuristic doesn't hold);
proceed with WS-4 extraction; needs more info to decide WS-2.

### Stage 14 — WS-4 remainder: extract lodash/faker to its own module ✅

**Changes.** A Node script ([scratch] /tmp/extract_sandboxlib.cjs) did the move **byte-exact** (no
transcription risk): sliced the faker+lodash+console block (11,908 chars) out of `templateEngine.ts`'s boot
into `src/shared/sandboxLib.ts` (`export const SANDBOX_LIB_JS`); the engine imports it and appends it to the
boot glue. The block is unchanged (ES5 JS for quickjs).

**Verification.** `test/sandboxLib.test.ts` + `templateHelpers.test.ts` green (proves byte-equivalence) ·
typecheck ✅ · check:deps ✅ (238 modules) · lint ✅ 0 errors · test ✅ 706. (Prettier warnings dropped
117 → 42 — the extracted block lints cleaner as its own file.) **WS-4 fully complete.**

### Stage 15 — WS-3: harden the write-back loop guard (date clock still reproduces) ✅

**Owner report.** The `date`-update loop still reproduces — the heuristic doesn't hold.

**Root cause of the heuristic's failure.** The guard was **time-windowed** (`LOOP_WINDOW_MS = 400`): it only
counted same-signature writes that arrived <400 ms apart. The date loop's round-trip (card write → IPC →
persist → broadcast → IPC → MVU event → card handler → write) is **slower than 400 ms**, so the window reset
every iteration and the count never reached the threshold → never caught.

**Why not the architectural fix here.** The spike's faithful fix (fire MVU events only on model-fold) risks
breaking 命定之诗's init **and I cannot verify it** — its live automation is loaded **remotely** (the local
`脚本-*.json` files are 177–230-byte stubs; none even contain `mag_variable_update_ended`), so the
self-chain assumption can't be checked from the card. Landing a live-pipeline event-suppression change blind
is too risky.

**Fix (app-side, card-internals-independent, can't break init by construction).** Made detection
**timing-independent**: count **consecutive** same-signature writes (no wall-clock window), and **reset the
streak each model turn** (`generate()` → `resetWriteLoopGuard`). A loop hammers ONE signature with no AI
turn between → accumulates → dropped at `LOOP_MAX = 40`. A legit init chain touches **distinct** paths (the
signature changes → streak resets) and per-turn updates are spread across folds (reset each turn) → never
accumulate. The loop logic is extracted to a pure `registerWriteSignature(chatId, sig)` and unit-tested.

**Changes (`src/main/services/generationService.ts`).** Removed `LOOP_WINDOW_MS`; `LOOP_MAX` 25 → 40;
`registerWriteSignature` (+exported) and `resetWriteLoopGuard` (+exported, called at `generate()` start);
updated the rationale comments. `test/generationService.test.ts` +5 (loop dropped, timing-independence,
distinct-path init survives, per-turn reset, chat isolation).

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ **711** (+5).

**Still open (owner):** the architectural fix (origin-tag → fire MVU events only on model-fold → delete this
guard) remains the proper long-term solution, gated on in-app verification against 命定之诗. The hardened
guard should stop the reported date loop now; please confirm in-app. Known limit: a card legitimately
writing the SAME path 40+ times consecutively between turns (real-time self-driven animation) would be
capped — out-of-contract, same risk class as before but now timing-independent.

### Stage 16 — WS-2: STASH the cache system + add a true `baseline` mode (owner directive) ✅

**Owner directive.** Cache optimization is low-prio — stash the options for later; add a true baseline mode
(no optimization at all, not even provider API caching) as a reference; keep the selector greyed out; default
to baseline.

**Implemented — a three-way `cache.mode` (`baseline` | `provider` | `frozen`), greyed out + pinned/default
`baseline`:**

- `baseline` (default): omits Anthropic `cache_control` entirely → **no provider-side prompt caching**, a
  clean reference control. (OpenAI auto-prefix is transparent / not client-disableable — documented.)
- `provider`: provider prefix caching as-is (the old level-0 behavior).
- `frozen`: the dormant L1 Frozen-Core layering (the old level 1) — kept for later review, reachable only via
  this (unselectable) mode.

**Changes.**

- `types/models.ts` + `stores/settingsStore.ts` — add `cache.mode` (both copies of the type).
- `settingsService.ts` — default `mode:'baseline'`; normalize coerces unknown/missing mode → `baseline` and
  derives `level` from `mode` (frozen → 1, else 0).
- `apiService.ts` — extracted `buildAnthropicCacheLayout(merged, systemPrompt, cacheOn)` (pure, exported);
  `baseline` → `cacheOn=false` → no `cache_control` on system or messages.
- `generationService.ts` — `cacheLevel` derives from `mode === 'frozen'` (so production = 0).
- `SettingsPanel.tsx` — the (disabled) select now binds `cache.mode` with three options; updated title/hint.
- i18n `en.ts` + `zh.ts` — `prefs.cacheBaseline` ("Baseline (no caching)"), new `prefs.cacheProvider`,
  updated hint + disabled title.
- Decision recorded atop `docs/prompt-cache-optimization-design.md`.

**Intended behavior change:** the default now omits Anthropic `cache_control` (was always-on). Updated the
settings characterization test deliberately (a legacy stored `level:1` with no `mode` → `baseline`/level 0).

**Verification.** typecheck ✅ · check:deps ✅ · lint ✅ 0 errors · test ✅ **715** (+4: 3 `buildAnthropicCacheLayout`,

- settings cache-mode cases). **Note (cost):** baseline omits provider caching by default, so token cost
  rises vs the old provider-caching default — intentional (clean reference; the system is parked).
