# RP Terminal — Codebase Health Check

> **Superseded by [codebase-health-check-2026-06-24.md](codebase-health-check-2026-06-24.md).** The
> metrics below are point-in-time (304 tests, lint 761, `MessageScriptFrame` orphan, `objectPath` not yet
> extracted) and no longer reflect the code — the cleanup backlog has since been closed. Kept for history.

_Read-only diagnostic, 2026-06-22. Scope: whole-repo orientation + the failure modes that accumulate when a
project is built incrementally by an AI assistant. No code was changed._

---

## Verdict: **HEALTHY** (solid core, with a normal cleanup backlog)

The project **builds, runs, and is well-tested.** `npm run typecheck` (node + web) passes, `electron-vite
build` succeeds, and **304 tests across 34 files pass.** The dependency lockfile is coherent (no
missing/UNMET/extraneous), **no secrets are committed**, and there is exactly **one `TODO`** in all of
`src/`. For a multi-session AI build, that's a genuinely good baseline — nothing here is broken or on fire.

What's accumulated is **cruft, not breakage**: one orphaned component, a small utility reimplemented ~4–6
times, two parallel implementations of the card-host layer mid-migration, an ESLint config not tuned for a TS
project (so lint is unusable as a gate), and some doc drift. None of it threatens correctness; all of it is
the kind of thing worth tidying before it compounds. **Not shaky, not in trouble — healthy with a backlog.**

> The scariest-looking number, `289 ESLint errors`, is almost entirely noise: 225 intentional `any` + 26
> redundant `react/prop-types` (this is a TypeScript project) + a few return-type/empty-function nits. There
> are **no logic bugs surfaced by lint.**

---

## The basics (sanity checks)

| Check                         | Result                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Builds?                       | ✅ `npm run typecheck` + `electron-vite build` pass                                                                                      |
| Tests?                        | ✅ **304 pass**, 34 test files (`test/*.test.ts`) — strong breadth over the pure modules                                                 |
| Secrets committed?            | ✅ None (`sk-…`/`AIza…`/PEM scan clean; API keys are encrypted via `safeStorage` in `settingsService.ts`)                                |
| Deps coherent?                | ✅ `package-lock.json` present (464 KB), `npm ls --depth=0` clean                                                                        |
| Dead deps?                    | ✅ `vue`/`vue-router`/`pinia`/`jquery` look unused but are **lazily provided to card scripts** (`wcvPreload.ts:416,429–431`) — justified |
| `node_modules`/`out` ignored? | ✅ in `.gitignore`; the SQLite data dir lives under `app.getPath('userData')` (outside the repo)                                         |

---

## A. Docs ↔ code drift + consolidation — _severity: Low–Medium_

There are **14 docs** (CLAUDE.md, ROADMAP.md, + 12 in `docs/`). Findings:

1. **`CLAUDE.md` was stale on the IPC layout** — it said `src/main/index.ts` holds "**ALL** ipcMain handlers,"
   but `index.ts` is a thin entry that calls `registerIpc(ipcMain)` ([ipc/index.ts](src/main/ipc/index.ts)),
   which delegates to 10 domain modules (`profileIpc`, `chatIpc`, …). ✅ **Fixed 2026-06-22** — the structure
   block now describes `index.ts` correctly and lists the previously-missing `ipc/`, `shared/`, `wcvPreload.ts`,
   `workers/`, and renderer `plugin/`. _(was Low)_
2. ~~`ROADMAP.md` untracked while `CLAUDE.md` links it~~ — **mis-finding, corrected 2026-06-22.** Both
   `CLAUDE.md` and `ROADMAP.md` are _intentionally_ gitignored (`.gitignore`: "AI assistant / planning files —
   kept local, not tracked in the repo"). A clone has neither, so there's no broken cross-reference. No action.
   _(Info)_
3. **Status is tracked in three overlapping places:** `ROADMAP.md`, `docs/progress-log.md`, and the git
   history. `progress-log.md` is a hand-maintained "newest first" changelog that largely restates commits.
   Pick one source of truth. _(Low)_
4. **Completed design docs aren't marked/archived.** Several `docs/*-design.md` (`mvu-support-design`,
   `mvu-panel-workspace-design`, `card-custom-ui-design`, `plugin-system-design`, and now
   `st-prompt-template-plan`) describe features that are **done**, while `agentic-mode-design.md` is still
   aspirational. Nothing distinguishes "design I'm about to build" from "design I already built." Suggest a
   `docs/archive/` (or a `Status: implemented` header) so the live docs are obvious. _(Low–Medium for
   navigability)_
