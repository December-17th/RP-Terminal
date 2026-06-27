# SP2 — Rendering-Environment Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give an unmodified ST/JSR card the document environment it expects — the assumed library globals
(jQuery-UI + touch-punch, FontAwesome, Tailwind, on top of today's Vue/jQuery/Pinia/VueRouter), the
`--TH-viewport-height` viewport variable + a Fit/Fill `vh` sizing mode, the user/char avatar CSS — and expose
the card surface on the renderer `window.top` so full-page (`window.top`-using) cards work in **inline** mode.
Rendering-env injection becomes a **single shared builder** used by both transports (extending the SP1
anti-drift discipline from the API surface to the document surface).

**Architecture:** A pure `src/shared/cardEnv.ts` produces the card `<head>` fragment (base reset + avatar CSS +
assumed-libs tags + `--TH-viewport-height` bootstrap) and the `replaceVhInContent` transform. Both transports
(`InlineCardFrame`, `WcvMessageFrame`) compose `buildEnvHead(opts)` into their `buildCardDoc` `headInject`; only
per-realm bits differ (lib URLs, avatar URLs, sizing). A Fit/Fill sizing mode reuses the existing `renderMode`
override plumbing (global default + regex `_meta` sidecar + block marker). A managed top-window surface
(`topSurface.ts`) exposes the card API on the renderer's top frame, bound to the active session.

**Tech Stack:** TypeScript (strict), Vitest, electron-vite (renderer + preload rollup builds), Zustand, the SP1
`shared/thRuntime` + adapters, the `rpt-card://` scheme. Tailwind = a vendored runtime JIT build (decision §6.1
of the spec).

**Spec:** [docs/superpowers/specs/2026-06-23-sp2-rendering-env-parity.md](../specs/2026-06-23-sp2-rendering-env-parity.md)

## Global Constraints

- Prettier: **no semicolons, single quotes, 2-space indent, printWidth 100, no trailing commas**.
- `any` is intentional at the card boundary (the repo disables `@typescript-eslint/no-explicit-any`).
- `src/shared/cardEnv.ts` imports **nothing realm-specific** (no `electron`, `window`, Zustand, `fs`, no
  quickjs variant) — only its own constants/types. It must resolve in BOTH the renderer and preload builds.
- **Clean-room:** the JSR source (`E:/Projects/SillyTavern/.../JS-Slash-Runner/src/iframe/*`) is read only to
  fix the compat target; never copy/vendor JSR code or load JSR's own `lib/tailwindcss.min.js`. Obtain
  Tailwind/jQuery-UI from their own distributions.
- Run `npm run typecheck`, `npm test`, `npm run build` before each task's commit; no new lint errors.
- Strangler: the app builds, typechecks, and renders cards at every step. `fit` (today's behavior) stays the
  default throughout, so no task regresses existing inline/WCV cards.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Create `src/shared/cardEnv.ts` — pure head-builder + `replaceVhInContent` + lib-URL/CSS constants.
- Create `src/renderer/src/cardBridge/topSurface.ts` — `installCardTopSurface()` + active-session rebind.
- Create `test/cardEnv.test.ts`, `test/cardSizing.test.ts`.
- Vendor: `resources/cardlibs/tailwind.min.js` (Tailwind runtime JIT) — see Task 2.
- Modify: `InlineCardFrame.tsx`, `cardBridge/cardLibs.ts`, `cardBridge/index.ts`, `WcvMessageFrame.tsx`,
  `wcvPreload.ts`, `cardDoc.ts` (callers only), `cardRenderMode.ts`, `regexTypes.ts`, `scopeMeta.ts`,
  `regexService.ts`, `regexIpc.ts`, `preload/index.ts`, `regexStore.ts`, `regexTransform.ts`,
  `MessageContent.tsx`, `RegexPanel.tsx`, `SettingsPanel.tsx`, `settingsStore.ts`, `settingsService.ts`,
  `main/types/models.ts`, `shared/thRuntime/types.ts` (+ both Host adapters), `package.json`.

---

### Task 1: `shared/cardEnv.ts` — the pure rendering-env builder (+ tests)

**Files:** Create `src/shared/cardEnv.ts`, `test/cardEnv.test.ts`. No wiring yet.

**Interfaces (produced):**

```ts
export type CardSizing = 'fit' | 'fill'
export interface EnvHeadOpts {
  libTags: string // pre-rendered <script>/<link> tags for the assumed libs (resolved per realm)
  userAvatarUrl?: string // empty/undefined → the .user_avatar rule is omitted
  charAvatarUrl?: string
  sizing: CardSizing
  viewportHeightPx?: number // initial --TH-viewport-height; default a sane fallback
}
export function buildEnvHead(opts: EnvHeadOpts): string
export function replaceVhInContent(html: string): string
export const BASE_RESET_CSS: string // the box-sizing + html,body reset (moved from InlineCardFrame)
```

- [ ] **Step 1: `BASE_RESET_CSS`** — move the exact reset string out of `InlineCardFrame` verbatim
      (`*,*::before,*::after{box-sizing:border-box}` + `html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important}`).
- [ ] **Step 2: avatar CSS** — a helper that, given `userAvatarUrl`/`charAvatarUrl`, emits
      `.user_avatar,.user-avatar{background-image:url('…')}` / `.char_avatar,.char-avatar{…}`; omit a rule whose
      URL is empty (no `background-image:none` needed — just skip it).
- [ ] **Step 3: `--TH-viewport-height` bootstrap** — a tiny inline `<script>` that sets
      `document.documentElement.style.setProperty('--TH-viewport-height', viewportHeightPx + 'px')` and (faithful
      to JSR) listens for a `message` of `{type:'TH_UPDATE_VIEWPORT_HEIGHT', height}` to re-set it. (Inline will
      also set it directly same-origin in Task 7; the script makes the doc self-contained / WCV-friendly.)
- [ ] **Step 4: `buildEnvHead(opts)`** — concatenate, in order: `<style>` (BASE_RESET_CSS + avatar CSS) +
      `opts.libTags` + the viewport bootstrap. `libTags` is passed in (Task 2 builds it per realm) so `cardEnv`
      stays pure and URL-agnostic.
- [ ] **Step 5: `replaceVhInContent(html)`** — clean-room reimplementation of the JSR transform (read the
      behavior, write our own): rewrite `min-height:…NNvh` → `var(--TH-viewport-height)` when `NN===100`, else
      `calc(var(--TH-viewport-height) * NN/100)`, at four sites — CSS declaration blocks, inline `style="…"`, JS
      `.style.minHeight="…vh"`, `.style.setProperty('min-height',"…vh")`. **Only `min-height`** (a bare
      `height:100vh` is untouched). No-op fast-path when the content has no `vh`.
- [ ] **Step 6: tests** (`test/cardEnv.test.ts`): `replaceVhInContent` for each site, the 100 vs non-100 cases,
      `height:100vh` untouched, the no-`vh` no-op; `buildEnvHead` order (style → libs → viewport bootstrap),
      avatar rules present/omitted by URL, base reset present.

**Verify:** `npm test` (new file green), typecheck, build. No app behavior change yet (unwired).

---

### Task 2: Vendor + resolve the assumed libraries

**Files:** `package.json`, `resources/cardlibs/tailwind.min.js` (vendored), `cardBridge/cardLibs.ts`, and a
small URL-set helper (in `cardLibs.ts` for inline; a parallel const for WCV in Task 5).

JSR's `third_party` set, by resolution kind (spec §3/§4.2):

| Lib                              | Kind       | Inline source                                | WCV source                                  |
| -------------------------------- | ---------- | -------------------------------------------- | ------------------------------------------- |
| FontAwesome CSS                  | `<link>`   | jsDelivr CDN                                 | same CDN                                    |
| jQuery-UI base theme CSS         | `<link>`   | jsDelivr CDN                                 | same CDN                                    |
| Tailwind runtime JIT             | `<script>` | vendored `?url`                              | vendored, served via `rpt-card://` (or CDN) |
| jQuery-UI JS                     | `<script>` | npm `jquery-ui/dist/jquery-ui.min.js` `?url` | CDN                                         |
| jquery-ui-touch-punch            | `<script>` | CDN (no clean npm dist)                      | CDN                                         |
| Vue / jQuery / Pinia / VueRouter | `<script>` | existing `?url` (unchanged)                  | existing                                    |

- [ ] **Step 1: deps** — add `jquery-ui` to `package.json` (provides `dist/jquery-ui.min.js` +
      `themes/base/theme.min.css`). Do NOT add `jquery-ui-touch-punch` if it has no usable dist — use its CDN URL.
- [ ] **Step 2: vendor Tailwind** — add a Tailwind **runtime/Play** standalone build at
      `resources/cardlibs/tailwind.min.js`. Prefer a **v3 Play-CDN standalone** for card-compat (cards are authored
      against JSR's v3-era Tailwind; v4 `@tailwindcss/browser` drops/renames utilities — note the risk if v4 is
      chosen instead). Confirm electron-vite copies `resources/**` into the build, or import it via `?url` from the
      renderer so Vite fingerprints it.
- [ ] **Step 3: inline lib tags** — extend `CARD_LIB_URLS` / add a `buildInlineLibTags()` that emits, in JSR
      order: FontAwesome `<link>`, Tailwind `<script>`, jQuery `<script>`, jQuery-UI `<script>`, jQuery-UI theme
      `<link>`, touch-punch `<script>`, Vue, Vue-Router, Pinia. Keep the existing `?url` imports for the four we
      vendor; add `?url` for jQuery-UI + Tailwind; CDN URLs (constants) for FontAwesome / jQuery-UI theme /
      touch-punch.
- [ ] **Step 4:** export the CDN URL constants from `cardEnv.ts` (pure) so both transports share them; the
      realm-specific `?url`/`rpt-card://` resolution stays in `cardLibs.ts` (inline) / the WCV equivalent (Task 5).

**Verify:** typecheck + build (confirm the `?url` imports + the vendored Tailwind resolve in the renderer
bundle). No wiring into the doc yet, so no runtime change.

---

### Task 3: `Host.userAvatarPath()` for the avatar CSS

**Files:** `src/shared/thRuntime/types.ts`, `src/renderer/src/cardBridge/host.ts`, `src/preload/wcvHost.ts`,
the WCV main IPC (add `wcv-host-get-user-avatar-sync`). `Host.charAvatarPath()` already exists.

- [ ] **Step 1:** add `userAvatarPath(): string | null` to the `Host` interface.
- [ ] **Step 2: inline adapter** — resolve from the persona/settings store (the persona avatar, if RPT stores
      one); return `null` if none. Confirm what RPT persists for persona avatars first; `null` is acceptable.
- [ ] **Step 3: WCV adapter** — `ipcRenderer.sendSync('wcv-host-get-user-avatar-sync')`; add the ctx-scoped
      handler (mirror `…-get-char-avatar`). Return the resolvable URL/path.
- [ ] **Step 4:** if persona avatars don't exist in RPT yet, make this a no-op returning `null` and note it —
      the `.user_avatar` rule is simply omitted (Task 1 Step 2). Don't build a persona-avatar feature here.

**Verify:** typecheck, test, build. (No visible change until Task 4/5 inject the CSS.)

---

### Task 4: Inline integration — compose `buildEnvHead` in `InlineCardFrame`

**Files:** `InlineCardFrame.tsx` (and remove the inline `reset` string now living in `cardEnv`).

- [ ] **Step 1:** replace the locally-built `reset` + `libTags` with
      `buildEnvHead({ libTags: buildInlineLibTags(), userAvatarUrl, charAvatarUrl, sizing: 'fit', viewportHeightPx })`,
      composed AFTER the `__rptCardBridge` bootstrap (`headInject = boot + buildEnvHead(...)`). Avatar URLs come
      from `host.charAvatarPath()` / `host.userAvatarPath()` resolved to renderer-loadable URLs (the bridge ctx
      already gives the session; reuse the same store reads `InlineCardFrame` does).
- [ ] **Step 2:** always define `--TH-viewport-height` (Task 1 bootstrap) even in `fit` — initialized to the
      current fitted height (or `window.innerHeight` as the initial guess; Task 7 refines per sizing).
- [ ] **Step 3:** keep `neutralizeViewportHeight` + `fitInlineCardHeight` (this is `fit`, the default). Sizing
      branching (skip neutralize in `fill`) lands in Task 7.

**Verify:** Electron smoke — the previously-working inline cards (ellia / 角色查看器 in inline) still render;
a Tailwind-utility card now styles; a FontAwesome-icon card shows glyphs; a `$.ui` card works. Tests/build green.

---

### Task 5: WCV integration — shared env head; drop preload document-libs

**Files:** `WcvMessageFrame.tsx` (doc build), `wcvPreload.ts` (remove the document-lib `require`s).

- [ ] **Step 1:** in `WcvMessageFrame`'s `buildCardDoc` call, compose `headInject = cspMeta + buildEnvHead({...})`
      with a `buildWcvLibTags()` (the same lib set; URLs = CDN, and the vendored Tailwind served via `rpt-card://`
      or CDN per Task 2). Avatar URLs resolve to a scheme/file URL the WCV can load.
- [ ] **Step 2:** remove the `lazyGlobal('Vue'|'VueRouter'|'Pinia')` + lazy jQuery document-lib injection from
      `wcvPreload.ts` (those now load as `<script src>` in the doc head, defining the SAME globals in the card
      realm). KEEP the runtime's realm-bound `_`/`z`/`toastr` (API surface, not document libs).
- [ ] **Step 3:** verify a WCV card that uses Vue/jQuery/Pinia + a new lib (jQuery-UI/FA/Tailwind) binds the
      globals from the doc-injected scripts (not the preload). Watch the detached DevTools for any missing global.

**Verify:** Electron smoke — 命定之诗 status (WCV) still renders + live-updates; the new libs resolve. Tests/build
green. (After this, the assumed-libs set is defined in ONE place for both transports.)

---

### Task 6: Fit/Fill sizing — type + override plumbing (mirror `renderMode`)

**Files:** `cardRenderMode.ts`, `regexTypes.ts`, `scopeMeta.ts`, `regexService.ts`, `regexIpc.ts`,
`preload/index.ts`, `regexStore.ts`, `regexTransform.ts`, `MessageContent.tsx`, `settingsStore.ts`,
`settingsService.ts`, `main/types/models.ts`, `RegexPanel.tsx`, `SettingsPanel.tsx`, `test/cardSizing.test.ts`.
**Do for `sizing` exactly what `renderMode` already does in each of these files** (renderMode is the template).

- [ ] **Step 1: type** — `cardRenderMode.ts`: add `CardSizing` (re-export from `cardEnv` or define alongside),
      `DEFAULT_CARD_SIZING='fit'`, `resolveCardSizing(override, globalDefault)` (same shape as `resolveCardMode`).
      Test in `test/cardSizing.test.ts`.
- [ ] **Step 2: settings** — `settings.cards` gains `sizing: 'fit'|'fill'` (default `'fit'`) across
      `settingsStore.ts` / `settingsService.ts` normalize/default / `main/types/models.ts`.
- [ ] **Step 3: regex `_meta` sidecar** — `RegexScriptInfo.sizing` + `RenderRegexRule.sizing` (`regexTypes.ts`);
      `scopeMeta.ts` read/write `sizing`; `regexService.setScriptSizing` (mirror `setScriptRenderMode`);
      `regexIpc.ts` + `preload/index.ts` (`window.api.setRegexSizing`); `regexStore.ts` carry it.
- [ ] **Step 4: block marker** — `regexTransform.ts` emits `<!--rpt:sizing=fill-->` next to the existing mode
      marker; `splitHtml` (in `MessageContent.tsx`) parses + strips it and attaches `sizing` to the segment;
      `MessageContent` resolves `resolveCardSizing(segment.sizing, settings.cards.sizing)` and passes it to the
      frame. (Mirror the `<!--rpt:mode=…-->` parsing exactly, incl. the "parse before a fenced payload" fix.)
- [ ] **Step 5: UI** — `RegexPanel.tsx`: a Fit/Fill/Default selector beside Inline/Isolated; `SettingsPanel.tsx`:
      a global default control under the existing card render-mode setting.
- [ ] **Step 6: tests** — `resolveCardSizing` + the `sizing` marker round-trip in `splitHtml` (mirror the
      renderMode marker tests).

**Verify:** typecheck, full test suite, build. Sizing is plumbed but both frames still behave as `fit` until
Task 7 consumes it — so still no behavior change.

---

### Task 7: Apply the sizing mode at render

**Files:** `InlineCardFrame.tsx`, `WcvMessageFrame.tsx` (+ the height helpers, unchanged API).

- [ ] **Step 1:** both frames accept the resolved `sizing` prop. Pass `sizing` into `buildEnvHead`.
- [ ] **Step 2: inline `fill`** — apply `replaceVhInContent(html)` before `buildCardDoc`; SKIP
      `neutralizeViewportHeight`; size the frame with `capCardHeight(content, window.innerHeight)` (windowed); set
      `--TH-viewport-height` on the iframe `<html>` to the frame's effective height, and refresh it on
      `window` resize (same-origin write — no postMessage needed). `fit` = today's path unchanged (neutralize +
      `fitInlineCardHeight`), still defining `--TH-viewport-height` = fitted height.
- [ ] **Step 3: WCV `fill`** — apply `replaceVhInContent`; keep the existing capped overlay; push
      `--TH-viewport-height` via the host (or the faithful `TH_UPDATE_VIEWPORT_HEIGHT` message) on resize.
- [ ] **Step 4:** confirm `fit` is byte-identical to pre-SP2 behavior (regression guard for the existing cards).

**Verify:** Electron — a `min-height:100vh` card content-fits in `fit` and fills the frame in `fill`; toggling
the per-card Fit/Fill selector switches it; existing cards (default `fit`) unchanged. Tests/build green.

---

### Task 8: Expose the card surface on the renderer `window.top`

**Files:** Create `src/renderer/src/cardBridge/topSurface.ts`; modify `cardBridge/index.ts`.

- [ ] **Step 1:** `installCardTopSurface()` — guarded by `typeof window === 'undefined'` (test/SSR safety, like
      `installCardBridge`). Build the surface via the inline transport against the **active session ctx**
      (`{profileId, chatId, characterId}` from the stores) and assign ONLY the card-API surface onto the renderer
      window: `SillyTavern`, `TavernHelper` + its bare globals, `Mvu`, `EjsTemplate`, `tavern_events`, `toastr`,
      `errorCatched`. **Not** `window.api`; **not** the libs (Vue/$/\_/z) — a full-page card loads its own.
- [ ] **Step 2: lifecycle** — build once; subscribe to the profile/chat/character stores; on an active-session
      change, call the prior runtime's `__rptDispose` then rebuild (avoid the known store-subscription leak). The
      surface always reflects the open session.
- [ ] **Step 3:** call `installCardTopSurface()` from `cardBridge/index.ts` (next to `installCardBridge`) at
      module load.
- [ ] **Step 4:** confirm no global-name collision with the RPT app (it imports Vue/lodash as modules, not
      window globals; `SillyTavern`/`TavernHelper`/`Mvu`/`EjsTemplate` are card-only names).

**Verify:** Electron — 命定之诗 **home / 角色查看器 render INLINE** (read `window.top.SillyTavern...`), not just in
Isolated; combined with `fill` + `--TH-viewport-height` they size correctly. Toggle one to Isolated → identical.
Tests/build green.

---

## Sequencing & acceptance

```
T1 cardEnv core (+tests) → T2 vendor libs → T3 userAvatarPath →
T4 inline integration → T5 WCV integration  (assumed-libs + avatar + viewport now live, fit-only)
→ T6 sizing plumbing → T7 apply sizing  (Fit/Fill works)
→ T8 window.top surface  (inline full-page cards work)
```

Each task is its own commit (typecheck + test + build green; no new lint). `fit` remains the default the whole
way, so existing cards never regress. **Final acceptance** = the spec §8 criteria: one shared `cardEnv` feeds
both transports (WCV no longer `require()`s document libs); Fit/Fill mode (global + per-card, default `fit`);
inline `window.top` full-page cards resolve the surface; pure tests pass; `npm test`/`typecheck`/`build` green;
clean-room preserved (no JSR source vendored).

## Risks

- **Tailwind v3-vs-v4 utility coverage** (Task 2) — pick the build that matches the cards in use; v4 drops some
  v3 utilities. Vendor v3 Play unless a card needs v4.
- **WCV doc-libs vs preload** (Task 5) — moving libs from `require()` to `<script src>` changes WHEN/WHERE they
  bind; verify Vue/jQuery/Pinia still resolve in the WCV realm before deleting the preload `require`s.
- **`window.top` surface lifecycle** (Task 8) — the rebuild-on-session-change must dispose the prior runtime or
  it reintroduces the documented subscription leak.
- **Inline perf** — Tailwind JIT + jQuery-UI + FA load in the renderer process for every inline card (no
  isolation). Acceptable per the trusted-card stance; revisit if a card list feels heavy (spec §6.3 lazy option).

## Status (built 2026-06-23, branch `feat/sp2-rendering-env-parity`)

Implemented T1, T2, T4, T5, T6, T7, T8 (commits `ecc8e44`, `2976f2c`, `72a0f8f`, `062c11e`, `8bc97b4`,
`36805c1`, `31e884f`; T8 install fix `563f99e`). Static gate green at every commit: `npm run typecheck` +
`npm test` (452) + `npm run build`.

**Smoke-validated (2026-06-23, from this worktree):** the 命定之诗 **home gets its EJS environment INLINE**
— `window.top.{SillyTavern,…}` resolves (T8 confirmed). The app must be run from a build of THIS branch
(the main worktree `E:\Projects\RP Terminal` is on `feat/dual-mode-card-rendering`, which predates SP2 — a
build from there shows none of this). Expected/benign: the vendored Tailwind Play build logs
"cdn.tailwindcss.com should not be used in production" whenever a card loads it — that's the Play runtime's
own warning, not a CDN fetch (inline uses the vendored asset).

**Still only verifiable visually (deferred to your testing):** Tailwind/FA/jQuery-UI actually _styling_
cards, and `fill` sizing — no card in use exercises them yet.

**Scope decisions taken during the build (deviations from the plan, all noted in commits):**

- **T3 (avatar CSS) descoped** — RPT has no sync avatar source (`Host.charAvatarPath` is a `null` stub; the
  persona has no avatar field). The `cardEnv` avatar machinery is present and emits rules when a URL exists,
  so it lights up for free once avatar serving is wired. No `Host.userAvatarPath` was added.
- **jQuery-UI / touch-punch / FontAwesome via CDN, not npm** (only Tailwind vendored) — avoids mutating the
  _shared_ `node_modules` through the worktree junction; faithful to JSR, which CDN-loads them.
- **T5 lower-risk WCV variant** — the new libs inject into the WCV doc head (CDN); the core Vue/jQuery/Pinia/
  VueRouter stay in the `wcvPreload` lazy globals (working path untouched), rather than the plan's full
  "move everything to the doc head, define-once."
- **T6 per-card sizing override deferred** — only the GLOBAL `settings.cards.sizing` toggle shipped. The
  per-card override (regex `_meta` + block marker + per-card UI, mirroring `renderMode` across ~10 files) is
  a clean follow-up; the global toggle already delivers Fit/Fill.

Build-env note: this worktree's `node_modules` was an empty dir; a junction to the main repo's
`node_modules` was created so Vite's `?url` imports (and the vendored Tailwind) resolve. `node_modules` is
gitignored — not committed.
