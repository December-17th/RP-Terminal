# RP Terminal — Maintainability Plan

_Derived from [codebase-health-check.md](codebase-health-check.md) (2026-06-22). The health check is the
diagnosis; this is the treatment plan. Bracketed tags like **[H]** point back to the report's sections._

The verdict was **HEALTHY — solid core with a normal cleanup backlog**. Nothing here is a bug fix; this is
hygiene to keep the sediment of an incremental, multi-session build from compounding. The aim is to make the
codebase **cheaper to change safely**: a trustworthy lint gate, less dead/duplicated code, and one honest
decision about the dual card-host stacks.

---

## Guiding principles

- **No behavior change.** Every step is a refactor, deletion, or config/doc edit. The app's runtime behavior
  must be identical before and after.
- **Green at every step.** `npm run typecheck` + `npm test` (304 tests) + `electron-vite build` must pass
  after each phase. Commit per concern so any regression is bisectable.
- **One concern per commit**, small and reviewable — the report's whole point is that small messes compound,
  so don't trade one for another.
- **Sequencing matters:** fix the lint gate _first_ so every later phase gets automated regression cover for
  free.

---

## At a glance

| #   | Phase                                      | Health-check ref | Effort               | Risk   | Payoff                                                     |
| --- | ------------------------------------------ | ---------------- | -------------------- | ------ | ---------------------------------------------------------- |
| 0   | Restore the lint gate                      | H                | ~30–45 min           | Low    | Highest ROI — lint becomes usable, protects all later work |
| 1   | Delete dead code + cheap consistency       | C, D             | ~1–2 h               | Low    | Removes the one true orphan + style drift                  |
| 2   | De-duplicate object-path / clone utilities | E                | ~half day            | Medium | Kills the 4–6× copy drift risk                             |
| 3   | Settle the dual card-host stack            | D, E, F          | decision + scoping   | Medium | Ends (or formally bounds) double-maintenance               |
| 4   | Discovery sweep + doc hygiene              | A, D             | ~2–3 h, then ongoing | Low    | Finds remaining orphans; docs stop drifting                |

Do **0 → 1 → 2** in order (each is cheap and unblocks confidence in the next). **3** is the one judgment call
and can run in parallel once decided. **4** is partly a one-off sweep, partly an ongoing convention.

**Progress (2026-06-22):** Phases **0–2 are ✅ done and committed** (`6dfbdb2`, `51c40fc`, `687d941`) — tests 304 → 322, lint 761 → 0 errors. **Phases 3–4 remain.**

---

## Phase 0 — Restore the lint gate **[H]**

> **Status: ✅ Done (2026-06-22)** — commit `6dfbdb2`. Lint 761 → 0 errors (37 advisory
> warnings); `npm run lint` now exits 0. Went with global-off for `no-explicit-any`, plus a
> `test/**` override and demoting the advisory react-hooks/react-refresh rules to warnings.

**Problem:** ESLint reports **761 problems (289 errors / 472 warnings)**, but it's almost all noise — so lint
is effectively off and can't catch real regressions. Decomposed by the report: `449` prettier CRLF-vs-LF
churn, `225` intentional `no-explicit-any`, `26` redundant `react/prop-types`, ~60 misc. **There are no logic
bugs hiding in it.** Until this is tuned, none of the later phases get lint cover.

**Steps:**

1. **Kill the CRLF churn (−449).** Add a root `.gitattributes` with `* text=auto eol=lf` (confirmed absent —
   only `node_modules` copies exist). This normalizes line endings so Prettier (which defaults to `eol: lf`,
   per `.prettierrc.yaml`) stops fighting Windows `autocrlf`. Then renormalize once:
   `git add --renormalize .`. _Alternative if renormalizing the tree is unwanted right now: set
   `endOfLine: auto` in `.prettierrc.yaml` — lighter, but leaves CRLF in the files._
2. **Turn off `react/prop-types` (−26).** It's a config bug — this is a TypeScript React project where
   prop-types are redundant. Add a `rules` block to `eslint.config.mjs` (which currently has none beyond the
   react-hooks/refresh spread) with `'react/prop-types': 'off'`.
