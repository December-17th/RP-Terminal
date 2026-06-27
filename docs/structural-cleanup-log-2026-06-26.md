# Structural Cleanup — Execution Log (2026-06-26)

_Traceability log for executing [maintainability-plan-2026-06-26.md](maintainability-plan-2026-06-26.md)
(diagnosis: [codebase-structural-review-2026-06-26.md](codebase-structural-review-2026-06-26.md)) on branch
`refactor/structural-cleanup-2026-06-26`._

> **How to read this.** Newest stage at the bottom of "Stages". Each stage records: what changed (files),
> why, the verification run, and the commit. Verification gate this session =
> `npm run typecheck && npm run lint && npm run test` (+ `npm run check:deps` once it exists — see Phase 0).

## Work schedule (status)

| # | Phase | ID | Pr | Status | Commit |
| --- | --- | --- | --- | --- | --- |
| 0 | Make module-boundary gate real | WS-10 | (pre) | ✅ done | `82d9c48` |
| 0a | Error-handling policy doc | WS-9 | LOW | ✅ done | `de140ff` |
| 0b | Delete dead DB schema | WS-6 | LOW | ✅ done | `663d337` |
| 0c | Document path dialects + test | WS-8 | LOW | ✅ done | `1b4ada8` |
| 0d | One broadcast helper | WS-7 | MED | ✅ done | (this commit) |
| 1 | Unify EJS context (keystone) | WS-1 | HIGH | ✅ done | 1a `396cd13` · 1b `8061410` · 1c `(this commit)` |
| 2 | lodash/faker → tested module | WS-4 | MED | 🟡 partial (tests added; file-extract deferred) | (this commit) |
| 3 | Decompose buildPrompt | WS-5 | MED | ⬜ todo | — |
| 4 | De-escalate L1 cache | WS-2 | MED | ✅ done (gated/documented) | (this commit) |
| 5 | Write-back loop origin-tag | WS-3 | HIGH | ⬜ todo | — |

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
  + `TemplateContextOpts` (defaults: globals/constants → `{}`, enabled → true). Documents the wrapped-vars
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

**Deferred (explicitly).** The *physical* extraction of the subset into its own `shared/sandboxLib.ts`
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
