# Card Script Surfaces — running card scripts in a WCV & letting cards register their own UI

Status: **Design / not built.** Motivating case: the `【命定之诗】创意工坊` button does nothing in RP Terminal.
Builds on `docs/card-custom-ui-design.md` (the iframe-vs-WCV analysis + the `WebContentsView` plan) and the
already-built WCV spike (`wcvManager`, `wcvPreload`, the `wcvIpc` host bridge). This doc generalizes that
spike from **three hardcoded `命定之诗` URLs** into a **card/script-driven surface registry**, and routes
full-page card scripts to a process-isolated WCV instead of the crippled inline iframe.

## Goal

1. Make `创意工坊` (and any script like it) work: a button in the menu above the input opens a **modal** to
   download/sync lorebook entries + regex from a cloud store.
2. Do it **without hardcoding** the card. A card adds its own WCV surface purely through script API calls
   (`replaceScriptButtons` + `eventOn(getButtonEvent(...))`) and/or a declarative manifest slot — the host
   has zero card-specific knowledge.
3. Fold the existing hardcoded `wcv-card` / `wcv-home` / `wcv-start` spike views into the same mechanism.
   **Locked delivery for 命定之诗 (see §4b):** `状态栏` → a script-registered WCV **panel** (replaces the old
   `wcv-card` hardcode + the status regex); `首页` / `自定义开局` → stay **inline regex** (drop `wcv-home` /
   `wcv-start`).

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

Net: *a button that opens a modal to download/sync lorebook entries + regex from a cloud store.*

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

1. **The overlay is invisible.** `$('…').appendTo('body')` appends to the *iframe's* body. The iframe is
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
(`wcvIpc.ts`). What's hardcoded is the *entry point*: `WcvPanel.tsx` embeds the `命定之诗` status/home/start
URLs and `viewRegistry.tsx:85` registers `wcv-card`/`wcv-home`/`wcv-start`. This design replaces that with a
registry fed by cards/scripts.

**Core idea:** route a card's full-page scripts to a **process-isolated WCV transport**, surface their
`replaceScriptButtons` buttons into the existing menu, and present a click as a **panel** (docked) or a
**full-window modal** — all driven by the script/card.

### 4a. Script-hosting WCV transport
Add `CardScriptWcvHost` as a sibling to `CardScriptHost`. It hosts the *same* merged runtime scripts
(`getRuntimeScripts`) in a WCV page built from the `wcvPreload` shim + each script as
`<script type="module">`. This reuses every bridge in `wcvIpc` — worldbook, regex, vars, generation — and
gives scripts the real DOM + network + storage they were written for.

