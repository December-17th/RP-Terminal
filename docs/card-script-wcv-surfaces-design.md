# Card Script Surfaces — running card scripts in a WCV & letting cards register their own UI

Status: **BUILT (Phases 1–4), 2026-06-25** — `创意工坊` works end-to-end (download/sync/uninstall lorebook
entries + regex). **Phase 5 (OAuth cloud login) is DEFERRED** (see §0). Implementation plan:
[docs/superpowers/plans/2026-06-25-card-script-wcv-surfaces.md](superpowers/plans/2026-06-25-card-script-wcv-surfaces.md).
Motivating case: the `【命定之诗】创意工坊` button did nothing in RP Terminal.
Builds on `docs/card-custom-ui-design.md` (the iframe-vs-WCV analysis + the `WebContentsView` plan) and the
WCV spike (`wcvManager`, `wcvPreload`, the `wcvIpc` host bridge).

> **§§4–7 below are the ORIGINAL design (pre-build).** Two things changed during implementation — read §0
> first; where it conflicts with a later section, §0 wins.

## 0. As-built (2026-06-25) — what shipped, and the two design changes

**The card script engine (built).** A single, invisible, process-isolated `WebContentsView`
(`CardScriptWcvHost`) runs the active card's merged scripts. **It is mounted ONCE per session at the app
level (`App.tsx`), parked off-screen** — NOT inside a panel (the original §4a/§4d implied a panel-mounted
host). So scripts run + the workshop button registers in ANY layout. The button-launched workshop modal
slides the engine on-screen (`wcvManager.setModal` off↔on-screen) and back off on close (overlay detected by
a `wcvPreload` MutationObserver). The legacy "Card Scripts" panel view is now just an info note. This is the
owner's **"default invisible script engine for all cards; panels are for game UI"** direction.

**Card UI placement (CHANGED from §4b/§4h).** The original plan auto-LIFTED the `状态栏` status regex into a
`panel_ui` slot on import. **That was reverted.** The locked direction is:

- **ST-compat card UIs that come from regex DEFAULT to inline regex** (rendered in the message, like ST).
- The **user can PROMOTE** a loader-regex UI (the `$('body').load('https://…')` ones: 状态栏 / 首页 /
  自定义开局) **to a docked WCV panel** via a per-regex render-mode `'panel'` in the regex manager, then pick
  which workspace panel shows it. (`renderMode:'panel'` strips the inline marker, `extractCardUiUrl` +
  `listPanelRegexes` expose it, `Panel.tsx` renders a dynamic `regex-panel:<file>` view via `WcvPanel`.)
- `rp_terminal.panel_ui` + `StaticWorkspace` stay for **RPT-native cards that author their own layout** (no
  auto-synthesis for ST cards). The hardcoded `wcv-card/home/start` views were retired.

