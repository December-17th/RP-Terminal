# Dual-mode inline card rendering (Inline iframe + WCV)

- **Date:** 2026-06-23
- **Status:** Design — pending user review
- **Area:** Renderer message rendering + card-script compat layer

## Problem

SillyTavern "beautification" cards (HTML+CSS+`<script>`, frequently Vue apps that import ESM
from jsDelivr and call TavernHelper/Mvu/EJS APIs) are emitted inline in AI messages. They currently
render in a native `WebContentsView` overlay (`WcvMessageFrame` + `wcvManager`, served from the
`rpt-card://` scheme). A `WebContentsView` is a separate page composited *over* the message, so it:

- has its own scroll context (a scrollbar beside the card),
- cannot grow into the message column or be sized to content reliably,
- only ever shows part of a tall card (the overlay is clamped to the viewport),

i.e. it always looks like an inserted "window," never natively inline.

## Goals

1. Cards that feel **natively inline**: embedded in the message DOM, scroll with the chat, grow to
   content height, no separate scrollbar.
2. Keep a **crash-isolated** rendering option (the existing WCV path) — do **not** remove it.
3. **Full API parity in both modes.** Any card must work identically in either mode: the complete
   TavernHelper / Mvu / SillyTavern surface, the EJS (ST-Prompt-Template) engine, and library globals
   (Vue, jQuery, lodash, zod, toastr) — including the **synchronous** APIs (`EjsTemplate.evalTemplate`,
   the sync getters like `getVariables`, `getWorldbookNames`, `getPreset`).

## Non-goals

- Static (non-scripted) HTML cards keep rendering via `HtmlFrame` — unchanged.
- Workspace panels (`WcvPanel`, the full 命定之诗 app) stay on WCV — out of scope.
- Sandboxing/securing trusted cards (owner has deferred security hardening). Cards are trusted.

## Architecture overview

Scripted inline message cards (the `isInteractiveHtml` branch in `MessageContent`) route to one of two
renderers, chosen by **resolved mode = per-card override ?? global default**:

- **Inline mode (default)** — a **same-origin `srcdoc` iframe** embedded in the message DOM.
- **Isolated mode (opt-in)** — the existing `WcvMessageFrame` (`WebContentsView`), unchanged.

Both modes render the *same* card document (built by the existing `buildCardDoc`).

### Why same-origin for inline mode

Full parity requires satisfying **synchronous** card APIs (`EjsTemplate.evalTemplate`, sync getters).
A cross-origin iframe can only reach the host via async `postMessage`, which cannot satisfy a sync call
without embedding the whole quickjs-WASM engine + a replicated data snapshot in every card frame
(heavy, duplicative). A **same-origin** iframe can call the renderer's **one shared bridge + EJS
engine synchronously** (same thread, same origin). The cost is that a same-origin `srcdoc` iframe
inherits the app CSP, so the renderer CSP must be loosened (scoped to trusted CDNs) to let cards load
their jsDelivr ESM + fonts. This is consistent with the app's current stance: the untrusted-HTML path
stays script-disabled regardless, and cards are trusted.

## Inline mode design

### Component: `InlineCardFrame`

- Renders `<iframe sandbox="allow-scripts allow-same-origin" srcdoc={doc}>` inline inside `.floor-block`.
- `doc` = a **bootstrap `<script>`** (first child of `<head>`) + the card document from `buildCardDoc(html)`.
- Auto-height: a same-origin `ResizeObserver` on the iframe's `documentElement`/`body` sets the iframe
  element height to content height (reuse the `HtmlFrame` pattern). Because the iframe is a normal DOM
  element sized to content, **page scroll works natively** — no internal scrollbar, no wheel-forwarding.