3. **Decide `no-explicit-any` (−~200).** The `any` usage is deliberate (the VM bridge, the card shim, MVU's
   untyped state). Two clean options — pick one and apply consistently:
   - **Global off** in `eslint.config.mjs` (`'@typescript-eslint/no-explicit-any': 'off'`) — simplest, since
     `any` is a deliberate architectural choice at the IPC/VM/shim boundaries. _Recommended._
   - **Per-file `eslint-disable`** only on the boundary files (`templateEngine.ts` and `wcvPreload.ts` already
     have one) — keeps the rule live elsewhere to discourage casual `any` in new code. More precise, more
     upkeep.
4. **Sweep the rest.** After 1–3, re-run `npm run lint` and triage the small remainder (`prefer-const`,
   `no-empty-function` on the intentional no-op stubs, `explicit-function-return-type`, the
   `exhaustive-deps`/`set-state-in-effect` in `ChatView.tsx` pagination). Fix the trivially-correct ones;
   add a scoped `eslint-disable-next-line` with a one-line _why_ for the intentional ones (the no-op stubs,
   the "re-run trigger" effect deps).

**Verify:** `npm run lint` drops from 761 to a small, meaningful number you'd actually gate on. `npm run
typecheck` + `npm test` still green (config-only changes shouldn't touch either, but confirm). Optionally wire
`lint` into the pre-commit/CI gate _after_ the number is sane.

**Risk:** Low — config + whitespace only. The one thing to watch: `git add --renormalize` touches many files
in a single noisy commit; do it alone, labeled "chore: normalize line endings (.gitattributes)", so it never
muddies a real diff.

---

## Phase 1 — Delete dead code + cheap consistency **[C, D]**

> **Status: ✅ Done (2026-06-22)** — commit `51c40fc`. Deleted `MessageScriptFrame.tsx`; routed
> the 6 service-level `console.*` calls to `logService` (parsers left console-only). 1c
> (semicolons) was already resolved by Phase 0's format pass.

**1a. Delete `MessageScriptFrame.tsx` [D].** It's the retired in-message iframe card path, superseded by
`WcvMessageFrame` (what `MessageContent.tsx` actually renders). **Verified orphan:** zero importers in `src/`,
no `<MessageScriptFrame` usage, and no test references it by name (the only non-def mention is a _comment_ in
`CardScriptHost.tsx:55`). Lower risk than the report's "check the test first" caveat — the check is done.
Delete the file; run `npm test` + `npm run build` to confirm nothing pulled it transitively.

**1b. Route service-level `console.error` through `logService` [C].** CLAUDE.md says main-process errors
should go through `logService.log('error', …)` so they reach the in-app Logs panel + stdout. 12
`console.*` calls in 8 main files don't. **Nuance — don't blanket-replace:**

- **Services** (`characterService`, `presetService`, `regexService`, `storageService`) → convert to
  `logService.log('error', …)`. These are the real drift.
- **Pure parsers** (`stPngParser`, `stRegexEngine`, `contentParser`) → _leave as-is_. The report calls a
  parser depending on `logService` "defensible" to avoid; keeping them console-only preserves their purity
  (they're also the Vitest-covered pure modules). Optionally return/throw and let the _caller_ log.

**1c. Normalize semicolon drift [C].** Some early renderer files (e.g. `stores/settingsStore.ts`) still carry
semicolons against the no-semi Prettier config. `npm run format` (prettier `--write`) fixes it. Do this
_after_ Phase 0's `.gitattributes` so it doesn't collide with the EOL renormalization.

**Verify:** typecheck + test + build green. Grep confirms no `console.error` left in the four services (parsers
intentionally retained).

**Risk:** Low. 1a is a pure deletion of unreferenced code; 1b/1c are mechanical.

---

## Phase 2 — De-duplicate object-path / clone utilities **[E]**

> **Status: ✅ Done (2026-06-22)** — commit `687d941`. Extracted `src/shared/objectPath.ts`
> (+18 pinning tests); migrated the 3 bracket-aware path copies, 4 `clone` copies, and the sole
> `deepMerge`. The plain-`split('.')` helpers (`macros`/`wcvPreload`/`stscript`) were left as-is
> by design — folding them in would change path semantics.

**Problem:** the same small helpers are reimplemented **4–6×**, with subtle differences that make a naive
merge wrong:

- dot-path `getPath`/`setPath`/`toParts`: `shared/templateEngine.ts:72–88`, `parsers/mvuParser.ts:66–81`,
  `services/pluginService.ts:21–37`, `shared/macros.ts:32`, `renderer/.../plugin/stscript.ts:140`, plus the
  `getByPath`/`setByPath` variant in `wcvPreload.ts:110–114`.
- deep-clone `JSON.parse(JSON.stringify(v))`: `mvuParser.ts:105`, `mvuZod.ts:128`, `mvuSchema.ts:19`,
  `shared/workspaceLayout.ts:42`.
- `deepMerge`: `mvuSchema.ts:22` (plus the lodash-subset `_.merge` in `templateEngine.ts`).

**Approach — carefully, because they differ** (some handle the MVU `-` array-append marker, some tolerate
`null`/empty paths, the `wcvPreload` variant uses different names):

1. Create **`src/shared/objectPath.ts`** exporting a superset that covers every existing caller's needs:
   `toParts(path)`, `getPath(obj, path)`, `setPath(obj, path, value, opts?)` (with the optional MVU
   `-`-append behavior behind a flag), `clone(v)`, and `deepMerge(a, b)`. It must import nothing from
   `src/main`/`src/renderer` (it's consumed by both processes — same constraint `templateEngine.ts` already
   honors).
2. **Pin behavior first.** Before swapping call sites, add unit tests in `test/objectPath.test.ts` that encode
   each existing variant's edge cases (null path, missing intermediate keys, the `-` marker, array indices).
   This is the safety net for a behavior-preserving consolidation.
3. **Migrate one caller per commit**, re-running `npm test` each time. Start with the `shared/*` callers
   (cleanest), then services/parsers, then the renderer `stscript.ts`, then reconcile the `wcvPreload.ts`
   `getByPath`/`setByPath` names last (it's a preload bundle — confirm the import resolves in that build).
4. Leave the lodash-subset `_.get/_.set/_.merge` inside `templateEngine.ts`'s VM bridge as a thin re-export of
   the new module so the EJS surface is unchanged.

**Verify:** all 304+ tests green after each migration commit; the new edge-case tests pass; `build` green
(especially the preload bundle after the `wcvPreload` swap).

**Risk:** Medium — the differences are the whole danger. Mitigated by "tests first, one caller per commit."
If any variant's difference turns out load-bearing and ugly to unify, leave that one caller out and document
why rather than forcing it.

---

## Phase 3 — Settle the dual card-host stack **[D, E, F]** _(the one real decision)_

**Problem — the single biggest structural item.** There are **two implementations of the TavernHelper / MVU /
SillyTavern surface**: the iframe stack (`plugin/shims/tavern.ts` + `lib`/`bridge`/`stRuntime`/`jquery`, driven
by `CardScriptHost`) and the WCV stack (`preload/wcvPreload.ts`). Per the ROADMAP decision, WCV owns **all
card-facing rendering**, while the iframe stack is **retired for cards but intentionally kept for trusted APP
UI panels** (`CardScriptHost` is still rendered by `viewRegistry.tsx:49`). So it's not deletable today — but
every TH-API change currently has to be made **twice**.

**This needs a decision, not a default.** Three options, in increasing cost:

- **Option A — Formal pause + freeze (recommended near-term).** Declare the iframe TH-shim **frozen**: it
  serves existing trusted app-UI panels only; **no new TH surface gets added to it** — new helpers land in
  `wcvPreload` (+ the shared engine) only. Document this seam at the top of `plugin/shims/tavern.ts` and in
  CLAUDE.md's "two parallel stacks" note. _Cost: ~1 h of docs + a lint/CONTRIBUTING note. Stops the bleeding
  without a risky migration._
- **Option B — Extract a shared TH core.** Move the _pure_ TH/MVU logic (variable get/set, worldbook
  matching, the EJS context shaping) into `src/shared`, leaving each stack only its transport/bridge glue.
  Reduces real duplication, but the two run in different runtimes (renderer-iframe vs preload), so the
  shareable surface is smaller than it looks. _Cost: a spike to map what's genuinely shareable, then a
  medium refactor. Do only if Option A's "make it twice" friction proves real and recurring._
- **Option C — Finish the migration.** Move the trusted app-UI panels off `CardScriptHost`/iframe onto WCV
  too, then delete the entire iframe stack (`CardScriptHost`, `plugin/dispatch|bridgeShim|sourceRewrite|slash|
stscript|audioService`, `plugin/shims/*`) and its 8+ test files. _Cost: multi-session; this is a roadmap
  item, not hygiene._ Biggest long-term payoff, but it's a project, not a cleanup.

**Recommendation:** take **Option A now** (cheap, immediately ends accidental double-implementation), and put
**Option C** on the roadmap as the eventual end-state. Revisit **Option B** only if a few real TH-API changes
show the freeze isn't enough.

**Verify (Option A):** the freeze note exists in both `tavern.ts` and CLAUDE.md; no functional change, so
typecheck/test/build are untouched.

**Risk:** Low for A (docs only); Medium for B; High-effort (not high-risk, it's tested) for C.

---

## Phase 4 — Discovery sweep + doc hygiene **[A, D]**

**4a. Run `knip` (or `ts-prune`) once [D].** The two-card-host transition almost certainly left more orphaned
exports than just `MessageScriptFrame`. Run it as a dev-dependency, **triage the report manually** (don't
auto-delete — some "unused" exports are the lazily-provided card-script globals like `vue`/`pinia`/`jquery`
that the report already flagged as justified), and delete only confirmed orphans. Consider keeping it as an
occasional manual check, not a CI gate (too noisy for this codebase's intentional dynamic surfaces).

**4b. Doc consolidation [A].**

- **Mark completed design docs.** Add a `> Status: implemented (<date>)` header (or move to `docs/archive/`)
  to the done designs — `mvu-support-design`, `mvu-panel-workspace-design`, `card-custom-ui-design`,
  `plugin-system-design`, `st-prompt-template-plan` — so they're visibly distinct from the still-aspirational
  `agentic-mode-design.md`. Cheap navigability win.
- **Pick one status source of truth.** `ROADMAP.md`, `docs/progress-log.md`, and git history overlap;
  `progress-log.md` largely restates commits. Recommend: keep `ROADMAP.md` as the forward-looking plan, let
  **git history be the changelog**, and either retire `progress-log.md` or demote it to a short "recent
  highlights" pointer. Decide and note it so the redundancy stops growing.

**Verify:** docs only — no code gates affected. A fresh reader can tell built-vs-planned at a glance.

**Risk:** Low.

---

## Explicitly _not_ doing (conscious choices — leave them)

The health check already cleared these; this plan does **not** touch them:

- The documented graceful stubs: `generateImage()`, the inert `agent.mode === 'agentic'` placeholder, and
  bundled-card plugins "skipped on import." All honest and surfaced.
- The **sandbox** subsystem (`sandboxService`/`Runner`/`Worker`) — justified by the untrusted-card-script
  threat model and already tested.
- `vue`/`vue-router`/`pinia`/`jquery` deps — lazily provided to card scripts, not dead.
- `console.error` in the **pure parsers** — kept console-only to preserve their purity (see Phase 1b).
- Bundle sizes (Electron app, not a web bundle).
- **Security hardening beyond the existing API-key masking** — per the owner's standing decision, broad
  security work is deferred; this plan is maintainability-only and doesn't reopen it.

---

## Suggested order of execution

```
Phase 0  (lint gate)            ──┐  do first; cheap; gives every later phase regression cover
Phase 1  (dead code + style)    ──┤  cheap, low-risk, independent
Phase 2  (objectPath dedup)     ──┘  tests-first; one caller per commit
Phase 3  (card-host decision)   ····  decide A/B/C; Option A is ~1h and can run anytime
Phase 4  (sweep + docs)         ····  one-off knip pass + doc status headers; partly ongoing
```

Phases 0–2 are a focused day of work that materially lowers the cost of every future change. Phase 3's
**Option A** is an hour and stops the worst double-maintenance. Phase 4 is a tidy-up you can do incrementally.
None of it changes what the app does — it changes how safely you can change it.