**Worldbook/regex fidelity (built, beyond the original scope).** Cards exchange entries in the TavernHelper
shape; the shared mappers `thRuntime/worldbookEntry` (strategy/keys/constant/`extra` ↔ native) and
`thRuntime/tavernRegex` keep keys/constant/tags lossless on every read+write. Added
`create/deleteWorldbookEntries` (the workshop's install/uninstall), script-scope vars (so a card's cache
can't pollute `stat_data`), a WCV `YAML` global, and a lorebook-editor live refresh after a WCV write.

**§0 deferred — Phase 5 (OAuth cloud login).** The workshop's public-project path works WITHOUT login
(verified). Its `window.open` OAuth (for private projects / publishing) needs a `setWindowOpenHandler` on the
card WCV + a child-window `postMessage` relay — the highest-risk piece, and not needed for the core flow. See
the plan's Phase 5. **May still need to be done** if private-project sync / publishing becomes a requirement.

## Goal

1. Make `创意工坊` (and any script like it) work: a button in the menu above the input opens a **modal** to
   download/sync lorebook entries + regex from a cloud store.
2. Do it **without hardcoding** the card. A card adds its own WCV surface purely through script API calls
   (`replaceScriptButtons` + `eventOn(getButtonEvent(...))`) and/or a declarative manifest slot — the host
   has zero card-specific knowledge.
3. Fold the existing hardcoded `wcv-card` / `wcv-home` / `wcv-start` spike views into the same mechanism.
   **Locked delivery for 命定之诗 (see §4b):** `状态栏` → a declarative WCV **panel slot** in the card's
   `panel_ui` layout (replaces the old `wcv-card` hardcode + the status regex); `首页` / `自定义开局` → stay
   **inline regex** (drop `wcv-home` / `wcv-start`). Layout is **static-locked** (card owns the rects; §4h).

---

## 1. What `创意工坊` is (verified from the card + bundle)

The card `命定之诗与黄昏之歌v4.2` bundles 6 TavernHelper scripts at `data.extensions.tavern_helper.scripts`.
Script #4 `【命定之诗】创意工坊` is a single remote import with declarative button metadata
`button.buttons = [{ name: "命定创意工坊", visible: true }]`:

```js
import 'https://testingcf.jsdelivr.net/gh/Akabanesaki/myrepo@2.0.3/dist/CreativeWorkshop/index.js'
```

The fetched bundle (23 KB ESM) is a **full-page TavernHelper app**, not an in-panel widget. Verified from
the disassembled source:

- On load: `replaceScriptButtons([{name:'命定创意工坊',visible:true}])` + `eventOn(getButtonEvent('命定创意工坊'), handler)`.
- Handler builds a **full-screen jQuery overlay**:
  `$('<div id="creative-workshop-agreement-overlay">').css({position:'fixed', inset:'0', zIndex:2147483647, background:'rgba(0,0,0,0.75)', backdropFilter:'blur(6px)'}).appendTo('body')` (agreement gate → workshop UI),
  and clones `head > style` into the host so its CSS applies.
- Reads context: `getCharWorldbookNames('current')` → `{primary, additional}` (**sync**), `getCurrentCharacterName()`,
  `isCharacterTavernRegexesEnabled()`, `SillyTavern.getCurrentChatId()`, `getScriptId()`,
  `getVariables({type:'script', script_id})`.
- **Network**: `fetch(...)` to a Cloudflare Worker (`poemofdestinycreativeworkshop.…workers.dev`) for "projects";
  `window.open(...)` + `postMessage`/`addEventListener('message')` for an **OAuth** login; `localStorage`.
- **Writes**: diffs the cloud project against the card's book and applies `updateWorldbookWith(name, updater)`
  (lorebook) and `updateTavernRegexesWith(updater, option)` (regex), caching in script-scope vars via
  `updateVariablesWith(fn, {type:'script', script_id})`. Uses `_` (lodash) throughout.

Net: _a button that opens a modal to download/sync lorebook entries + regex from a cloud store._

---

## 2. The current path in RP Terminal — and why the click does nothing

**Routing (verified):** bundled `tavern_helper.scripts` are imported on card import via
`scriptService.normalizeImportedScripts` (`characterService.ts:272`), which calls `withButtons`
(`scriptService.ts:218`) to append an IIFE baking the declarative button into
`rpt.ui.registerButton({id,label}, () => eventEmit(getButtonEvent(name)))`. They run in the **inline
`CardScriptHost` iframe** — `sandbox="allow-scripts"`, opaque origin, no `allow-same-origin`
(`CardScriptHost.tsx:427`). The baked button lands in `toolbarStore` (`CardScriptHost.tsx:242`) and renders
in the menu above the input (`ScriptActionsBar.tsx`). Clicking emits `button:命定创意工坊` into the iframe →
the baked handler runs `eventEmit(getButtonEvent('命定创意工坊'))` (`bridge.ts` `emit`/`on`) → the module's
`eventOn` handler.

**Why nothing happens** (the inline iframe is the wrong environment for a full-page app), in order of impact:

1. **The overlay is invisible.** `$('…').appendTo('body')` appends to the _iframe's_ body. The iframe is
   content-sized via `__rptresize` (`bridge.ts:201`), and a `position:fixed` element contributes **0** to
   `scrollHeight` → the frame stays ~1px in the right panel → the modal is clipped to nothing.
2. **The handler throws first.** The frozen inline `TAVERN_SHIM` (`shims/tavern.ts`) is missing/incompatible
   for the workshop's calls: `getCharWorldbookNames` returns a **Promise of a name-list**, not a sync
   `{primary, additional}` (so `.primary` is `undefined`); and there is **no** `isCharacterTavernRegexesEnabled`,
   `updateTavernRegexesWith`, `updateWorldbookWith`, `getCurrentCharacterName`, `getScriptId`, script-scope
   `getVariables`, nor a `SillyTavern` global → `TypeError`, caught to the Logs panel.
3. **`window.open` is blocked** (no `allow-popups`; `form-action 'none'` in the iframe CSP, `bridgeShim.ts`),
   and unless the world's `remoteScripts`/`trusted` grant is on, the remote module never loads — so `eventOn`
   never subscribes and the click reaches no handler at all.

This is not a small bug; the inline iframe fundamentally cannot host this script.

---

## 3. How SillyTavern runs it

JS-Slash-Runner runs each `tavern_helper.script` **in the real ST page** (no per-card isolation). The
declarative button renders in JSR's script-button bar above the input; clicking emits `getButtonEvent(name)`
(JSR `@types/iframe/script.d.ts`: `declare function getButtonEvent(button_name: string): string`). Because
the script runs on the real document, `appendTo('body')` covers the whole app, `window.open`/`fetch` work,
and the worldbook/regex APIs are ST globals with the signatures in JSR's `@types`:

- `getCharWorldbookNames(name): { primary: string|null; additional: string[] }` — **sync**.
- `getWorldbook(name): Promise<WorldbookEntry[]>`; `updateWorldbookWith(name, updater): Promise<WorldbookEntry[]>`.
- `getTavernRegexes(option): TavernRegex[]` (sync); `isCharacterTavernRegexesEnabled(): boolean`;
  `updateTavernRegexesWith(updater, option): Promise<TavernRegex[]>`.

RP Terminal already mirrors most of these in the **WCV** path — just not the inline one.

---

## 4. Design — "Card Script Surfaces"

A WCV is the right host (the user's "workaround"), but it must be **script-driven, not hardcoded**. The hard
part is already built: `wcvManager` (`wcvManager.ts`), the `wcvPreload` shim over the canonical
`createThRuntime` (`wcvPreload.ts`), and a rich host bridge incl. worldbook **read+write** and regex reads
(`wcvIpc.ts`). What's hardcoded is the _entry point_: `WcvPanel.tsx` embeds the `命定之诗` status/home/start
URLs and `viewRegistry.tsx:85` registers `wcv-card`/`wcv-home`/`wcv-start`. This design replaces that with a
registry fed by cards/scripts.

**Core idea:** route a card's full-page scripts to a **process-isolated WCV transport**, surface their
`replaceScriptButtons` buttons into the existing menu, and present a click as a **panel** (docked) or a
**full-window modal** — all driven by the script/card.

### 4a. Script-hosting WCV transport

Add `CardScriptWcvHost` as a sibling to `CardScriptHost`. It hosts the _same_ merged runtime scripts
(`getRuntimeScripts`) in a WCV page built from the `wcvPreload` shim + each script as
`<script type="module">`. This reuses every bridge in `wcvIpc` — worldbook, regex, vars, generation — and
gives scripts the real DOM + network + storage they were written for.

**Transport selection.** Default the inline iframe for lightweight in-message widgets; use the WCV for
full-page scripts. Selected by (in priority order): an explicit manifest flag (4b), else a heuristic
(script calls `replaceScriptButtons`, or imports remote ESM and builds DOM). Keep both transports at parity
through the shared runtime (per `CLAUDE.md`'s "one surface, two transports" rule) — the difference is the
host process and the DOM, not the API.

### 4b. Card/script-declared surfaces (the no-hardcode hook)

A surface is declared by the card (never hardcoded), one of:

- **Runtime button → modal (covers `创意工坊` unmodified):** when a WCV script calls `replaceScriptButtons([...])`,
  the shim sends `wcv-register-button` → main → renderer `toolbarStore`. The script's button appears in the
  menu with **no host knowledge of the card**.
- **Declarative panel (covers the `状态栏` status UI — the chosen path):** a WCV panel is a `panel_ui` slot
  (`view:"wcv"` + `entry` URL + `rect`) in the card-carried layout (§4h). The card declares _where_, _how big_,
  and _what page_ — **nothing is hardcoded**, and no script is needed for a static page. The host mounts the
  `entry` via `WcvPanel`/`wcvManager` with the `wcvPreload` shim. This replaces the old hardcoded `wcv-card`
  view.
- **Runtime panel (deferred — dynamic panels only):** a card-facing `registerScriptPanel({id,title,slot,entry})`
  on `thRuntime` lets a _script_ add a panel at runtime (e.g. one that only appears under some condition); the
  layout can reference it by id. Not needed for `状态栏` (which is static → a declarative slot). Keep as a
  future hook; not on the critical path.

#### Delivery decision for 命定之诗 (locked)

- **首页 (#6) and 自定义开局 (#7) stay inline regex.** They're one-time, message-anchored onboarding — the
  existing inline-card path (`WcvMessageFrame`/`InlineCardFrame`) renders them per the card's regex, unchanged.
- **状态栏 (#5) becomes a declarative WCV panel slot, not a regex.** The persistent status display belongs
  docked (mounted once, survives message paging, live-updates from the latest floor's vars over the existing
  bridge) — not re-injected per AI message. It's a slot in the card's `panel_ui` layout (§4h):

  ```jsonc
  // panel_ui.slots[] — the status panel (replaces regex #5)
  {
    "id": "status",
    "view": "wcv",
    "rect": [8, 0, 4, 6],
    "title": "状态栏",
    "entry": "https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/dist/status/index.html"
  }
  ```

  The `status/index.html` bundle is unchanged — it just renders into the WCV panel body instead of an inline
  message frame; the `wcvPreload` shim supplies `window.Mvu`/`TavernHelper`/`SillyTavern` exactly as the
  current `wcv-card` spike does.

**Import transform (so existing 命定之诗 cards work without re-authoring):** the importer detects the
status-loader regex (`placement:[2]`, replacement does `.load('…/status/index.html')`) and converts it to a
`panel_ui` `wcv` slot (above) — **skipping** it as a display regex. The home/custom_start loader regexes
(`…/home/…`, `…/custom_start/…`) are **not** matched by this rule, so they import normally and stay inline.
(Detection keys on the distinct `status/index.html` URL, so it won't catch the other two.)

### 4c. Button bus across the WCV boundary

Add the missing event trio to `thRuntime` (`index.ts`): `getButtonEvent` (identity-mapped to the raw name,
matching the inline `withButtons` contract), a real `eventOn`/`eventEmit`/`eventRemoveListener` bus, and
`replaceScriptButtons`/`getScriptButtons`. Wiring:

- script → host: `replaceScriptButtons` → `wcv-register-button(name, visible)` → `toolbarStore` (deduped by
  `card:<id>::<name>`, cleared on WCV teardown — mirror `CardScriptHost.tsx:242`/`:275`).
- host → script: clicking the menu button → `wcv-button-click(name)` → `wcvManager.notifyEvent(chatId,
getButtonEvent(name))` → runtime `emit` → the script's `eventOn` handler. (`wcvManager.notifyEvent`
  already exists — `wcvManager.ts:238`.)

### 4d. Modal presentation (button-launched overlay)

For `kind:"modal"` the surface is a **full-window, transparent, hidden** WCV. The module is loaded and
subscribed up front. On button-click: `setVisible(true)` (`wcvManager.setVisible` exists, `wcvManager.ts:170`)

- emit the event → the script paints its own `inset:0` backdrop+modal filling the now-visible WCV (a true
  modal over the app). On dismiss: detect the script's overlay teardown — its content height collapses (reuse
  the `wcv-content-size` reporter, `wcvPreload.ts:64`) or the script calls a new `closeSurface()` / its overlay
  close handler posts a message → `setVisible(false)`. No splitter/bounds-sync tax: the rect is the whole
  window content area (recomputed on window-resize only). This makes _any_ `replaceScriptButtons`-style card
  work as a modal with no per-card code.

### 4e. Fill the `thRuntime` API gaps

Concrete additions to the canonical surface (`thRuntime/index.ts`) + the WCV host (`wcvIpc.ts`):

| Workshop call                                                               | Status today                                    | Action                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getCharWorldbookNames('current')`                                          | ✅ sync `{primary,additional}` (`index.ts:206`) | none                                                                                                                                                                                                                                                                                                |
| `getWorldbook` / `updateWorldbookWith`                                      | ✅ (`index.ts:259`/`:267`)                      | none                                                                                                                                                                                                                                                                                                |
| `getTavernRegexes(option)`                                                  | 🟡 ignores `option` (`index.ts:215`)            | honor `global`/`character`/`preset`                                                                                                                                                                                                                                                                 |
| `isCharacterTavernRegexesEnabled`                                           | ⬜                                              | add (host getter)                                                                                                                                                                                                                                                                                   |
| `updateTavernRegexesWith` / `replaceTavernRegexes`                          | 🔁 no-op (`index.ts:298`)                       | **regex WRITE bridge** — wire to the EXISTING `regexService` (`updateRule`/`saveRegexScript`/`deleteScript`/`setScriptDisabled`); add only a `TavernRegex[]`→store shape map + `wcv-host-replace-regexes` IPC (mirror the worldbook replace path, `wcvIpc.ts:179`). Do NOT build a new regex store. |
| `getCurrentCharacterName`                                                   | ⬜                                              | add (from `charData().name`)                                                                                                                                                                                                                                                                        |
| `SillyTavern.getCurrentChatId`                                              | ⬜                                              | add to the `SillyTavern` object (`index.ts:351`)                                                                                                                                                                                                                                                    |
| `getScriptId`                                                               | ⬜                                              | add (stable per-script id)                                                                                                                                                                                                                                                                          |
| `getVariables({type:'script'})` / `updateVariablesWith(..,{type:'script'})` | 🟡 always stat_data (`index.ts:198`/`:246`)     | honor `script` scope → script-owned KV                                                                                                                                                                                                                                                              |
| `getButtonEvent` / `eventOn` / `replaceScriptButtons`                       | ⬜                                              | add + bridge (4c)                                                                                                                                                                                                                                                                                   |
| `registerScriptPanel({id,title,slot,entry})` (RPT ext)                      | ⬜ deferred                                     | dynamic panels only — NOT the `状态栏` path (that's a declarative `panel_ui` slot, §4b/§4h). Future hook.                                                                                                                                                                                           |

Regex write is the only genuinely missing **wiring** (the rest are getters/bus). The write _storage_
already exists in `regexService` — what's missing is the TH-shape bridge that maps `updateTavernRegexesWith` /
`replaceTavernRegexes(TavernRegex[], option)` onto it. See the reuse map (§4g) for why this must land on the
canonical WCV host only, not the legacy `scriptApiService`/`dispatch` path.

### 4g. Duplication / reuse map — land on the canonical stack, don't grow a third one

The codebase already runs **two parallel card stacks** (verified): a **legacy** one — `bridgeShim` +
`dispatch.ts` + `shims/tavern.ts` (the frozen `TAVERN_SHIM`) + `scriptApiService.ts`, used by
`CardScriptHost` (card scripts) and `PluginHost` (plugins) — and the **canonical** one — `shared/thRuntime`
over two transports (`cardBridge` inline / `wcvPreload` WCV) + the `wcvIpc`/`wcvHost` bridge, used by the
card-HTML renderers (`InlineCardFrame`, `WcvMessageFrame`, `WcvPanel`). Card scripts (the `创意工坊` case)
sit on the **legacy** stack; this design moves them to the **canonical** one. The hard rule for the
implementation: **reuse the canonical pieces; do not extend the legacy stack and do not write new
equivalents.**

| Need                                                                   | Reuse (don't rebuild)                                                                                                    | Notes / duplication to avoid                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Out-of-process host + bounds/visibility                                | `wcvManager` + `window.api.wcv*` (`wcvEnsure`/`SetBounds`/`SetVisible`/`Destroy`, already exposed in `preload/index.ts`) | A WCV manager already serves both inline-message frames and panels; add a slot, not a new manager.                                                                                                                                                                                                            |
| Building the script's WCV page                                         | `buildCardDoc` + `cardEnv`/`buildWcvLibTags` (as `WcvMessageFrame` does) — wrap each script as `<script type="module">`  | The inline iframe's `buildScriptSrcDoc` (`bridgeShim.ts`) is the LEGACY-stack doc builder; don't reuse it for the WCV path.                                                                                                                                                                                   |
| TH/MVU/ST API surface                                                  | `shared/thRuntime` (one place)                                                                                           | Do NOT add the new helpers (regex write, `getButtonEvent`, `getCurrentChatId`, script-scope vars) to `shims/tavern.ts` — it's frozen, and that would re-create drift.                                                                                                                                         |
| Host data access (worldbook/regex/char/preset reads + worldbook write) | the `wcvIpc` host bridge (worldbook read+write already there)                                                            | `scriptApiService.ts` is the LEGACY parallel of `wcvIpc` over the same services (`lorebookService`, `regexService`, …). Card-script reads/writes go through `wcvIpc`; leave `scriptApiService` for the plugin path.                                                                                           |
| Regex write storage                                                    | `regexService` (`updateRule`/`saveRegexScript`/`deleteScript`)                                                           | No existing TH-regex-write bridge; add the shape map only.                                                                                                                                                                                                                                                    |
| Lifecycle/MVU events → script                                          | the existing `App.tsx` → `wcvBroadcastEvent`/`wcvBroadcastVars` → `wcvManager.notifyEvent` path                          | `CardScriptHost` has its OWN event forwarding (`chatTransitionEvents`/`messageMutationEvents`/`buildMvuEvents` → iframe, `CardScriptHost.tsx:322-364`) computed from the SAME `plugin/events.ts`. Moving scripts to the WCV makes that bespoke forwarding unnecessary — reuse App's broadcast, don't port it. |
| Button menu UI                                                         | `toolbarStore` + `ScriptActionsBar`                                                                                      | Already host-rendered; add only the WCV→toolbar bridge (§4c).                                                                                                                                                                                                                                                 |
| Modal show/hide                                                        | `wcvSetVisible` + the script's own backdrop                                                                              | No new `Modal.tsx`/portal needed — the WCV is the modal.                                                                                                                                                                                                                                                      |
| Merged runtime scripts                                                 | the shared `get-runtime-scripts` IPC                                                                                     | Single source already; reuse as-is.                                                                                                                                                                                                                                                                           |
| Per-card consent / trust grant                                         | the existing `ConsentCardView` + `trusted`/`remoteScripts` grants                                                        | Reuse the gate; don't add a parallel consent.                                                                                                                                                                                                                                                                 |

### 4h. Card-carried panel layout (the workspace the card ships)

**Vision:** a character card carries its own workspace layout — how many WCV panels, where each sits, and how
big. The schema already models this and just needs to become the **source of truth on import** (it's a spike
today): `rp_terminal.panel_ui` (`character.ts:71`) is a `grid {cols, rows}` + `slots[]`, each slot a
`rect: [col, row, colSpan, rowSpan]`, rendered by `StaticWorkspace` (`StaticWorkspace.tsx`), with
`DEFAULT_STATIC_LAYOUT` (`WcvPanel.tsx`) as a worked example. So:

- **position** = `[col, row]`, **size** = `[colSpan, rowSpan]`, **number of WCV** = how many slots are WCV.
- **Grid-relative, not pixels** — `[col,row,colSpan,rowSpan]` over a `cols×rows` grid is resolution-independent
  (resolves to pixel bounds at render time, recomputed on window resize). Optional per-slot `minPx`
  constraints can be added later; keep the unit grid-relative.

**Slot content kinds** (unifies §4b — a slot says _where_, this says _what_):

- a **native view** id (`"chat"`, `"status"`, `"usage"`, …) → the existing `ViewRegistry`;
- `view:"wcv"` + `entry:"…url…"` → a card WCV panel declared inline in the layout (no script needed — best
  for a static page like the status UI);
- `view:"<panel-id>"` referencing a `registerScriptPanel({id})` → a script-registered panel placed by the
  layout (for panels created/conditional at runtime).

This reconciles the two ways to get the **status** panel: with a card-carried layout, the simplest form is a
**declarative `wcv` slot** carrying the status URL — `registerScriptPanel` (§4b) stays for _dynamic_ panels.
A card may mix: declarative slots for fixed panels, script registration for runtime ones.

**Inline-regex UIs are NOT panels.** `首页`/`自定义开局` (onboarding) AND the in-message beautifications —
including **角色查看器** (#11, `placement:[1,2]`), 命运抽卡, the combat/dialogue skins — live in the chat
message flow via regex (rendered by `WcvMessageFrame`/`InlineCardFrame`). They are independent of `panel_ui`;
the layout governs ONLY the docked workspace panels. For 命定之诗 the only docked panel is `状态栏`.

**Example — 命定之诗** (`chat` left, `状态栏` right; **1 WCV panel** — everything else stays inline):

```jsonc
"panel_ui": {
  "mode": "static",
  "grid": { "cols": 12, "rows": 12 },
  "slots": [
    { "id": "chat",   "view": "chat", "rect": [0, 0, 8, 12] },
    { "id": "status", "view": "wcv",  "rect": [8, 0, 4, 12], "title": "状态栏",
      "entry": "https://…/FrontEnd-for-destined-journey@1.8.2/dist/status/index.html" }
  ]
}
```

**Import wiring:**

- A card that **carries** `panel_ui` → the workspace uses `StaticWorkspace` with that layout; cards without it
  keep the default resizable workspace (no regression for plain ST cards).
- For **legacy** cards that don't carry it (like this 命定之诗 build), the importer **synthesizes** `panel_ui`
  from detected UIs — the `状态栏` status-loader regex → a `wcv` slot (per the §4b transform); future detected
  panels add slots. The number of WCV panels is whatever was detected/declared.
- Surface it in the **import confirm**: extend `summarizeCardBundle` (`characterService.ts:157`) to report the
  panel count + layout, so the user sees "Layout: N panels" before installing.

**Perf / lifecycle:** each WCV slot is its own OS/renderer process — `N` panels = `N` processes. Create lazily,
destroy on session switch, cap the count, and `setVisible(false)` when hidden (the policy already in
`docs/card-custom-ui-design.md`). The card declaring the layout means the rects are stable (computed once per
window size), which is what keeps the overlay model cheap.

**Layout mode (locked): static.** The card's layout **locks** the workspace — fixed rects, no user
resize/rearrange in v1 (the cleanest fit for the WCV overlay: stable bounds computed once per window size, no
live-drag trailing; the recorded direction in `docs/card-custom-ui-design.md`). Opt-in resize (persisted per
card+profile, with "reset to card layout") is a **deferred** follow-up, not built first.

### 4f. Network + OAuth

`CARD_CSP` already allows `connect-src *` (`wcvManager.ts:20`), so the Cloudflare fetch works. The OAuth
`window.open` needs a `setWindowOpenHandler` on the **card WCV** (today only the main window has one, which
denies → external browser, `index.ts:59`) — allow it as a child popup and relay the `postMessage` callback.
Gate behind the same trusted-card consent that already guards remote card code (the `ConsentCardView` gate,
`WcvPanel.tsx:107`; the per-card `trusted`/`remoteScripts` grant, `CardScriptHost.tsx`).

---

## 5. Build order

1. **`thRuntime` gaps + regex write** (4e) — pure surface/bridge work, independently useful; unblocks both
   transports. _Touches the card-facing surface → update the SDK docs (see below)._
2. **Button bus across WCV** (4c) — `replaceScriptButtons` → menu, click → event.
3. **`CardScriptWcvHost` transport** (4a) + transport selection — host existing scripts in a WCV.
4. **Modal presentation** (4d) — hidden full-window WCV toggled by the button. → **`创意工坊` opens and can
   read/diff/write.**
5. **OAuth window-open** (4f) — completes cloud login.
6. **Card-carried layout (§4h, static-locked) + the import transform**: make `panel_ui` the source of truth —
   when a card carries it, render `StaticWorkspace`; else keep the resizable workspace. Add the import
   transform that turns the `状态栏` status-loader regex into a `panel_ui` `wcv` slot (skipping it as a display
   regex), and surface the panel count in the import confirm. Then **retire the hardcoded `wcv-*` views**
   (`viewRegistry.tsx:84`, `WcvPanel.tsx`) — **replace, don't remove**, per the locked decision:
   - `状态栏` → a declarative `wcv` **panel slot** (§4b/§4h) replacing `wcv-card` + the regex.
   - `首页` / `自定义开局` → stay **inline regex** (#6/#7, `placement:[2]`), already rendered by the
     card-agnostic inline path (`WcvMessageFrame` isolated / `InlineCardFrame`); just drop the `wcv-home` /
     `wcv-start` hardcodes.

   Delete a hardcoded entry only once its replacement (the panel slot for status; the inline-regex path for
   home/creation) is in place — so there's no window where 命定之诗 loses UI. (`registerScriptPanel` is
   deferred — dynamic panels only, §4e.)

After step 4 the button works for download/sync; 5 adds cloud login; 6 removes the hardcoding so every card
gets the same door.

## 6. Security

- A card script in a WCV runs **out-of-process** (`nodeIntegration:false`, no host/Node reach) — the real
  isolation boundary, same as the existing spike. Process isolation also fixes the freeze risk that shelved
  inline frontend cards (`docs/card-custom-ui-design.md`).
- Remote code + the new `window.open`/OAuth are **trusted-card only**, behind the existing per-card consent +
  `trusted`/`remoteScripts` grant. Don't auto-run.
- Worldbook/regex **writes** route through the host bridge (validated against the schema in `wcvIpc.ts`
  `toLoreEntry`; add the equivalent for regex) — the script never writes files directly.
- Regex write reloads chat (`tavern_events.CHAT_CHANGED` per JSR semantics) — debounce/guard so a card can't
  thrash the chat.

## 7. Files this will touch (for the eventual implementation)

- `src/shared/thRuntime/index.ts` — API gaps + button bus + script-scope vars (4c, 4e). `registerScriptPanel`
  is deferred (dynamic panels only).
- `src/main/services/characterService.ts` — (a) import transform: detect the `状态栏` status-loader regex
  (`.load('…/status/index.html')`, `placement:[2]`) → add a `panel_ui` `wcv` slot + skip it as a display
  regex; leave `首页`/`自定义开局` regexes untouched. (b) `summarizeCardBundle` (`:157`) reports the panel
  count/layout for the import confirm.
- `src/renderer/src/components/workspace/StaticWorkspace.tsx` + the workspace switch — render the card's
  `panel_ui` (static-locked) when present; `wcv` slots mount `WcvPanel` with the slot's `entry`. Retire the
  static `wcv-card/home/start` entries in `viewRegistry.tsx`/`WcvPanel.tsx`.
- `src/main/ipc/wcvIpc.ts` — `wcv-register-button`, `wcv-button-click`, `wcv-host-replace-regexes`,
  `isCharacterTavernRegexesEnabled`, `getCurrentCharacterName`, chat-id getter, script-scope var IPC.
- `src/main/services/wcvManager.ts` — modal show/hide lifecycle; `setWindowOpenHandler` for OAuth.
- `src/preload/wcvPreload.ts` — script-module loading + the button/close bridge.
- `src/renderer/src/components/CardScriptWcvHost.tsx` (new) + transport selection in `viewRegistry.tsx`.
- `src/renderer/src/stores/toolbarStore.ts` — already fits; feed it from the WCV bridge.
- `src/main/types/character.ts` — `panel_ui` (`:71`) already models the layout; no schema change needed
  (optional later: a min-size constraint / explicit static-lock marker).
  **Reuse, don't modify** (per §4g): `src/main/services/regexService.ts` (regex write storage),
  `src/renderer/src/App.tsx` (already broadcasts lifecycle/MVU events to all WCVs on the chat),
  `src/main/services/scriptApiService.ts` + `src/main/ipc/pluginIpc.ts` + `src/renderer/src/plugin/*`
  (the legacy iframe/plugin stack — leave it for plugins; do not extend it for card scripts).

- **SDK docs**: when step 1/4b land, update `docs/sdk/component-inventory.md` §2 (runtime API) + §4 (format)
  and `docs/rpt-api.md`, per `docs/sdk/README.md`.