- Right-click forwarding to the host context menu (reuse `HtmlFrame`'s coordinate translation).

### Bootstrap → shared bridge

The bootstrap is a classic `<script>` (runs synchronously during parse, before the card's deferred
`type="module"` scripts). It calls `window.parent.__rptCardBridge(ctx)` (same-origin access) and assigns
the returned globals onto the iframe `window`:

`TavernHelper`, the bare TavernHelper globals, `Mvu`, `SillyTavern`, `tavern_events`, `EjsTemplate`,
`errorCatched`, `toastr`, `Vue`, `$`/`jQuery`, `_`, `z`.

`ctx = { profileId, chatId, characterId, messageId }` is serialized into the bootstrap.

### The renderer bridge: `cardBridge.ts`

`createCardBridge(ctx)` returns the globals object. Because it runs in the renderer:

- **Synchronous reads** come from the renderer's existing zustand stores (which already hold the live
  data the UI renders): `chatStore` (latest floor `variables` → `stat_data`, chat messages),
  `characterStore` (card data), `lorebookStore` (worldbook), `presetStore`, `regexStore`. This is what
  makes sync getters work without IPC.
- **Writes / async ops** (variable writes, `generate`, worldbook save, chat edits) go through
  `window.api.*` (async), with optimistic store updates so the card sees its own change immediately
  (mirrors the WCV write-through behavior).
- **Events** (`eventOn`/`eventEmit`/...): a per-frame bus; the bridge emits MVU/lifecycle events on
  variable/store changes (subscribe to `chatStore`).
- **EJS engine**: the renderer initializes the shared `templateEngine.ts` (quickjs-WASM) **once**
  (renderer CSP already allows `'wasm-unsafe-eval'`); `EjsTemplate.*` calls it synchronously.
- **Library globals**: `Vue`, `$`, `_`, `z` come from the app's bundled npm deps (already dependencies),
  exposed via the bridge. Cards' own CDN imports (gsap, pinia, js-yaml, …) load directly (CSP permits).

`window.__rptCardBridge` is installed when the `InlineCardFrame` module loads, so it exists before any
frame mounts.

### CSP change

Loosen the renderer CSP (`src/renderer/index.html` meta), **scoped to trusted CDNs** rather than blanket
`https:`:

- `script-src`: add the card CDN hosts (jsDelivr family, unpkg, esm.sh, cdnjs) + `blob:`.
- `style-src`: add Google Fonts (`fonts.googleapis.com`) + the CDNs.
- `font-src`: add `fonts.gstatic.com` (+ `data:`).
- `img-src`: add `https:` (cards load images from anywhere).
- `connect-src`: add the CDN hosts (+ `blob:`/`data:`) for card fetches.

The host allowlist is centralized so it's easy to extend when a card uses another CDN.

## Isolated mode design

`WcvMessageFrame` + `wcvManager` unchanged. Already provides full parity (the `wcvPreload` shim + EJS).
Selected when a card's resolved mode is `isolated`.

## Full API parity

The card-facing API surface is conceptually defined once. Two transport implementations realize it:

- **WCV (`wcvPreload`)**: sync via `ipcRenderer.sendSync` + a pushed `stat_data` mirror; async via
  `ipcRenderer.invoke`; EJS via an in-preload quickjs instance.
- **Inline (`cardBridge`)**: sync via direct renderer **store reads** + a renderer **quickjs** instance;
  async via `window.api`.

Both reuse the shared `src/shared/templateEngine.ts`. Where practical, shared helpers (event bus shape,
the API method list) are factored to keep the two from diverging; the two transports stay thin.

## Mode selection & per-card override

- **Global default**: a setting (`settingsStore`, e.g. `cardRenderMode: 'inline' | 'isolated'`, default
  `'inline'`), editable in Settings.
- **Per-card override**: stored in the regex `_meta` sidecar next to `scope`/`disabled`
  (`renderMode?: 'inline' | 'isolated'`), set via a new IPC (mirroring `setScriptScope`) and surfaced as
  an **Inline / Isolated / Default** selector per script in the regex manager.

### Routing the override to render time (block tagging)

At render time `MessageContent` only sees the final HTML, not which regex produced it. So the regex
engine **tags** each card's block:

- `RenderRegexRule` carries `renderMode` (from `getRenderRegex`).
- When `applyRegexRules` applies a rule with a `renderMode`, it prepends a marker to that rule's output:
  `<!--rpt:mode=isolated-->` (or `inline`) immediately before the emitted block.
- `splitHtml` recognizes a marker adjacent to an HTML segment and attaches `mode` to that segment.
- `MessageContent` routing: `segment.mode ?? globalDefault` → `InlineCardFrame` or `WcvMessageFrame`.

