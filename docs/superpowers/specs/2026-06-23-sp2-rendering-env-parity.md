# SP2 — Rendering-Environment Parity

> Second sub-project of the [JSR faithful-host architecture](2026-06-23-jsr-faithful-host-architecture.md).
> Make an inline/WCV card render in the **same environment** a SillyTavern + JS-Slash-Runner (JSR) card is
> authored against: the assumed library globals, the `--TH-viewport-height` viewport variable + `vh`
> sizing, the user/char avatar CSS, and — RPT-specific — exposing the card surface on the renderer
> `window.top` so full-page (`window.top`-using) cards work in **inline** mode too. No new TavernHelper
> domains (that's SP3+). Clean-room: the JSR source is read only to fix the compat target (which
> libs/versions/order, the exact `vh` rewrite); no JSR code is copied. Branch: `feat/sp2-rendering-env-parity`
> (off `feat/dual-mode-card-rendering`).

## 1. Problem

A card built for ST/JSR assumes a specific document environment that JSR's `createSrcContent`
(`src/panel/render/iframe.ts`) injects into every card iframe. RPT injects only a **subset** today, so
real cards render wrong:

- **Missing libs.** Inline injects `Vue` (full build), `jQuery`, `Pinia`, `VueRouter`
  (`cardBridge/cardLibs.ts`); WCV lazily `require()`s the same four (`wcvPreload.ts`). JSR additionally
  injects **jQuery-UI + its base theme CSS + jquery-ui-touch-punch**, **FontAwesome CSS**, and
  **Tailwind** (a runtime build). A card that uses `$.ui.*`, FontAwesome icon classes, or Tailwind
  utility classes silently degrades (no widgets, tofu boxes, unstyled layout).
- **No `--TH-viewport-height`.** JSR sets `--TH-viewport-height` on `<html>` to `window.parent.innerHeight`
  and **rewrites `min-height:NNvh` → `var(--TH-viewport-height)`** (or `calc(var(...) * N/100)`) in CSS,
  inline `style=`, and JS (`adjust_viewport.js` + `replaceVhInContent`), so cards FILL the window. RPT
  instead **neutralizes** `min-height:NNvh → 0` to force content-fit (`InlineCardFrame.neutralizeViewportHeight`).
  That's the right default for an embedded beautification, but it means a card *designed* to fill a viewport
  has no way to do so, and any card reading `var(--TH-viewport-height)` gets an empty value.
- **No avatar CSS.** JSR injects `.user_avatar/.char_avatar{background-image:url(...)}`; cards that show the
  speaker's avatar via those classes render blank in RPT.
- **`window.top` is dead inline.** A full-page card (命定之诗 home / 角色查看器) reads
  `window.top.SillyTavern...`. JSR's iframe is a direct child of the ST page, so `window.top` == the ST app
  and carries the surface. RPT's inline iframe sits in the renderer app frame, which only has
  `window.__rptCardBridge` — so `window.top.SillyTavern` is `undefined` and the card reports "EJS
  environment not accessible". These cards work only in Isolated/WCV today (where the card *is* its own top
  page). This is inline mode's one real **capability** gap.

## 2. Goal & non-goals

**Goal:** an unmodified ST/JSR card finds the environment it expects in **both** transports — the assumed
library globals, `--TH-viewport-height` + a `vh` sizing mode, avatar CSS — and full-page `window.top` cards
additionally work **inline**. Rendering-env injection is shared so the two transports can't drift (the SP1
discipline, extended from the *API* surface to the *document* surface).

**Non-goals (later sub-projects):**

- New TH API domains / filling API stubs — worldbook CRUD, chat write, regex write, audio, var-macros (SP3+).
- Process isolation for inline (deliberate: cards are trusted; Isolated/WCV is the crash-safe escape hatch —
  [[rp-terminal-security-stance]]).
- Tightening the card CSP (security hardening is parked; cards already run under blanket `https:`).
- `render_permanent` / ST-PT depth (track D).

## 3. Compat target (from the real JSR source — facts only, no code copied)

`createSrcContent(content)` (JSR `src/panel/render/iframe.ts`) wraps every card as:

```
<head>
  <meta charset> <meta viewport>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important}   ← RPT has this (899cd98)
    .user_avatar,.user-avatar{background-image:url('<user avatar>')}                              ← RPT lacks
    .char_avatar,.char-avatar{background-image:url('<char avatar>')}                              ← RPT lacks
  </style>
  <third_party>            ← the assumed-libs block, see below — RPT has only the Vue/jQuery part
  <script predefine>       ← merges window.parent.{TavernHelper,SillyTavern,Mvu,EjsTemplate,...} onto the iframe (≈ RPT __rptCardBridge)
  <script log.js>
  <script adjust_viewport> ← sets --TH-viewport-height = window.parent.innerHeight; refreshes on a postMessage  — RPT lacks
  <script adjust_iframe_height> ← sizes the frame to body.scrollHeight via a ResizeObserver  — RPT already equivalent
</head>
<body>{content}</body>
```

**`third_party_message.html` — the authoritative assumed-libs list** (in JSR's load order):

| Lib | JSR source | RPT today | SP2 |
| --- | --- | --- | --- |
| FontAwesome CSS | `@fortawesome/fontawesome-free/css/all.min.css` (CDN `<link>`) | ⬜ | **add** |
| Tailwind | local `lib/tailwindcss.min.js` (runtime build) | ⬜ | **add** (vendor — see §7) |
| jQuery | `npm/jquery` (CDN) | ✅ (`?url` / require) | keep |
| jQuery-UI JS | `npm/jquery-ui/dist/jquery-ui.min.js` | ⬜ | **add** |
| jQuery-UI theme CSS | `npm/jquery-ui/themes/base/theme.min.css` | ⬜ | **add** |
| jquery-ui-touch-punch | `npm/jquery-ui-touch-punch` | ⬜ | **add** |
| Vue | `vue.runtime.global.prod.min.js` (runtime-only) | ✅ `vue.global.prod.js` (**fuller** — includes the template compiler) | keep ours (superset) |
| Vue-Router | `vue-router.global.prod.min.js` | ✅ | keep |
| Pinia | — (JSR does **not** inject it) | ✅ | keep (RPT-ahead; 命定之诗 needs it) |

Load order matters: Tailwind/FontAwesome first, then jQuery → jQuery-UI → touch-punch, then Vue → Vue-Router
(Pinia after Vue, as today). jQuery-UI binds to a pre-existing `window.jQuery`; touch-punch patches
jQuery-UI; the Vue plugins bind to `window.Vue`.

**`--TH-viewport-height` mechanics** (`adjust_viewport.js`): `html { --TH-viewport-height: <parent.innerHeight>px }`,
re-set when the parent posts `{type:'TH_UPDATE_VIEWPORT_HEIGHT'}`. **`replaceVhInContent`** rewrites
`min-height:…NNvh` (only `min-height`, not `height`) to `var(--TH-viewport-height)` when `NN===100`, else
`calc(var(--TH-viewport-height) * NN/100)`, across four sites: CSS declaration blocks, inline `style="…"`,
JS `.style.minHeight="…vh"`, and `.style.setProperty('min-height',"…vh")`.

## 4. Design

### 4.1 A shared rendering-env head (both transports inject the same thing)

Per the umbrella architecture ("base reset, assumed libs, `--TH-viewport-height`, avatar CSS all live in
`buildCardDoc`, so both transports wrap cards identically"), move rendering-env injection into a shared
builder so inline and WCV can't drift — exactly the SP1 fix, now for the document surface.

- Add `src/shared/cardEnv.ts` (pure; no DOM/electron/Zustand): `buildEnvHead(opts)` returns the head string
  = base reset (moved out of `InlineCardFrame`) + avatar CSS (§4.3) + the assumed-libs block (§4.2) + the
  `--TH-viewport-height` bootstrap (§4.4). `opts` carries the per-realm bits that differ: the resolved lib
  URLs, the avatar URLs, the sizing mode (`fit`|`fill`), and the initial viewport height.
- `buildCardDoc(html, { headInject })` is unchanged; each transport composes
  `headInject = transportPreamble + buildEnvHead(opts)`:
  - **Inline** (`InlineCardFrame`): `transportPreamble` = the existing `__rptCardBridge` bootstrap; lib URLs
    = same-origin Vite `?url` assets + CDN URLs for CSS-only/CDN libs.
  - **WCV** (`WcvMessageFrame`): `transportPreamble` = the existing CSP `<meta>`; lib URLs = the same CDN
    URLs (CSP already allows `https:`) and/or assets served from the `rpt-card://` scheme.
- **WCV stops injecting the Vue/jQuery/… libs via `wcvPreload` `require()`** for the document libs — they
  move into the doc head as `<script src>` like inline, so the set is defined **once**. (The preload keeps
  only the realm-bound `_`/`z`/`toastr` it already exposes through the runtime — those stay API-surface,
  not document libs.) Verify a CDN/`rpt-card://`-served global build binds correctly in the WCV realm.

`replaceVhInContent` (§4.4) is a pure transform in `src/shared/cardEnv.ts`, applied to `html` before the
wrap, in both transports.

### 4.2 Assumed libraries

Inject the §3 set in JSR's order. Resolution per kind:

- **CSS-only (FontAwesome, jQuery-UI base theme)** → `<link rel="stylesheet">` to the jsDelivr CDN URL in
  **both** transports (CSP allows `https:`; no fonts to vendor — FontAwesome's CDN CSS references CDN
  webfonts). Parity with JSR, zero vendoring.
- **Core JS libs we already vendor (Vue/jQuery/Pinia/VueRouter)** → keep inline's same-origin `?url`; WCV
  loads the same global builds (decision §7 — CDN vs `rpt-card://`).
- **jQuery-UI JS + touch-punch** → add npm deps and `?url` for inline where a usable global dist exists
  (`jquery-ui/dist/jquery-ui.min.js`); touch-punch is unmaintained on npm — if no clean dist, load from the
  jsDelivr CDN in both transports (acceptable; CSP allows it).
- **Tailwind** → §7 decision (vendor a runtime build vs a prebuilt utility CSS). Heaviest item; isolate it.

Keep Vue **full** build (template compiler) over JSR's runtime-only — strictly more capable, and some cards
compile templates at runtime. Keep Pinia (JSR omits it; RPT cards use it).

### 4.3 Avatar CSS

Append to the base reset, both transports: `.user_avatar,.user-avatar{background-image:url('<user>')}` and
`.char_avatar,.char-avatar{background-image:url('<char>')}`. Sources:

- **Char avatar**: `Host.charAvatarPath()` already exists (SP1). Resolve to a URL the iframe/WCV can load
  (same-origin asset path for inline; `rpt-card://`/file URL for WCV — confirm the scheme serves it).
- **User/persona avatar**: no `Host` getter today. Add `Host.userAvatarPath()` (inline: persona/settings
  store; WCV: a new `wcv-host-…-sync`), or fall back to empty (`background-image:none`) if RPT has no user
  avatar configured. Empty is acceptable — the rule just no-ops.

These are URLs passed into `buildEnvHead(opts)` so `cardEnv` stays pure.

### 4.4 `--TH-viewport-height` + a fit/fill sizing mode

Provide the variable and the JSR `vh` rewrite, but keep **content-fit the default** (RPT embeds cards
inline; JSR windows them). Add a **sizing mode** mirroring `renderMode`'s existing plumbing:

- **Type**: `src/shared/cardRenderMode.ts` gains `CardSizing = 'fit' | 'fill'`, `DEFAULT_CARD_SIZING='fit'`,
  `resolveCardSizing(override, globalDefault)` (same shape as `resolveCardMode`).
- **`fit` (default)**: today's behavior — neutralize `min-height:NNvh→0`, frame fits content
  (`fitInlineCardHeight`). Still **define** `--TH-viewport-height` (so a card reading it computes), set to the
  fitted frame height.
- **`fill`**: apply `replaceVhInContent` (rewrite `min-height:NNvh → var(--TH-viewport-height)`), set
  `--TH-viewport-height` to the frame's effective height, and DON'T neutralize. Inline: the frame height
  becomes a chosen fraction of the chat viewport (reuse `capCardHeight`); WCV: its existing capped overlay.
  Refresh `--TH-viewport-height` on window resize (inline: a `ResizeObserver`/`resize` listener sets the CSS
  var on the iframe's `<html>`, same-origin — no postMessage needed; WCV: the existing host push, or the
  `TH_UPDATE_VIEWPORT_HEIGHT` message for faithfulness).
- **Override flow** = renderMode's: a global default in `settings.cards` (`sizing: 'fit'|'fill'`) + a per-card
  `_meta` sidecar field (`scopeMeta` / `RegexScriptInfo.sizing` / `RenderRegexRule.sizing`), emitted as a
  marker alongside `<!--rpt:mode=…-->` (e.g. `<!--rpt:sizing=fill-->`), parsed in `splitHtml`, resolved in
  `MessageContent`. UI: a Fit/Fill selector next to the Inline/Isolated one in `RegexPanel`, and a global
  default in `SettingsPanel`.

### 4.5 Expose the card surface on the renderer `window.top` (inline full-page cards)

So a `window.top.SillyTavern` / `window.top.TavernHelper` / `window.top.Mvu` / `window.top.EjsTemplate` read
resolves for an inline card (it already resolves for WCV, where the card is its own top page).

- Install a **single managed top surface** on the renderer window (the inline card's `window.top`), built
  via the existing inline transport against the **active session ctx**
  (`{profileId, chatId, characterId}` from the stores — the same ctx `InlineCardFrame` computes). Expose only
  the **card-API surface** (`SillyTavern`, `TavernHelper` + its bare globals, `Mvu`, `EjsTemplate`,
  `tavern_events`, `toastr`, `errorCatched`) — **not** `window.api`, and **not** the libs (a full-page card
  loads its own libs in its own realm). Mirrors JSR `predefine.js` merging the parent's surface, but onto
  *our* top frame.
- **Lifecycle (avoid the known subscription leak):** build the surface **once**, rebuild+dispose-prior when
  the active profile/chat/character changes (subscribe to the stores in the app bootstrap, call the runtime's
  `__rptDispose` before replacing). Do **not** rebuild on every property access. This single live surface
  always reflects the currently-open session — coherent because `window.top` full-page cards are tied to the
  active session anyway.
- Install at app start (next to `installCardBridge`), guarded by `typeof window !== 'undefined'`.
- Note the synergy: a full-page card also wants `fill` sizing + `--TH-viewport-height`; §4.4 + §4.5 together
  make 命定之诗's home / char-viewer viable **inline**, not just isolated.

## 5. Files

**New**
- `src/shared/cardEnv.ts` — pure: `buildEnvHead(opts)`, `replaceVhInContent(html)`, the assumed-libs/avatar/
  base-reset/`--TH-viewport-height` head fragments, lib-URL constants.
- `src/renderer/src/cardBridge/topSurface.ts` — `installCardTopSurface()` + active-session rebind (§4.5).
- `test/cardEnv.test.ts` — pure tests (§8).

**Changed**
- `src/renderer/src/components/cardDoc.ts` — unchanged API; callers compose `buildEnvHead` into `headInject`.
- `src/renderer/src/components/InlineCardFrame.tsx` — base reset moves to `cardEnv`; compose `buildEnvHead`;
  apply `replaceVhInContent` in `fill`; set/refresh `--TH-viewport-height`; route sizing mode.
- `src/renderer/src/cardBridge/cardLibs.ts` — extend `CARD_LIB_URLS` (jQuery-UI/touch-punch/Tailwind/CSS links).
- `src/renderer/src/cardBridge/index.ts` — also `installCardTopSurface()`.
- `src/preload/wcvPreload.ts` / `src/renderer/src/components/WcvMessageFrame.tsx` — document libs move into the
  shared head (drop the preload `require` for document libs); compose `buildEnvHead`; sizing + `vh`.
- `src/shared/cardRenderMode.ts` — add `CardSizing` + `resolveCardSizing`.
- `src/shared/regexTypes.ts`, `src/main/services/scopeMeta.ts`, `regexService.ts`, `regexIpc.ts`,
  `src/preload/index.ts`, `src/renderer/src/stores/regexStore.ts` — carry `sizing` like `renderMode`.
- `src/shared/regexTransform.ts` + `MessageContent.tsx` (`splitHtml`) — emit/parse the `sizing` marker.
- `settings.cards` (`settingsStore.ts`, `settingsService.ts`, `main/types/models.ts`) — add `sizing`.
- `RegexPanel.tsx` (per-card Fit/Fill), `SettingsPanel.tsx` (global default).
- `src/shared/thRuntime/types.ts` (+ both adapters) — add `Host.userAvatarPath()` if used (§4.3).
- `package.json` — `jquery-ui` (+ touch-punch / Tailwind per §7).

**Reused / unchanged**
- `cardFrameHeight.ts` (`fit` keeps `fitInlineCardHeight`; `fill` uses `capCardHeight`), the SP1 `thRuntime`
  + adapters, the `rpt-card://` scheme, `installCardBridge`, the regex marker pipeline.

## 6. Decisions / open questions

1. **Tailwind build (the one hard call).** Options: (a) vendor a **runtime JIT** build
   (`@tailwindcss/browser` v4 or a v3 Play-CDN standalone) — faithful (cards using arbitrary utility classes
   "just work") but heavy (~100KB+) and it observes the DOM **in the renderer process** for every inline card;
   (b) ship a **prebuilt utility CSS** — lighter, no JIT, but misses classes not in the prebuilt set / no
   arbitrary values. **Lean (a) vendored runtime for parity**, injected like the other libs, but flag the
   inline perf cost and consider gating it (see #3). Decide before building §4.2.
2. **WCV lib source — CDN vs `rpt-card://`.** Inline uses same-origin `?url`. For WCV, simplest parity is the
   same jsDelivr URLs (CSP allows `https:`); vendoring + serving from `rpt-card://` is more offline-robust but
   more plumbing. **Lean CDN now**, vendor later (it's also the eventual security/offline story).
3. **Inject-always vs lazy.** JSR injects all libs unconditionally. Faithful = always. But Tailwind-JIT +
   jQuery-UI + FontAwesome on every lightweight inline beautification is real weight in the renderer.
   **Lean inject-always for parity**; optional follow-up: skip a lib when the card references none of its
   markers (cheap heuristic), or only inject the heavy set in `fill`/full-page cards. Surface, don't decide
   speculatively.
4. **`window.top` surface scope & ctx.** Expose API surface only (no libs, no `window.api`), bound to the
   **active** session, rebuilt on session change (§4.5). Confirm no global-name collision with the RPT app
   (the app imports Vue/lodash as modules, not window globals; `SillyTavern`/`TavernHelper`/`Mvu`/`EjsTemplate`
   are card-only names — safe).
5. **User avatar path.** Add `Host.userAvatarPath()` or no-op the user-avatar rule if RPT has no persona
   avatar. Confirm what RPT stores for persona avatars before adding the getter.

## 7. Tests

- `test/cardEnv.test.ts` (pure): `replaceVhInContent` — `100vh→var(--TH-viewport-height)`,
  `50vh→calc(... * 0.5)`, CSS-block / inline-`style=` / JS-`.style.minHeight` / `setProperty` sites,
  **only `min-height`** (a bare `height:100vh` is untouched), no-op when no `vh`; `buildEnvHead` — lib order
  (Tailwind/FA before jQuery before jQuery-UI before Vue), avatar URLs substituted (and `none` when empty),
  base reset present, `--TH-viewport-height` bootstrap present, `fit` vs `fill` head differences.
- `resolveCardSizing` (override ?? default) + the `sizing` marker round-trip in `splitHtml` (mirror the
  existing `renderMode` marker tests).
- Manual (Electron, both transports): a Tailwind-class card styles correctly; a FontAwesome-icon card shows
  glyphs; a jQuery-UI card (`$.ui`/touch-punch) works; a `min-height:100vh` card content-fits in `fit` and
  fills in `fill`; 命定之诗 **home / 角色查看器 render INLINE** (the `window.top` fix) — then toggle one to
  Isolated and confirm identical.

## 8. Acceptance criteria

- The §3 assumed-libs set + avatar CSS + base reset + `--TH-viewport-height` are injected by **one** shared
  builder (`cardEnv`) into **both** transports; WCV no longer `require()`s the document libs.
- A Fit/Fill sizing mode exists (global default + per-card override), `fit` is the default and preserves
  today's content-fit behavior; `fill` applies the `vh` rewrite and the viewport variable.
- An inline full-page card reading `window.top.SillyTavern`/`TavernHelper`/`Mvu`/`EjsTemplate` resolves the
  surface (bound to the active session, rebuilt on session change, no subscription leak).
- New pure tests pass; full `npm test`, `npm run typecheck`, `npm run build` green; no new lint errors.
- Manual parity (§7) confirmed in both transports; clean-room preserved (no JSR source vendored).