5. No _contradictory_ doc claims found beyond #1 — the architecture description in CLAUDE.md otherwise
   matches the code (two-process split, services-as-function-modules, SQLite + JSON files, Zod schemas).

---

## B. Unfinished work — _severity: Low_

Remarkably little. The whole `src/` tree has **one** `TODO` and a couple of honest, documented stubs:

- `generationService.ts:111` — `// TODO(agentic): when agent.mode === 'agentic', classify intent here…`. The
  `agent.mode` setting offers `off | manual | agentic`, but **`agentic` currently behaves exactly like
  `manual`** (auto-routing isn't built; `SettingsPanel.tsx:101` even says "auto-routing coming soon"). So the
  third mode is a labeled placeholder, not a bug — just know it's inert. _(Low)_
- `generationService.ts:454` `generateImage()` — a deliberate, logged stub returning `null` ("no image
  provider wired; the API surface exists so cards degrade gracefully"). Honest and intentional. _(Info)_
- `characterIpc.ts:34` — bundled-card **plugins are "skipped — not yet supported"** on import. A known gap,
  surfaced to the user in the import summary. _(Info)_

No "throw 'not implemented'" landmines, no silently-empty handlers found.

---

## C. Inconsistency across the codebase — _severity: Low_

- **Error reporting in `main` is mixed.** CLAUDE.md says main-process errors should go through
  `logService.log('error', …)` so they reach the Logs panel + stdout. But **12 `console.error/warn` calls
  live in 8 main files** (`characterService`, `presetService`, `regexService`, `storageService`, the
  `stPng`/`stRegex`/`content` parsers). Those errors won't appear in the in-app Logs panel. Minor drift; the
  parsers arguably shouldn't depend on `logService`, so it's defensible — but it's inconsistent. _(Low)_
- **Semicolon style drift** (already noted in CLAUDE.md): Prettier config is no-semicolons, but some early
  renderer files still carry them (e.g. `stores/settingsStore.ts`). Cosmetic; Prettier would fix on `--write`.
  _(Low)_
- **Two naming conventions for the same path helper** — `getPath`/`setPath` in most modules vs
  `getByPath`/`setByPath` in `wcvPreload.ts`. See Duplication below. _(Low)_

---

## D. Dead / orphaned code — _severity: Medium_

- **`MessageScriptFrame.tsx` is orphaned.** It's defined + exported ([MessageScriptFrame.tsx:34](src/renderer/src/components/MessageScriptFrame.tsx))
  but **never rendered** (`<MessageScriptFrame` has zero matches in `src/`). It's the retired in-message
  iframe card path, superseded by `WcvMessageFrame` (which `MessageContent.tsx` actually uses). Safe-looking
  delete candidate (it still has a passing test via `messageContent.test.ts`, so check that first). _(Medium)_
- **A whole "retired" iframe card-host subsystem is in a transitional/parallel state.** Per ROADMAP's
  2026-06-22 decision ("WCV for ALL card-facing rendering; iframe retired for cards, kept for trusted APP UI"),
  the iframe stack — `CardScriptHost`, `plugin/dispatch.ts`, `plugin/bridgeShim.ts`, `plugin/sourceRewrite.ts`,
  `plugin/slash.ts`, `plugin/stscript.ts`, `plugin/audioService.ts`, and `plugin/shims/*` (a second,
  clean-room TavernHelper compat layer separate from `wcvPreload.ts`) — is **superseded for card rendering**
  but **still wired**: `CardScriptHost` is rendered by `viewRegistry.tsx:49` (the workspace panel UI). So it's
  not dead yet, but it's a large block of code living alongside its replacement. **This is the single biggest
  source of latent cruft.** It is well-tested (8+ of the 34 test files cover it), so it's not rotting — but
  the migration to WCV needs to finish, or this stays as permanent dual-maintenance. _(Medium — see
  Over-engineering / Duplication.)_
- I did not run an exhaustive unused-export sweep. **Recommend `knip` or `ts-prune`** for a full pass — with
  two known card-host layers in flight, there are likely more orphaned exports than `MessageScriptFrame`.

---

## E. Duplication — _severity: Medium_

- **Two TavernHelper / card-host compat layers.** The iframe `plugin/shims/tavern.ts` (+ `lib`, `bridge`,
  `stRuntime`, `jquery`) and the WCV `preload/wcvPreload.ts` are **two implementations of the same
  TavernHelper/MVU/SillyTavern surface.** This is intentional-but-temporary (the WCV-supersedes-iframe
  migration), and is already flagged in your own memory as "the two compat layers." It's the costliest
  duplication: any TH-API change must be made twice until the iframe path is removed. _(Medium)_
- **Small utilities reimplemented 4–6×:**
  - dot-path `getPath`/`setPath`/`toParts`: `shared/templateEngine.ts:72–88`, `parsers/mvuParser.ts:66–81`,
    `services/pluginService.ts:21–37`, `shared/macros.ts:32`, `renderer/.../plugin/stscript.ts:140`, plus the
    `getByPath`/`setByPath` variant in `wcvPreload.ts:110–114`.
  - deep-clone `const clone = v => JSON.parse(JSON.stringify(v))`: `mvuParser.ts:105`, `mvuZod.ts:128`,
    `mvuSchema.ts:19`, `shared/workspaceLayout.ts:42`.
  - `deepMerge`: `mvuSchema.ts:22` (and the lodash-subset `_.merge` in `templateEngine.ts`).

  They're _slightly_ different (some handle the MVU `-` array marker, some accept `null` paths), so a naive
  merge would be wrong — but a single `shared/objectPath.ts` (get/set/parts/clone/merge) would remove ~5
  copies and the drift risk. _(Medium-Low)_

---

## F. Over-engineering — _severity: Low (context-dependent)_

The repo is large for an "MVP foundation" (CLAUDE.md's own framing), with several full subsystems:

- **Plugin system** — `pluginService` + `pluginHostService` + `pluginNetService` + `pluginStorageService` +
  `pluginIpc` + `PluginsPanel` + `pluginsStore` + `PluginHost`, plus `docs/plugin-system-design.md` and
  `docs/plugin-api.md`. It's fully wired (`registerPluginIpc`) but **has no test** (none of the 34 test files
  touch it). For an app whose primary user is still you, a full plugin platform _plus_ a card-script system
  _plus_ a sandbox is a lot of surface to maintain. Not wrong — but worth asking whether the plugin system is
  earning its keep yet, or is ahead of demand. _(Low — judgment call)_
- **Sandbox** (`sandboxService`/`sandboxRunner`/`sandboxWorker`, quickjs in a `utilityProcess`/worker) — this
  one is **justified**: it runs untrusted card schema/UI scripts, it's tested (`sandboxRunner.test.ts`), and
  the security need is real.
- Otherwise the abstractions match the problem (services as function modules, IPC-by-domain, Zod at the
  boundaries). No gratuitous DI/factory/layering.

---

## G. Performance — _severity: Low_

Mostly fine; a few things to be aware of, none hot enough to act on now:

- **Per-build full-lorebook scans.** `promptBuilder` now scans every entry twice on a build that has marker
  entries: once for `@@activate` forcing and (via `generationService.getRenderMarkers`) once for `[RENDER:*]`.
  On the 469-entry example card that's ~900 cheap ops/build. Both are guarded by an anchored-regex pre-filter
  (`looksMarked`) so the expensive `parseEntryMarker` only runs on candidates — acceptable, but it's O(entries)
  on the generation hot path. _(Low)_
- **Render-time eval is correctly rate-limited** (every ~500 tokens via a quantized `useMemo` checkpoint in
  `StreamingView.tsx`) and `StreamingView` is isolated so per-frame streaming doesn't reconcile the whole
  chat. Good.
- **No SQLite N+1 found in the hot paths** — `getAllFloors` is a single query; session lorebooks are a small
  `map(getLorebookById)` over the chat's few selected ids. Fine.
- **Bundle:** the WCV preload now bundles the shared EJS engine (~27 KB) and `require`s the quickjs singlefile
  variant at runtime; the renderer embeds a singlefile WASM (~1.5 MB) — expected for an Electron app, not a
  web bundle, so size is a non-issue.

---

## H. Maintainability — _severity: Medium (lint hygiene)_

- **ESLint is unusable as a gate: 761 problems (289 errors / 472 warnings).** Decomposed:
  - `449` `prettier/prettier` — almost entirely **CRLF vs LF churn** (Windows `autocrlf` vs Prettier's
    `endOfLine: lf`). Not code issues. **Fix once** with `.gitattributes` (`* text=auto eol=lf`) or
    `endOfLine: "auto"` in `.prettierrc`.
  - `225` `@typescript-eslint/no-explicit-any` — intentional dynamic typing (the VM bridge, the card shim,
    MVU's untyped state). A few files (`templateEngine.ts`, `wcvPreload.ts`) already carry a scoped
    `eslint-disable`; the rest don't, so the rule just generates noise. Either disable per-file where `any`
    is deliberate, or accept it — but right now it drowns out real findings.
  - `26` `react/prop-types` — **a config bug:** `eslint-plugin-react`'s `prop-types` rule is on, but this is a
    **TypeScript** React project where prop-types are redundant. Turn the rule off in `eslint.config.mjs`.
  - `~11` `react-hooks/set-state-in-effect` (the pagination effects in `ChatView.tsx`), `12`
    `explicit-function-return-type`, `4` `no-empty-function` (the intentional no-op stubs), `3` `prefer-const`,
    `23` `exhaustive-deps` (mostly the intentional "re-run trigger" dep pattern).

  **Net:** there are no real bugs hiding in the lint, but its signal-to-noise is so low it's effectively off.
  ~30 minutes of config tuning (prettier eol, drop `react/prop-types`, scope `no-explicit-any`) would drop
  this from 761 → a small, _meaningful_ number you could actually gate on. **This is the highest-value
  maintainability fix.** _(Medium)_

- **Comments are good** — they explain _why_ (provider quirks, safety nets, the sync-vs-async shim rule),
  matching the house style. No misleading comments spotted beyond the CLAUDE.md `index.ts` claim (A.1).
- **Coupling is reasonable** — `src/shared` correctly imports nothing from `src/main`/`src/renderer`; services
  are function modules; the IPC bridge is the single renderer↔main seam.

---

## Prioritized backlog (what actually deserves attention)

**Worth doing (cheap, high-value):**

1. **Tune ESLint** so it's a usable gate: `.gitattributes` eol fix (−449), turn off `react/prop-types` (−26),
   scope `no-explicit-any` per-file (−~200). [H] — biggest ROI.
2. **Delete `MessageScriptFrame.tsx`** (orphaned), after confirming `messageContent.test.ts` doesn't depend on
   it. [D]
3. ✅ **Done (2026-06-22)** — fixed CLAUDE.md's `index.ts` IPC claim + the `ipc/`/`shared/`/`wcvPreload`/
   `workers`/`plugin` structure omissions. (The "ROADMAP untracked" sub-item was a mis-finding — both planning
   docs are gitignored by design.) [A]

**Worth doing soon (medium effort):** 4. **Extract `shared/objectPath.ts`** and collapse the 4–6 `getPath`/`setPath`/`clone` copies into it
(carefully — they differ slightly). [E] 5. **Finish or formally pause the iframe→WCV card-host migration.** Right now you maintain two TavernHelper
layers + two card-host stacks. Decide the timeline; until then, every TH-API change is double work. [D/E] 6. **Run `knip`/`ts-prune`** to find the rest of the orphaned exports the two-card-host transition likely left.

**Fine as-is / conscious choices (don't sweat):**

- The `generateImage`/agentic/`plugins-skipped` stubs (documented, graceful).
- The sandbox subsystem (justified by the untrusted-script threat model).
- `vue`/`pinia`/`jquery` deps (lazily provided to cards).
- `console.error` in the pure parsers (defensible).
- Bundle sizes (Electron, not web).

---

_Bottom line: this is a healthy, well-tested codebase carrying the ordinary sediment of an incremental build.
The one structural thing to keep honest is the **iframe→WCV card-host migration** (two parallel stacks); the
rest is an afternoon of hygiene._