**Transport selection.** Default the inline iframe for lightweight in-message widgets; use the WCV for
full-page scripts. Selected by (in priority order): an explicit manifest flag (4b), else a heuristic
(script calls `replaceScriptButtons`, or imports remote ESM and builds DOM). Keep both transports at parity
through the shared runtime (per `CLAUDE.md`'s "one surface, two transports" rule) — the difference is the
host process and the DOM, not the API.

### 4b. Card/script-declared surfaces (the no-hardcode hook)
A surface is registered two ways, both card-driven:

- **Runtime button → modal (covers `创意工坊` unmodified):** when a WCV script calls `replaceScriptButtons([...])`,
  the shim sends `wcv-register-button` → main → renderer `toolbarStore`. The script's button appears in the
  menu with **no host knowledge of the card**.
- **Runtime panel (covers the `状态栏` status UI):** add a card-facing API `registerScriptPanel(def)` to
  `thRuntime` (an RPT extension, also exposed bare + on `TavernHelper`):

  ```js
  registerScriptPanel({ id, title, slot, entry })
  ```

  The script tells the host to dock a WCV panel whose body loads `entry` (a URL) with the `wcvPreload` shim.
  The host registers a dynamic view (id/title) and mounts it via `WcvPanel`/`wcvManager` at `slot` — **the URL
  comes from the script, nothing is hardcoded.** This is the script-form replacement for the old hardcoded
  `wcv-card` view: same status page, same shim, now registered by the card.
- **Declarative (alternative to the runtime panel):** extend the existing schema (`character.ts:62` for
  `scripts[]`, `character.ts:71` for `panel_ui`) with a per-script/per-slot `surface`:

  ```jsonc
  // rp_terminal.scripts[i].surface  — OR a panel_ui slot
  "surface": {
    "kind": "panel" | "modal",   // docked in a workspace slot, or full-window button-launched
    "transport": "wcv",          // (default for surfaces) process-isolated
    "title": "命定创意工坊",
    "button": "命定创意工坊",     // for kind:"modal" — the menu button that opens it
    "slot": "right",             // for kind:"panel"
    "entry": "…/status/index.html" // for a page-backed panel
  }
  ```

  A card may ship both a declarative panel and runtime buttons; the registry merges them.

#### Delivery decision for 命定之诗 (locked)

- **首页 (#6) and 自定义开局 (#7) stay inline regex.** They're one-time, message-anchored onboarding — the
  existing inline-card path (`WcvMessageFrame`/`InlineCardFrame`) renders them per the card's regex, unchanged.
- **状态栏 (#5) becomes a script-registered WCV panel, not a regex.** The persistent status display belongs
  docked (mounted once, survives message paging, live-updates from the latest floor's vars over the existing
  bridge) — not re-injected per AI message. Replace the regex with a tiny card script:

  ```js
  // 【命定之诗】状态栏 (replaces regex #5)
  registerScriptPanel({
    id: 'mds-status',
    title: '状态栏',
    slot: 'right',
    entry: 'https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@1.8.2/dist/status/index.html',
  })
  ```

  The `status/index.html` bundle is unchanged — it just renders into the WCV panel body instead of an inline
  message frame; the `wcvPreload` shim supplies `window.Mvu`/`TavernHelper`/`SillyTavern` exactly as the
  current `wcv-card` spike does.

**Import transform (so existing 命定之诗 cards work without re-authoring):** the importer detects the
status-loader regex (`placement:[2]`, replacement does `.load('…/status/index.html')`) and converts it to the
panel registration above — synthesizing the script into `rp_terminal.scripts` (or a `panel_ui` slot) and
**skipping** it as a display regex. The home/custom_start loader regexes (`…/home/…`, `…/custom_start/…`) are
**not** matched by this rule, so they import normally and stay inline. (Detection keys on the distinct
`status/index.html` URL, so it won't catch the other two.)

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
+ emit the event → the script paints its own `inset:0` backdrop+modal filling the now-visible WCV (a true
modal over the app). On dismiss: detect the script's overlay teardown — its content height collapses (reuse
the `wcv-content-size` reporter, `wcvPreload.ts:64`) or the script calls a new `closeSurface()` / its overlay
close handler posts a message → `setVisible(false)`. No splitter/bounds-sync tax: the rect is the whole
window content area (recomputed on window-resize only). This makes *any* `replaceScriptButtons`-style card
work as a modal with no per-card code.

### 4e. Fill the `thRuntime` API gaps
Concrete additions to the canonical surface (`thRuntime/index.ts`) + the WCV host (`wcvIpc.ts`):

| Workshop call | Status today | Action |
| --- | --- | --- |
| `getCharWorldbookNames('current')` | ✅ sync `{primary,additional}` (`index.ts:206`) | none |
| `getWorldbook` / `updateWorldbookWith` | ✅ (`index.ts:259`/`:267`) | none |
| `getTavernRegexes(option)` | 🟡 ignores `option` (`index.ts:215`) | honor `global`/`character`/`preset` |
| `isCharacterTavernRegexesEnabled` | ⬜ | add (host getter) |
| `updateTavernRegexesWith` / `replaceTavernRegexes` | 🔁 no-op (`index.ts:298`) | **regex WRITE bridge** — wire to the EXISTING `regexService` (`updateRule`/`saveRegexScript`/`deleteScript`/`setScriptDisabled`); add only a `TavernRegex[]`→store shape map + `wcv-host-replace-regexes` IPC (mirror the worldbook replace path, `wcvIpc.ts:179`). Do NOT build a new regex store. |
| `getCurrentCharacterName` | ⬜ | add (from `charData().name`) |
| `SillyTavern.getCurrentChatId` | ⬜ | add to the `SillyTavern` object (`index.ts:351`) |
| `getScriptId` | ⬜ | add (stable per-script id) |
| `getVariables({type:'script'})` / `updateVariablesWith(..,{type:'script'})` | 🟡 always stat_data (`index.ts:198`/`:246`) | honor `script` scope → script-owned KV |
| `getButtonEvent` / `eventOn` / `replaceScriptButtons` | ⬜ | add + bridge (4c) |
| `registerScriptPanel({id,title,slot,entry})` (RPT ext) | ⬜ | add — dock a WCV panel loading `entry` via `WcvPanel`/`wcvManager` (4b); the `状态栏` path |

Regex write is the only genuinely missing **wiring** (the rest are getters/bus). The write *storage*
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

| Need | Reuse (don't rebuild) | Notes / duplication to avoid |
| --- | --- | --- |
| Out-of-process host + bounds/visibility | `wcvManager` + `window.api.wcv*` (`wcvEnsure`/`SetBounds`/`SetVisible`/`Destroy`, already exposed in `preload/index.ts`) | A WCV manager already serves both inline-message frames and panels; add a slot, not a new manager. |
| Building the script's WCV page | `buildCardDoc` + `cardEnv`/`buildWcvLibTags` (as `WcvMessageFrame` does) — wrap each script as `<script type="module">` | The inline iframe's `buildScriptSrcDoc` (`bridgeShim.ts`) is the LEGACY-stack doc builder; don't reuse it for the WCV path. |
| TH/MVU/ST API surface | `shared/thRuntime` (one place) | Do NOT add the new helpers (regex write, `getButtonEvent`, `getCurrentChatId`, script-scope vars) to `shims/tavern.ts` — it's frozen, and that would re-create drift. |
| Host data access (worldbook/regex/char/preset reads + worldbook write) | the `wcvIpc` host bridge (worldbook read+write already there) | `scriptApiService.ts` is the LEGACY parallel of `wcvIpc` over the same services (`lorebookService`, `regexService`, …). Card-script reads/writes go through `wcvIpc`; leave `scriptApiService` for the plugin path. |
| Regex write storage | `regexService` (`updateRule`/`saveRegexScript`/`deleteScript`) | No existing TH-regex-write bridge; add the shape map only. |
| Lifecycle/MVU events → script | the existing `App.tsx` → `wcvBroadcastEvent`/`wcvBroadcastVars` → `wcvManager.notifyEvent` path | `CardScriptHost` has its OWN event forwarding (`chatTransitionEvents`/`messageMutationEvents`/`buildMvuEvents` → iframe, `CardScriptHost.tsx:322-364`) computed from the SAME `plugin/events.ts`. Moving scripts to the WCV makes that bespoke forwarding unnecessary — reuse App's broadcast, don't port it. |
| Button menu UI | `toolbarStore` + `ScriptActionsBar` | Already host-rendered; add only the WCV→toolbar bridge (§4c). |
| Modal show/hide | `wcvSetVisible` + the script's own backdrop | No new `Modal.tsx`/portal needed — the WCV is the modal. |
| Merged runtime scripts | the shared `get-runtime-scripts` IPC | Single source already; reuse as-is. |
| Per-card consent / trust grant | the existing `ConsentCardView` + `trusted`/`remoteScripts` grants | Reuse the gate; don't add a parallel consent. |

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

**Slot content kinds** (unifies §4b — a slot says *where*, this says *what*):
- a **native view** id (`"chat"`, `"status"`, `"usage"`, …) → the existing `ViewRegistry`;
- `view:"wcv"` + `entry:"…url…"` → a card WCV panel declared inline in the layout (no script needed — best
  for a static page like the status UI);
- `view:"<panel-id>"` referencing a `registerScriptPanel({id})` → a script-registered panel placed by the
  layout (for panels created/conditional at runtime).

This reconciles the two ways to get the **status** panel: with a card-carried layout, the simplest form is a
**declarative `wcv` slot** carrying the status URL — `registerScriptPanel` (§4b) stays for *dynamic* panels.
A card may mix: declarative slots for fixed panels, script registration for runtime ones.

**Inline-regex UIs are NOT panels.** `首页`/`自定义开局` (and the beautifications) live in the chat message
flow via regex; they're independent of `panel_ui`. The layout governs only the docked workspace panels.

**Example — 命定之诗** (`chat` left, status top-right, character-viewer bottom-right; 2 WCV panels):

```jsonc
"panel_ui": {
  "mode": "static",
  "grid": { "cols": 12, "rows": 12 },
  "slots": [
    { "id": "chat",   "view": "chat",  "rect": [0, 0, 8, 12] },
    { "id": "status", "view": "wcv",   "rect": [8, 0, 4, 6], "title": "状态栏",
      "entry": "https://…/FrontEnd-for-destined-journey@1.8.2/dist/status/index.html" },
    { "id": "viewer", "view": "wcv",   "rect": [8, 6, 4, 6], "title": "角色查看器", "entry": "…" }
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

**Open decision — static-locked vs card-seeded-resizable:** does the card's layout **lock** the workspace
(fixed rects, no user resize — the cleanest fit for the WCV overlay, the recorded direction in
`docs/card-custom-ui-design.md`), or is it a **default** the user can then resize/rearrange (persisted per
card+profile), accepting the live-drag bounds-sync tax for WCV slots? Recommendation: **honor the card layout
as the default and ship static first**, add opt-in resize (persisted, with "reset to card layout") later — so
the card's vision renders faithfully without paying the resize-overlay cost up front.

### 4f. Network + OAuth
`CARD_CSP` already allows `connect-src *` (`wcvManager.ts:20`), so the Cloudflare fetch works. The OAuth
`window.open` needs a `setWindowOpenHandler` on the **card WCV** (today only the main window has one, which
denies → external browser, `index.ts:59`) — allow it as a child popup and relay the `postMessage` callback.
Gate behind the same trusted-card consent that already guards remote card code (the `ConsentCardView` gate,
`WcvPanel.tsx:107`; the per-card `trusted`/`remoteScripts` grant, `CardScriptHost.tsx`).

---

## 5. Build order

1. **`thRuntime` gaps + regex write** (4e) — pure surface/bridge work, independently useful; unblocks both
   transports. *Touches the card-facing surface → update the SDK docs (see below).*
2. **Button bus across WCV** (4c) — `replaceScriptButtons` → menu, click → event.
3. **`CardScriptWcvHost` transport** (4a) + transport selection — host existing scripts in a WCV.
4. **Modal presentation** (4d) — hidden full-window WCV toggled by the button. → **`创意工坊` opens and can
   read/diff/write.**
5. **OAuth window-open** (4f) — completes cloud login.
6. **Panel registration + `surface` schema** (4b): add `registerScriptPanel` + the dynamic panel-view
   registry, and the **import transform** that turns the `状态栏` status-loader regex into the panel script
   (skipping it as a display regex). Then **retire the hardcoded `wcv-*` views** (`viewRegistry.tsx:84`,
   `WcvPanel.tsx`) — **replace, don't remove**, per the locked decision:
   - `状态栏` → a script-registered WCV **panel** (`registerScriptPanel`, §4b) replacing `wcv-card` + the regex.
   - `首页` / `自定义开局` → stay **inline regex** (#6/#7, `placement:[2]`), already rendered by the
     card-agnostic inline path (`WcvMessageFrame` isolated / `InlineCardFrame`); just drop the `wcv-home` /
     `wcv-start` hardcodes.

   Delete a hardcoded entry only once its replacement (the panel script for status; the inline-regex path for
   home/creation) is in place — so there's no window where 命定之诗 loses UI.

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

- `src/shared/thRuntime/index.ts` — API gaps + button bus + script-scope vars + `registerScriptPanel` (4c, 4e).
- `src/main/services/characterService.ts` (import transform) — detect the `状态栏` status-loader regex
  (`.load('…/status/index.html')`, `placement:[2]`) → synthesize the `registerScriptPanel` script into
  `rp_terminal.scripts` and skip it as a display regex; leave `首页`/`自定义开局` regexes untouched.
- `src/renderer/src/components/workspace/viewRegistry.tsx` — a **dynamic** panel-view registry fed by
  `registerScriptPanel` (panel body = `WcvPanel` loading the script's `entry`), replacing the static `wcv-*`.
- `src/main/ipc/wcvIpc.ts` — `wcv-register-button`, `wcv-button-click`, `wcv-host-replace-regexes`,
  `isCharacterTavernRegexesEnabled`, `getCurrentCharacterName`, chat-id getter, script-scope var IPC.
- `src/main/services/wcvManager.ts` — modal show/hide lifecycle; `setWindowOpenHandler` for OAuth.
- `src/preload/wcvPreload.ts` — script-module loading + the button/close bridge.
- `src/renderer/src/components/CardScriptWcvHost.tsx` (new) + transport selection in `viewRegistry.tsx`.
- `src/renderer/src/stores/toolbarStore.ts` — already fits; feed it from the WCV bridge.
- `src/main/types/character.ts` — the `surface` schema (4b).
- Delete the hardcoded `wcv-card/home/start` in `viewRegistry.tsx` + `WcvPanel.tsx` (step 6).
**Reuse, don't modify** (per §4g): `src/main/services/regexService.ts` (regex write storage),
`src/renderer/src/App.tsx` (already broadcasts lifecycle/MVU events to all WCVs on the chat),
`src/main/services/scriptApiService.ts` + `src/main/ipc/pluginIpc.ts` + `src/renderer/src/plugin/*`
(the legacy iframe/plugin stack — leave it for plugins; do not extend it for card scripts).

- **SDK docs**: when step 1/4b land, update `docs/sdk/component-inventory.md` §2 (runtime API) + §4 (format)
  and `docs/rpt-api.md`, per `docs/sdk/README.md`.
