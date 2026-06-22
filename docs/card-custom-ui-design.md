# Card Custom UI in the Panel Workspace — Investigation & Design

Status: investigation + proposal. Builds on `docs/mvu-panel-workspace-design.md` (the two
MVU-rendering layers) now that Phase 1 gives us movable left/right panels.

## Goal

Let a card supply its OWN status/menu UI that renders in the left or right panel, runs scripts,
and — new — **WRITES message variables** (not just displays them). Two author-facing import modes:

1. **Native** — the card imports a config/settings for RP Terminal's native UI.
2. **Script** — the card imports scripts that render UI onto a panel.

Reference target: [KritBlade/MVU_Zod_StatusMenuBuilder](https://github.com/KritBlade/MVU_Zod_StatusMenuBuilder),
a drag-and-drop builder that generates these status menus for ST/MVU cards.

## Decisions (2026-06-21)

- **Frame model = `WebContentsView`, static card-determined layout** (not webview-in-a-resizable-panel).
- **Manual/panel edits are transient** — the write-back bridge mutates `stat_data` directly and does
  NOT record replayable ops, so `reevaluateVariables` (rebuild from the model's stored
  `<UpdateVariable>`) resets to model-only state. The Status panel's Re-evaluate button is, by design,
  "discard my edits and rebuild from the model."
- **Inline beautification frames are read-only in history** — a non-latest floor's frame runs for
  display but its writes are denied and reads bind to that floor's snapshot; only the current floor's
  frame is live/writable. (Read-only = no writes, not no scripts.)
- **Any web app (incl. a Vue SPA) runs in a `WebContentsView`** — it's a full Chromium page, so a
  card's Vue frontend (e.g. 命定之诗) WILL run, and the separate process solves the freeze. The gating
  work is the clean-room ST/TavernHelper/Mvu **runtime shim** the card's code calls (task #2), which is
  **identical regardless of frame** (WCV / webview / iframe) — the frame buys isolation + integration,
  not API compatibility. Bundle loading (the card's built assets, possibly fetched from a CDN) + CSP
  must also be handled.

## Inline-in-message UI (clarification, 2026-06-21)

Beautification regex can replace message text with **inline UI** (HTML/Vue) that has its own settings
and can write message variables. This is distinct from a panel and changes the frame choice:

- **Inline UI → iframe, NOT WebContentsView.** Inline widgets live in the message, scroll with it, can
  be many, and reflow as the response streams — the worst case for WCV's absolute-bounds overlay. The
  in-flow iframe is the right (only practical) tool. So the **center stays native `ChatView`**
  (rendering inline iframes per message); **WCV is reserved for stable side/static panels.** The earlier
  "center = WCV" idea applies only to a card that ships ONE monolithic full-screen UI — the opposite of
  inline-per-message.
- **Already built:** `MessageContent` renders regex→HTML inline — lightweight styled HTML inline in the
  message DOM (react-markdown + rehype-raw + DOMPurify, no scripts), and full HTML/Vue blocks in a frame
  (passive → `card-frame` `allow-same-origin`; interactive → `MessageScriptFrame` `allow-scripts` + the
  `rpt` API).
- **Vars-write already works + persists:** an interactive frame calls `rpt.vars` / TavernHelper
  `insertOrAssignVariables`/`replaceVariables` → `pluginService.pluginVars` (permission-gated,
  scope-aware) → the floor's variables + `saveFloor`, and syncs the live status widgets. This **overlaps
  the new `apply-variable-ops` bridge** — consolidate, or keep the bridge for the native Option-1 UI and
  let frames keep using `pluginVars`.
- **New work:** a per-inline-UI **settings** model (configurable styles per widget/instance), injected
  into the frame as CSS vars / a config object the frame reads via `rpt`.
- **Freeze trade-off is inherent** to inline interactive frames (same-process) and WCV can't fix it.
  Prefer native rendering for *declarative* beautifications (safe/fast); gate/limit heavy (Vue)
  interactive frames; run only the visible/latest message's frame; keep the watchdog.
- **History rendering (single-floor pager):** only the current page's frames are mounted, so the freeze
  risk is bounded to one floor — not the whole history. Static/regex beautifications already render
  per-floor-correctly (`ChatView`'s macro+regex pass uses each floor's `f.variables`). The gap: live
  script/Vue frames receive only `html` (no floor id), so they'd read/write the LATEST floor's vars
  regardless of which page is shown. To render history correctly:
  (1) thread the floor id down (`ChatView → MessageContent → MessageScriptFrame`) so a frame binds to
  THAT floor's variables (messageId) for reads/writes;
  (2) key frames by floor so flipping a page cleanly remounts with the new floor's content + vars;
  (3) **Decided: history frames are read-only.** A non-latest frame still RUNS (so a script/Vue UI
  mounts and displays) but its write capabilities are denied and its `vars:read` is bound to that
  floor's snapshot — read-only means *no writes*, NOT *no scripts* (stripping scripts would leave a
  script-driven UI an empty shell). The live, writable frame runs only on the current/latest floor —
  at most one live writable frame, no mutating past state.

## What the StatusMenuBuilder actually produces (from `dist/layout-rpg.json`)

Its output is a **declarative JSON config (~72 KB), not runnable code**:

- Top level: `layout` (tabs → cards), `mvuData` (the variable values), `globalCss`,
  `globalLogic` (a JS recompute function), `customTemplates`, `selectedPaths`/`lockedPaths`,
  `staticLocale` (i18n).
- `mvuData` stats are `[value, label]` tuples — the MVU `stat_data` convention (value +
  description) that `StatView`/`statViewHelpers.asValueDesc` already understands.
- Each card: `{ id, type, title, mappedKey, maxMappedKey, barColor, sourceType, customLogic }`.
  `type` ∈ a **finite set**: `StatBar, StatRow, Image, Checkbox, RichText, QuestList`. `mappedKey`
  is a variable path; `customLogic` is a field-level JS string using `getV(root, path, default)`.
- Interactivity = checkbox toggle, `QuestList` delete, equipment equip/unequip → mutate `mvuData`
  and run `globalLogic` (`setVal(obj, key, value)`) to recompute derived stats.
- Target runtime: SillyTavern + TavernHelper (JS-Slash-Runner) + ST-Prompt-Template. **License:
  AGPL-3.0.**

**Implication:** this is a declarative UI tree with a finite widget vocabulary + small sandboxed
JS — almost perfectly suited to a NATIVE renderer. We'd consume the author's CONFIG (data), i.e.
format-compatibility (like reading ST cards), so its AGPL-3.0 doesn't bind us; and being AGPL
(OSI/free, compatible with our AGPL-3.0 lean) we *could* adapt its logic if ever needed — unlike
the AFPL JS-Slash-Runner (do-not-vendor).

## Shared prerequisite — a variable WRITE-BACK bridge

Today `stat_data` is written only by the model's `<UpdateVariable>`. Both options need panel UI to
MODIFY message variables. New capability (the heart of this feature):

- IPC `apply-variable-ops(profileId, chatId, floorId, ops)` → main applies ops to the floor's
  `stat_data` (reuse `mvuParser.applyJsonPatch` / `applyMvuCommands`), persists with
  `floorService.saveFloor`, returns the updated floor → `chatStore` swaps it in → every panel
  re-renders. (Mirrors the existing `setLatestFloorVariables` store path, but persisted + main-side.)
- "Message variables" (TavernHelper message scope) == our `floor.variables`. Default target = the
  latest floor (the current message).
- Optionally re-run the card's `globalLogic` / MVU recompute after a write so derived stats update.
- Guardrails: validate ops against `data_schema`/`state_schema` where present.
- **Re-evaluate interaction (decided):** bridge writes mutate `stat_data` directly and are NOT recorded
  as replayable ops, so `reevaluateVariables` (rebuild from the model's stored `<UpdateVariable>`)
  resets to model-only state — manual/panel edits are **transient by design**. (Also: `applyVariableOps`
  currently overwrites the floor's `delta_data` with the user-op deltas; cosmetic, fix when convenient.)

## Option 1 — Native UI from a card-imported config (recommended first)

The card ships a declarative status-menu config (the StatusMenuBuilder JSON and/or our own
`ui_layout`); RP Terminal renders it natively in a panel.

- **Storage:** under `data.extensions.rp_terminal` — e.g. `status_menu` = the builder JSON, or
  extend `ui_layout`. On import, optionally seed `state_schema.defaults` from `mvuData`.
- **Renderer:** the Phase-2 native view kit, extended to the builder's widget vocabulary
  (`StatBar/StatRow/Image/Checkbox/RichText/QuestList`) + tabs + scoped/sanitized `globalCss`.
  Bind `mappedKey` → `stat_data`. Registered as a `status-menu` view, mountable in any panel.
- **Field logic** (`customLogic`, `globalLogic`) runs in our quickjs sandbox
  (`templateService`/`sandboxRunner`) with a bound `getV(root,path,def)` / `setVal(obj,key,val)`
  API over a COPY of `stat_data`; results drive display, and `setVal`/interactions route through
  the write-back bridge.
- **Interactivity:** Checkbox / Delete / Equip emit variable ops → bridge → re-render.
- Pros: safe (only sandboxed expressions, no arbitrary DOM/JS), themeable, fast, no webview, works
  in any panel, and directly consumes the most popular builder's output. Cons: we implement each
  widget `type` + a faithful `getV/setVal` surface; exotic author HTML isn't pixel-identical.

This is the design doc's "native MVU views (A)" made concrete + interactive.

## Option 2 — Script-embedded UI in a panel (needs isolation)

The card ships JS/HTML (a frontend card / TavernHelper script) that renders its OWN UI into a panel
and uses the TavernHelper/Mvu shim to read/write message variables.

- A new `panel-ui` view type hosts a card-provided bundle in a process-isolated `<webview>`
  (**task #1**) with the clean-room ST/MVU runtime shim (**task #2**): `getVariables` /
  `replaceVariables` / `insertOrAssignVariables` (message scope), `Mvu.setMvuVariable`, events,
  `getV`. Writes route through the same bridge.
- The card declares `panel_ui` + a target slot under `rp_terminal`; different panels can host
  different bundles.
- Pros: pixel-exact author UI, arbitrary interactivity, runs the real ecosystem code. Cons: needs
  the webview isolation + the deep shim (both deferred); larger trust/security surface; per-card
  opt-in (matches today's click-to-run gate).

This is the design doc's "webview card-UI (B)", generalized to any panel + write-back.

### Embedding mechanisms: iframe vs webview vs WebContentsView

In Chrome, sandboxed/cross-origin iframes are out-of-process (OOPIF). **In Electron they are not**
(electron#17868) — a same-process iframe shares the host renderer's thread, so a card's synchronous
infinite loop freezes the whole app (the bug that shelved frontend cards; `IsolateSandboxedIframes`
had no effect from the non-sandboxed renderer). An iframe gives security but not compute isolation:
- **Security / containment ✅** — `sandbox="allow-scripts"` (no `allow-same-origin`) + CSP + DOMPurify.
- **Compute isolation ❌** — a runaway script blocks the shared thread; the watchdog can't even fire.

The three in-window options trade efficiency against isolation and integration:

| | iframe | `<webview>` | `WebContentsView` |
|---|---|---|---|
| Process isolation (hang/crash-safe) | ❌ same-process | ✅ separate | ✅ separate |
| Memory / perf | lightest | heavy (embedder + guest plumbing) | lighter than webview |
| Electron support | ✅ | discouraged | ✅ recommended |
| DOM integration (resize/scroll/clip) | ✅ in-flow | ✅ in-flow | ❌ overlay (pixel bounds) |

- **iframe** — same-process, so a bad card freezes the app; fine for TRUSTED cards or behind the
  click-to-run "close & reopen to recover" gate. Simplest to embed/postMessage/theme.
- **`<webview>`** — an in-flow DOM element that's process-isolated (hang-safe); heavier and
  architecturally discouraged by Electron, but it sizes/scrolls/clips like an element.
- **`WebContentsView`** — the modern `BrowserView` replacement: same isolation as webview but lighter
  and Electron-recommended. The catch — it's a MAIN-PROCESS native view positioned by absolute pixel
  bounds OVER the window, not in the DOM. For a *resizable, scrollable, chrome-wrapped* panel that
  means continuous bounds-sync over IPC (the view trails the edge during a live drag), z-order
  occlusion (it paints on top of the panel header, dropdowns, toasts, modals), no DOM clipping/rounded
  corners, and a main-process view registry. Great for a large STABLE rectangle; painful for a small
  dynamic dockable panel.
  - **Key mitigation:** if panels are STATIC and **card-determined** (fixed positions/sizes, not
    user-resizable/movable) most of that pain disappears — stable rects, no live-drag trailing,
    predictable z-order (carve the header out as a separate strip). That flips `WebContentsView` to the
    most attractive isolated option for a card-authored fixed layout. See the WebContentsView plan below.
- **`utilityProcess`/Workers** isolate compute but have no DOM, so they can't render UI.

**Optimization ordering (in-panel card UI):** native / no frame (Option 1) > iframe (trusted) >
`<webview>` (untrusted, easy DOM integration) > `WebContentsView` (untrusted, best perf but
overlay-integration tax — unless the layout is static/card-determined, which flips it to first among
the isolated options).

**Option 1 sidesteps the whole question**: native render + field-logic in quickjs (interruptible via a
deadline/interrupt handler) is secure AND hang-proof with no frame. Since the StatusMenuBuilder output
is declarative, Option 1 covers that ecosystem without running arbitrary author DOM/JS.

## How a card picks an option

Under `data.extensions.rp_terminal`:

- Option 1: `status_menu` (builder JSON) and/or `ui_layout` (our spec) + `data_schema`/`state_schema`.
- Option 2: `panel_ui: [{ slot: 'left' | 'right', name, code | html, enabled }]` (+ existing `scripts`).
- A card may ship both (native by default, webview as an opt-in fidelity view). A panel's
  view-picker lists whichever the card provides.

## Security

- Option 1 field logic: quickjs only (no DOM, no network); `globalCss` sanitized + scoped to the
  panel; ops validated against the schema.
- Option 2: webview with no node / no `allow-same-origin`; all host access via the shim's narrow
  IPC; writes validated; per-card consent.
- Never node `vm`; never run untrusted author JS on the main thread.

## Recommendation / sequence

1. **Variable write-back bridge** — small, unlocks interactivity for everything (and useful on its
   own, e.g. manual stat edits).
2. **Option 1** on the Phase-2 native view kit — implement the builder's widget vocabulary +
   sandboxed `getV/setVal` + config import. Highest value, safe, no new infrastructure.
3. **Option 2** after task #1 (webview) + task #2 (shim) — the `panel-ui` webview view for
   pixel-exact author UIs.

---

# WebContentsView plan (Option 2, static card-determined layout)

A concrete plan for embedding a card's own UI via `WebContentsView` instead of `<webview>`. The
pivot that makes it clean: **the card determines a STATIC layout** (fixed panel positions/sizes,
not user-resizable/movable), which removes the live-resize bounds-sync and most z-order occlusion —
the only real downsides of the overlay model. This becomes its own opt-in workspace mode, coexisting
with the resizable workspace (which stays the default for native / Option-1 cards).

## Why static + card-determined fixes the overlay tax
`WebContentsView` is a main-process native view positioned over the window by pixel bounds. The pain
is *dynamic* layouts: live-drag trailing, occluding floating UI, reflow on every resize. If the card
fixes the regions, the rects are computed once per window size (not per drag), there are no movable
splitters over the views, and panel chrome can be carved into fixed strips the views never cover.

## Card-declared layout (under `data.extensions.rp_terminal`)
```jsonc
"panel_ui": {
  "mode": "static",                 // opt into the fixed, card-determined workspace
  "grid": { "cols": 12, "rows": 12 },
  "slots": [
    { "id": "chat",   "view": "chat",   "rect": [0, 0, 8, 12] },   // native React region
    { "id": "status", "view": "wcv",    "rect": [8, 0, 4, 12],     // a WebContentsView region
      "entry": "status.html", "title": "Status" }
  ]
}
```
- `rect` = `[col, row, colSpan, rowSpan]` in the grid → pixel bounds at render time.
- `view: 'chat'|'status'|…` reuses the existing `ViewRegistry` for native regions; `view: 'wcv'`
  marks a region hosting the card's bundle. Bundle files (`entry` HTML/JS/CSS) ship in the card
  (alongside `scripts`).

## Architecture
- **Renderer (`StaticWorkspace`)**: when the active card has `panel_ui.mode === 'static'`, render this
  instead of the resizable `Workspace`. It lays out the grid, renders native slots as React panels,
  and for each `wcv` slot renders a placeholder `<div>` with a fixed header strip + an empty body;
  a `ResizeObserver` on the body reports its rect (relative to the window) to main. No splitters.
- **Main (`wcvManager`)**: a registry of `WebContentsView`s keyed by `chatId:slotId`. IPC:
  `wcv-ensure(slot, bounds, entry)` (create + attach + `setBounds`), `wcv-set-bounds(slot, bounds)`
  (on window-resize / tab-change, throttled), `wcv-destroy(slot)` (on unmount / session switch),
  `wcv-set-visible(slot, bool)` (hide when a modal opens over it or the tab is hidden). Each view
  loads `entry` from the card's extracted bundle dir with a locked-down `webPreferences`
  (no node integration, `contextIsolation: true`, a narrow preload).
- **The bridge both ways**:
  - *read* — on floor change, main pushes `stat_data` to each view (`webContents.send('mvu:vars', …)`);
    the shim resolves `getVariables`/`getV` from it.
  - *write* — the view's shim calls `replaceVariables`/`insertOrAssignVariables`/`Mvu.setMvuVariable`
    → preload → `apply-variable-ops` (the bridge built in step 1) → floor persisted → re-render +
    re-push to all views. One write path for native and script UI alike.

## Runtime shim (clean-room; = task #2)
The view's preload exposes only the narrow TavernHelper/MVU surface the card UI needs:
`getVariables({type:'message'})`, `replaceVariables`, `insertOrAssignVariables`, `Mvu.getMvuData`/
`setMvuVariable`, `getV`, the event subset, `getCurrentMessageId`. All reads come from the pushed
`stat_data`; all writes go through `apply-variable-ops`. No `window.top/parent`, no host DOM.

## Lifecycle, perf, security
- One OS/renderer process per live `WebContentsView` → create lazily, destroy on session switch,
  cap/reuse where possible. `setVisible(false)` when its tab/panel is hidden.
- Window-resize → recompute grid rects → `wcv-set-bounds` (throttled ~60ms). No per-frame sync.
- Sandbox: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, CSP on the loaded page,
  bundle served from a card-scoped dir, writes validated against `data_schema`; per-card consent
  (same posture as the click-to-run gate). Never expose `window.api`.

## Build steps
1. `wcvManager` (main) + the `wcv-*` IPC + a card-scoped bundle extraction dir.
2. `panel_ui` static-layout schema in `RPTerminalExtSchema` (Zod) + import handling.
3. `StaticWorkspace` (renderer): grid layout, native slots via `ViewRegistry`, `wcv` slot
   placeholders + `ResizeObserver` → `wcv-set-bounds`; switch to it when the card is static-mode.
4. The clean-room shim preload + the read-push / write-via-`apply-variable-ops` wiring.
5. Lifecycle (create/destroy/visible), window-resize bounds sync, security hardening.

## When to prefer this vs `<webview>`
- **`WebContentsView` + static layout** → best perf + Electron-supported; the card owns a fixed,
  predictable layout. The plan above.
- **`<webview>`** → if we instead want card UI inside the *resizable/movable* workspace (in-flow DOM
  that scrolls/clips with the panel), accept the heavier, discouraged tag.
- **Either way, Option 1 (native, no frame) remains the default** for declarative StatusMenuBuilder-
  style cards; Option 2 is the fidelity path for cards that ship real UI code.

---

# 命定之诗 boot chain + shim requirements (from the actual bundles, 2026-06-21)

The card ships several frontends, all as scripts that cascade-import more: a **status UI**, a
**start-only character-creation** frontend, and the **MVU variable framework** itself.

## The status UI
Regex emits an inline frame that jQuery-loads the UI:
```html
<body><script>$('body').load('https://.../FrontEnd-for-destined-journey@1.8.2/dist/status/index.html')</script></body>
```
`dist/status/index.html` is **not jQuery/Vue — it's a React ESM app** (`<script type="module">`)
that imports its deps from jsDelivr at runtime: `react`/`react-dom` (`scheduler`), `immer`, `gsap`,
`openseadragon`. (jQuery is only the *outer* `.load()` glue; in a WCV we load the status URL directly.)

## The MVU framework (`MagVarUpdate/artifact/bundle.js`, MIT)
Exposes **`window.Mvu`**: `getMvuData`, `replaceMvuData`, `parseMessage`, `setMvuVariable`,
`getMvuVariable`, `reloadInitVar`, `events` (`VARIABLE_INITIALIZED`, `VARIABLE_UPDATE_STARTED`, …).
Depends on a LARGE host global surface: `SillyTavern`; `getVariables`/`replaceVariables`/
`insertOrAssignVariables`/`updateVariablesWith`; `getChatMessages`/`setChatMessages`; `eventOn`/
`eventEmit`/`eventRemoveListener`; lorebook APIs (`getCurrentCharPrimaryLorebook`, `getCharLorebooks`,
`getLorebookEntries`, `getLorebookSettings`/`setLorebookSettings`); `generate`/`generateRaw`;
`substitudeMacros`. Reads/writes `stat_data` (+ optional `schema`), processes `<initvar>` blocks from
worldbook entries, tracks `initialized_lorebooks`. Plus `dist/data_schema/index.js` = the variable schema.

## Shim requirements (WCV preload)
- **`window.SillyTavern.getContext()` + the bare TavernHelper globals.** Map to what we have: vars →
  the `rptHost`/`apply-variable-ops` bridge; `getChatMessages` → `pluginGetMessages`; `substitudeMacros`
  → `expandMacros`; events → a small bus; lorebook → lorebook services; `generate(Raw)` → `generateRaw`.
  Many can START as stubs/no-ops and be filled as the UI actually calls them.
- **`window.Mvu` — a THIN shim is likely enough for the UI.** The status app only *displays*: it reads
  `Mvu.getMvuData()` (→ `{ stat_data, schema }` from `rptHost`) and maybe `setMvuVariable` (→ the
  bridge). The bundle's heavy deps (lorebook/generate/getChatMessages) drive its *update* pipeline —
  which we already do natively (`mvuParser`). So shim `getMvuData/getMvuVariable/setMvuVariable/events`
  over our state; load the real MIT bundle only if the UI needs its exact behavior.
- **Network/CSP.** The status app imports ESM from jsDelivr at runtime → the WCV must allow jsDelivr
  (load from the jsDelivr origin for the spike; vendor/proxy + tighten CSP for production).
- **Electron security decision.** To give the card's main-world code the bare window globals it
  expects, either `contextBridge` (locked, limited) or `contextIsolation:false` (a main-world shim —
  simpler, acceptable for TRUSTED cards since the WCV is still a separate process with `nodeIntegration:
  false`; production hardens). Loading a remote card page also grants it `rptHost` → trusted-only.
- **Spike tactic — a missing-API logger.** Expose the globals as accessors that log every property
  touched on first load → the exact call checklist, instead of guessing what to shim.

Licensing: MVU/MagVarUpdate is MIT (loadable/vendorable); the React/gsap/openseadragon/immer deps are
permissive; the card's own frontend is user content we run on the user's behalf.

---

# WCV trust model + hardening status

The WCV card UI is a working spike for TRUSTED cards. Hardening status:

- **Implemented:** process isolation (separate renderer, `nodeIntegration:false` → no host/Node reach);
  a **CSP** on the card page — `connect-src` limited to jsDelivr + self, so the card can't fetch/XHR/
  WebSocket to arbitrary origins (the exfiltration vector); scripts/styles limited to jsDelivr + self +
  the eval the React app needs; **per-card click-to-consent** before any remote code runs; the host
  bridge (`rptHost`) is narrow and **session-scoped** (read/write only THIS session's variables,
  resolved in main from the calling `webContents` id).
- **Deferred — full `contextIsolation:true`.** The shim runs in the page's MAIN world
  (`contextIsolation:false`) because the card's libs (lodash/Zod/jQuery) must be REAL main-world objects,
  which `contextBridge` can't pass (it clones and strips prototypes). The production fix is a **host-page
  refactor**: load the libs in-page (vendored / CDN classic scripts), define the ST/Mvu shim in-page, and
  expose only the narrow `rptHost` bridge across the isolation boundary via `contextBridge`. Until then,
  WCV card UI is trusted-card-only.
- **Deferred — vendoring.** The spike loads the card's frontend from jsDelivr at runtime; production
  should cache/vendor a card's assets (offline + integrity) behind the consent gate.