A card with no override produces no marker → falls back to the global default.

## Files

**New**
- `src/renderer/src/components/InlineCardFrame.tsx` — the same-origin inline iframe + auto-height + bootstrap.
- `src/renderer/src/cardBridge/*` — `createCardBridge(ctx)` + the renderer EJS engine init + the globals.
- Regex `renderMode` IPC handler + `setScriptRenderMode` in `regexService` (`_meta` sidecar) + preload `window.api` method.
- Settings field `cardRenderMode` + Settings UI control.
- Regex-manager per-script mode selector.

**Changed**
- `src/renderer/index.html` — scoped CSP loosening.
- `src/renderer/src/components/MessageContent.tsx` — route interactive cards by resolved mode; `splitHtml` parses the mode marker.
- `src/shared/regexTransform.ts` + `regexStore` — carry `renderMode` on rules; emit the block marker.

**Reused / unchanged**
- `rpt-card://` scheme + `wcvManager` (isolated mode only; inline mode serves `buildCardDoc` output via `srcdoc`).
- `buildCardDoc`, `HtmlFrame` (static cards), `src/shared/templateEngine.ts`.

## Alternatives considered

### Shadow DOM for the inline path (rejected)

Considered hosting scripted inline cards in a **shadow root** instead of a same-origin iframe, for
free content-height growth and native page scroll. Rejected: a shadow root is not a document or a
realm — it shares the page's `document`, `window`, global scope, and `customElements` registry. For
the full-document Vue/ESM cards this is fatal:

- `<script>` in injected markup doesn't execute; `type="module"` scripts can only run at document
  level, not "inside" a shadow root.
- Card code (`createApp(App).mount('#app')`, `document.querySelector('#app')`) misses, because the
  card markup lives in the shadow tree, not `document` — and the shared realm means the card's
  `document` global can't be swapped.
- Cross-card collisions: shared global scope + one `customElements` registry → second `const app` /
  `customElements.define(...)` throws.
- Full-document CSS misbehaves: `html,body` selectors match nothing, `100vh` resolves to the viewport
  (the oversize bug returns), `position:fixed` escapes, `@font-face` is ignored, the `<head>`/CSP
  `<meta>` are meaningless.
- It's also a robustness regression vs. the iframe: no realm isolation, so a card's globals/listeners/
  prototype tweaks mutate the actual app. And it still requires the same CSP loosening (shadow DOM is
  governed by the page CSP).

The two real benefits (auto-height, native scroll) are already delivered by the auto-height iframe.
Shadow DOM remains defensible only for the *static* `HtmlFrame` path (no scripts, no realm to protect)
— an unrelated, out-of-scope optimization.

## Risks & mitigations

- **No process isolation in inline mode** — a runaway card can block the renderer. Mitigation: that's
  exactly what Isolated (WCV) mode is for; flip a misbehaving card to it.
- **CSP loosening** — scoped to trusted CDN hosts (not blanket `https:`), centralized for easy review.
- **localStorage origin differs by mode** (app origin vs `rpt-card`) — a card's *incidental* localStorage
  doesn't carry across a mode switch. Canonical RP data lives in SQLite via the bridge, so state is safe;
  document the limitation.
- **Two bridge implementations** — maintenance cost; mitigated by sharing `templateEngine.ts` and the
  API method list, keeping each transport thin.
- **Runtime-only behaviors** (CDN imports, Vue mount) need per-card manual testing.

## Testing

- **Unit (pure):** mode resolution (`override ?? default`); `splitHtml` marker parsing; `cardBridge`
  sync read/write mapping against a mock store; the block-tagging in `applyRegexRules`.
- **Manual:** the three reported cards (红花戏票, 对话美化fix, 角色查看器) in **inline** mode —
  render, scroll-with-page, content-height, variable read+write, EJS-using card; then toggle one card to
  **isolated** and confirm identical behavior.

## Rollout

1. Inline frame + renderer bridge (core: render + sync reads + libs + EJS) → manual-test the 3 cards inline.
2. Writes/events parity pass.
3. Mode selection: global default + per-card override + block tagging + manager UI.
4. CSP scoping finalized against the cards in use.
