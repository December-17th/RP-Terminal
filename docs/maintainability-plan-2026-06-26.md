# RP Terminal — Maintainability Plan (2026-06-26)

_Treatment plan derived from [codebase-structural-review-2026-06-26.md](codebase-structural-review-2026-06-26.md)
(the diagnosis). Supersedes [maintainability-plan.md](maintainability-plan.md) (2026-06-22, all phases
done). Bracketed IDs (**WS-n**) point back to the review's findings._

> **Status: DRAFT (planning).** Branch `refactor/structural-cleanup-2026-06-26` (off
> `feat/poem-combat-extension`). Nothing here is implemented yet — this is the sequenced design.

---

## Guiding principles

- **No behavior change unless explicitly intended.** Most steps are refactors, deletions, or doc edits. The
  one *intended* behavior change is WS-3 (write-back loop); WS-1 deliberately *aligns* render/WCV behavior
  to build-time semantics, which is a fix, not a silent change — call it out per step.
- **Green at every step.** `npm run typecheck && npm run check:deps && npm run test` after each phase
  (the repo's verification gate). Commit per concern so any regression is bisectable.
- **One module per change/PR** (CLAUDE.md). Extract behind an interface, keep characterization tests green
  at each step. No multi-file autonomous rewrites.
- **SDK docs move with the code** (CLAUDE.md / `docs/sdk/README.md`). WS-1 and WS-4 touch the card-facing
  surface → update `docs/sdk/component-inventory.md` + `docs/rpt-api.md` in the *same* change.
- **Characterization tests pin behavior, not correctness.** If a step *should* change behavior (WS-3),
  update the characterization test in the same commit, deliberately — never delete a failing one to go
  green.
- **Clean-room + module boundaries hold** — `shared/*` must not import `main`/`renderer`; transports never
  import each other; combat engine stays pure; no `eslint-disable`/`check:deps` bypass.

---

## At a glance

| Phase | ID | Pr | Effort | Risk | Intended behavior change? |
| --- | --- | --- | --- | --- | --- |
| 0a | WS-9 | LOW | ~1h | none | no (doc) |
| 0b | WS-6 | LOW | ~1h | low | no |
| 0c | WS-8 | LOW | ~1–2h | none | no (doc + test) |
| 0d | WS-7 | MED | ~half day | low | no |
| 1 | **WS-1** | **HIGH** | ~1–2 days | medium | **yes — aligns render/WCV to build semantics** |
| 2 | WS-4 | MED | ~half day | low | no |
| 3 | WS-5 | MED | ~1–2 days | medium | no |
| 4 | WS-2 | MED | decision + ~1 day | medium | maybe (if a mode is removed) |
| 5 | **WS-3** | **HIGH** | spike + ~1–2 days | medium-high | **yes — by design** |

Do **0a–0d** first (cheap, derisking, parallelizable). **Phase 1 (WS-1)** is the keystone — land it before
3 and 4. **Phase 5 (WS-3)** starts with a verification spike and can run on its own track anytime.

---

## Phase 0a — Write down the error-handling policy `[WS-9, LOW]`

**Problem.** Four failure policies in the template path with no single stated rule
(review WS-9): preset EJS throws ([promptBuilder.ts:304-316](../src/main/services/promptBuilder.ts)), lore
EJS strips-but-keeps-prose ([promptBuilder.ts:387-411](../src/main/services/promptBuilder.ts)), engine
returns `''`/strips ([templateEngine.ts:388-428](../src/shared/templateEngine.ts)), unknown macro passes
through ([macros.ts:176](../src/shared/macros.ts)).

**Approach (doc-only).**
1. Add an "Error-handling policy" section to `docs/rpt-api.md` (or a short `docs/error-policy.md`) stating
   the rule: **presets fail loud (fail the turn); card/lore content degrades gracefully (strip tags, keep
   prose); engine-off / not-initialized strips; unknown macros pass through verbatim.**
2. Add a one-line `// Policy: see docs … (WS-9)` comment at each of the four sites pointing to it.

**Why first.** It's the cheapest item and it *codifies the invariant WS-1 and WS-5 must preserve* — so do
it before touching the template path.

**Risk:** none. **Verify:** docs only; `npm run typecheck` unaffected.

---

## Phase 0b — Delete unused DB schema `[WS-6, LOW]`

**Problem.** `rpg_entities` ([db.ts:70](../src/main/services/db.ts)) and the `pending_lore` column
([db.ts:51](../src/main/services/db.ts), migrated [db.ts:130](../src/main/services/db.ts)) have **zero**
readers/writers in `src/`. `episodic_memory` ([db.ts:84](../src/main/services/db.ts)) is reserved by an
imminent plan — keep it.

**Approach.**
1. Remove the `rpg_entities` `CREATE TABLE` and the `pending_lore` column + its `addColumnIfMissing` call.
2. Reconcile the comment in [profileService.ts:81-82](../src/main/services/profileService.ts) (the cascade
   note that references `rpg_entities`).
3. Leave existing DBs alone (don't write a destructive `DROP` migration — an old DB keeping an empty
   `rpg_entities` is harmless; only stop *creating* it). Optionally add it to the `DROP_LEGACY` block if a
   clean removal is wanted — decide explicitly.

**Risk:** low (no readers). **Verify:** `npm run test` (db/migration tests); app boots, `getDb()` runs the
schema without error.

---

## Phase 0c — Document the two path dialects + pin them `[WS-8, LOW]`

**Problem.** Bracket-aware ([objectPath.ts](../src/shared/objectPath.ts)) vs split-on-dot
([macros.ts:22-41](../src/shared/macros.ts), [thRuntime/index.ts:28-34](../src/shared/thRuntime/index.ts),
`_.get` `__ks` in [templateEngine.ts:274-279](../src/shared/templateEngine.ts), `wcvPreload`) coexist; a
deliberate Phase-2 (2026-06-22) decision, but undocumented as a contract.

**Approach (no semantics change).**
1. In [objectPath.ts](../src/shared/objectPath.ts), expand the header note into an explicit table: which
   surfaces are bracket-aware, which are split-on-dot, and **why** (MVU `-` append marker, perf, etc.).
2. Add `test/objectPath.test.ts` cases (or a small `pathDialects.test.ts`) asserting each dialect's
   behavior on `a[0].b` so the divergence is pinned and a future "helpful" merge breaks a test loudly.

**Risk:** none. **Verify:** `npm run test`.

---

## Phase 0d — One host-event broadcast helper `[WS-7, MED]`

**Problem.** Every host event is emitted twice in [App.tsx:47-120](../src/renderer/src/App.tsx)
(`window.api.wcvBroadcastEvent` + `emitCardHostEvent`); a new event must be added in both blocks or one
transport silently misses it.

**Approach.**
1. Add `broadcastHostEvent(chatId, name, payload)` (and a `broadcastStreamToken`) that hits **both**
   transports — co-locate with `cardBridge/cardHostEvents.ts` or a new
   `renderer/src/cardBridge/hostBroadcast.ts`.
2. Lift the chat-store subscriptions + delta/log/wcv listeners out of `App.tsx` into
   `initCardEventBridge()` (returns a disposer); `App.tsx` calls it once in the mount effect.
3. Route the existing call sites through the helper.

**Boundary check.** Stays within `renderer`; uses `window.api` (the typed IPC surface) — no new
main-internal import.

**Risk:** low (pure relocation + dedup). **Verify:** `npm run test` (`cardHostEvents.test.ts`,
`thEvents.test.ts`); manual: a card receives generation/message events on **both** inline and WCV paths.

---

## Phase 1 — Unify the EJS template context (KEYSTONE) `[WS-1, HIGH]`

**Problem.** Three hand-built `TemplateContext`s with divergent `vars` shaping, `globals`, and `constants`
(review WS-1): build-time [generationService.ts:208-245](../src/main/services/generationService.ts),
render-time [renderTemplate.ts:15-34](../src/renderer/src/plugin/renderTemplate.ts), WCV
[wcvPreload.ts:212-223](../src/preload/wcvPreload.ts). The same `getvar('主角')` / `getglobalvar()` /
`runType` resolves differently in each.

**Design decision to lock first (do as part of the spike):**
- **Canonical `vars` shape:** **hoist** stat_data to root **and** keep `stat_data` (so both `getvar('主角')`
  and `getvar('stat_data.主角')` resolve everywhere). This makes build-time match render/WCV — the
  permissive superset — and is the lower-risk direction (build-time gains a form it lacked; nothing that
  worked stops working). **Confirm** against the example card's prompt EJS before committing.
- **Canonical `constants`:** the full build-time set; render/WCV pass what they can and leave the rest
  `undefined` (documented), OR thread the real values where cheap (chatId/characterId are available at
  render time via stores).
- **`globals`:** thread the real per-profile globals into render/WCV where reachable; if not reachable in a
  realm, document the limitation rather than silently `{}`.

**Approach (one module per step).**
1. **Add `buildTemplateContext(opts)` to `src/shared`** (new `shared/templateContext.ts`, or export from
   `templateEngine.ts`). Pure; takes `{ vars, globals?, constants?, data? }` and applies the canonical
   hoisting + constant defaults. Imports nothing realm-specific.
2. **Pin it** with `test/templateContext.test.ts`: hoisting, the `stat_data` dual-form, constant defaults,
   empty-globals behavior.
3. **Migrate build-time** ([generationService.ts](../src/main/services/generationService.ts)) to feed
   `buildTemplateContext`. Run `promptBuilder.test.ts` + `generationService.test.ts` — expect a few
   characterization updates **iff** the hoisting now resolves a previously-undefined `getvar('主角')`; update
   them deliberately with a comment.
4. **Migrate render-time** ([renderTemplate.ts](../src/renderer/src/plugin/renderTemplate.ts)) and the
   **inline host** ([cardBridge/host.ts:250-257](../src/renderer/src/cardBridge/host.ts)) to call it.
5. **Migrate WCV** ([wcvPreload.ts `buildEjsCtx`](../src/preload/wcvPreload.ts)) to call it (preload bundle —
   confirm the `shared` import resolves in that build, like `objectPath` already does).
6. **Update SDK docs** in the same change: `docs/rpt-api.md` (EJS variable surface) +
   `docs/sdk/component-inventory.md` §2 — state the canonical vars/constants/globals contract once.

**Boundary check.** `shared/templateContext.ts` must not import `main`/`renderer` (same constraint
`templateEngine`/`objectPath` honor). Build/render/WCV each pass realm data in.

**Risk:** medium — it's the compat path, but the characterization tests + the "permissive superset"
direction bound it. Migrate one caller per commit.

**Verify:** full gate after each caller. Manual: the example card's status panel + a `[RENDER]` entry +
prompt EJS all read the same vars.

---

## Phase 2 — lodash/faker out of the engine string `[WS-4, MED]`

**Problem.** ~130 lines of untyped lodash/faker live inside the `boot` string at
[templateEngine.ts:239-369](../src/shared/templateEngine.ts) — no typecheck/lint/direct tests.

**Approach.**
1. Author the subset as a real `.ts` (e.g. `shared/sandboxLib.ts`) exporting a **string constant** of the
   IIFE body (or a typed object compiled to a string at build). Keep it clean-room (no lodash source).
2. Engine `installBridge` injects that string instead of the inline literal.
3. Add `test/sandboxLib.test.ts` exercising the methods cards actually use (get/set/cloneDeep/groupBy/
   sumBy/orderBy/…) against expected lodash semantics; note the known approximations explicitly.
4. **Update `docs/sdk/component-inventory.md` §3** (injected `_`/faker is part of the env) +
   `docs/rpt-api.md`.

**Risk:** low (same code, better packaged) — but the string must still eval cleanly inside quickjs; keep it
ES5-ish (no spread/optional-chaining) as the current boot is.

**Verify:** `templateHelpers.test.ts` + the new test; full gate.

---

## Phase 3 — Decompose `buildPrompt` `[WS-5, MED]` (after WS-1)

**Problem.** 325-line orchestrator ([promptBuilder.ts:253-578](../src/main/services/promptBuilder.ts)) with
5× repeated `convoStart` scanning and every prompt concern inline.

**Approach (pure extraction, characterization-guarded).** Extract, one commit each:
1. `partitionLore(matched, lorebooks)` → `{ regular, markerEntries, topEntries, depthEntries }`
   (the `:355-380` block).
2. `renderPresetBlocks(preset, ctx, render, ejsStrict)` → the `for (block of preset.prompts)` loop.
3. `applyInjectionMarkers(messages, markerEntries, render)` (the `:539-565` drain).
4. `applyCacheTail(messages, args)` (the `:567-576` L1 tail) — leave a clean seam for WS-2.
5. A single `insertBeforeConvo(messages, msg)` helper replacing the 5 duplicated `findIndex`+`splice`
   patterns.

**Risk:** medium (it's the heart) — mitigated by "no behavior change + tests green per extraction."
`promptBuilder.test.ts` is the safety net; do **not** alter expectations here (that's WS-1/WS-2's job).

**Verify:** full gate after each extraction; diff the produced message array on the example card before/after
(should be byte-identical).

---

## Phase 4 — De-escalate L1 Frozen Core `[WS-2, MED]` (after WS-1/WS-5)

**Problem.** Default-off, unvalidated cache layering forks the hot path
([cacheLayers.ts](../src/main/services/cacheLayers.ts) + the `frontierTemplate`/`buildStateBlock` paths in
[promptBuilder.ts](../src/main/services/promptBuilder.ts)).

**Decision required (not a default).** Pick one:
- **A — Validate.** Run an A/B against a real provider (the `cacheAbHarness` is a starting point) measuring
  *actual* cache hits, not the proxy %. Keep if it wins; else →
- **B — Collapse.** Drop `diff` (or `partition`), keeping one mode, removing `placeholderize` + half the
  branching.
- **C — Gate.** Mark the whole frozen-core path "experimental," document the unvalidated status in
  `docs/prompt-cache-optimization-design.md`, and stop treating byte-stability as a guarantee.

**Recommendation:** **C now** (cheap, honest), **B** if no validation appears, **A** only if someone will do
the measurement. Whichever: record it in `docs/prompt-cache-optimization-design.md`.

**Risk:** medium if code is removed (behavior change for the opt-in users — none by default). **Verify:**
`cacheLayers.test.ts`, `cacheAbHarness.test.ts`, `promptCacheMetrics.test.ts`.

---

## Phase 5 — Fix the variable write-back loop at the source `[WS-3, HIGH]` (own track)

**Problem.** Heuristic loop-breaker ([generationService.ts:425-493](../src/main/services/generationService.ts))
papers over a card-write echoed back via two paths ([wcvManager.ts:276](../src/main/services/wcvManager.ts) +
[thRuntime/index.ts:55-83](../src/shared/thRuntime/index.ts)). Documented as tech debt in
[progress-log.md (2026-06-26)](progress-log.md).

**Step 0 — Verification spike (PREREQUISITE).** Confirm real-MVU event semantics: does a programmatic
`insertOrAssignVariables` / `replaceMvuData` fire `mag_variable_update_*` in real MVU, or only model-fold
updates? Read the MVU source / docs (MIT, reusable). The answer decides the fix shape — **do not implement
before this is known.**

**Step 1 — Tag change origin end-to-end.** Thread an origin tag (`'model-fold' | 'card-write'`) through the
write path (`applyVariableOps` → persist → `notifyVarsChanged`/`wcv-broadcast-vars` →
`onVarsChanged`/`thRuntime`). Fire `mag_variable_update_*` only on model/external folds (or per the verified
real-MVU rule).

**Step 2 — Retire the heuristic.** Once origin-tagging stops the echo, remove `writeLoopGuard` +
`LOOP_WINDOW_MS`/`LOOP_MAX`. **This is an intended behavior change** — update
`generationService.test.ts`/`thRuntime.test.ts` deliberately, and add a regression test proving a
self-chained init still propagates while a self-feedback clock no longer loops.

**Step 3 — Supersede the progress-log note** with the real fix.

**Risk:** medium-high (touches the live variable pipeline + both transports) — which is exactly why the
spike gates it. Keep inline `cardBridge` and WCV at parity (change the shared runtime, both inherit).

**Verify:** full gate; manual on the poem card (the original repro): self-chained init populates; a `date`
clock no longer spins.

---

## Sequencing

```
0a WS-9  ┐ quick wins (parallel, no behavior change)
0b WS-6  │
0c WS-8  │
0d WS-7  ┘
   │
1  WS-1  ── KEYSTONE (after 0a); migrate one caller per commit + SDK docs
2  WS-4  ── parallel to 1 (independent)
   │
3  WS-5  ── after 1 (consumes the unified context)
4  WS-2  ── after 3 (clean seam from applyCacheTail); a decision, then code
   │
5  WS-3  ── spike-gated; own track, anytime
```

Phases 0a–0d + 1 are the focused first push that most lowers future change cost. WS-3 is the highest-severity
*correctness* item but is gated on the verification spike, so it runs independently rather than blocking the
refactor train.

---

## Explicitly NOT doing (conscious choices)

- Growing the **combat engine** (subsystem F) — leave it frozen at current size until it's exercised live
  in-app; adding now invites more speculative generality.
- Merging the **path dialects** (WS-8 is document-and-pin, not unify — a forced merge changes semantics).
- Touching the **`agentic` stub** ([generationService.ts:118](../src/main/services/generationService.ts)) —
  honest, documented placeholder.
- **Security hardening** beyond the existing API-key masking — deferred per the owner's standing decision;
  this plan is maintainability-only.
- Collapsing the **execution surfaces** (iframe plugin host / WCV card host / sandbox worker) — role-distinct
  and justified; only the *main-process double quickjs load* is a (low-priority) candidate, folded into
  WS-4's vicinity if convenient.
