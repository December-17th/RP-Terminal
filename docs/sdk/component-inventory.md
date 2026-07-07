# RP Terminal — Card SDK Component Inventory

> **Living document, v0.1 (started 2026-06-24).** A catalog of the building blocks that make up
> RP Terminal's "card SDK" — what a card can _call_, the environment it _runs in_, the _format_ it is
> stored as, and how an existing **SillyTavern / TavernHelper card is transformed** into that format.
> This is the seed of the `docs/sdk/` set; it is **not exhaustive** and is meant to grow. See
> [README.md](README.md) for the maintenance contract.

Status legend: ✅ built · 🟡 partial · 🔁 graceful stub (logs / safe default) · ⬜ planned

Every claim below cites the file it was verified against (per `CLAUDE.md` grounding). When you change one
of those files, update the matching row here in the same change.

---

## 0. The big picture — do we have a "card standard"?

**Effectively yes, and it is ST-compatible by construction.** RP Terminal does _not_ invent a new card
spec string. A card is a SillyTavern **`chara_card_v3`** object whose RP-Terminal-specific payload rides
entirely under **`data.extensions.rp_terminal`** (verified [character.ts:130](../../src/main/types/character.ts)).
SillyTavern reads the prose / lorebook / regex and ignores our namespace; we read everything. So:

- **The "format" = `chara_card_v3` + the `rp_terminal` extension namespace.** Already implemented and
  versioned (`RPTerminalCardSchema`, normalized to `chara_card_v3`).
- **The "container" = a PNG cartridge.** The direction you're leaning toward — _store all scripts, regex,
  preset and per-card customizations in a PNG_ — is already the documented **World Card** plan
  ([world-card-design.md](../world-card-design.md) §3, §8). The card's bundle (scripts/regex/presets/
  lorebooks/UI/theme/combat/agent) is plain text under `extensions.rp_terminal`, embeddable in the PNG's
  `chara`/`ccv3` text chunk; binary assets go in an appended ZIP. See §6 below.
- **The "transform" = lossless import + route + best-effort JS.** See §5.

The practical takeaway: you are not greenfield. The standard exists in code; what's unfinished is (a)
formally _blessing_ `v3 + rp_terminal` as **the** standard, and (b) finishing the PNG cartridge
(compressed-`iTXt` read + appended-ZIP) and the lossless import routing.

---

## 1. SDK layers at a glance

| Layer                        | What it is                                                                          | Canonical source                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **A. Card runtime API**      | The TavernHelper / SillyTavern / MVU / EJS globals a card's scripts + frontend call | [`shared/thRuntime`](../../src/shared/thRuntime/index.ts)                  |
| **B. Rendering environment** | The `<head>` + libs + sizing a card is rendered inside (dual-mode)                  | [`shared/cardEnv.ts`](../../src/shared/cardEnv.ts)                         |
| **C. Authoring format**      | The card schema + the `rp_terminal` bundle namespace                                | [`types/character.ts`](../../src/main/types/character.ts)                  |
| **D. Import / transform**    | ST PNG/JSON → our card; route bundled artifacts to stores                           | [`stPngParser`](../../src/main/parsers/stPngParser.ts), `characterService` |
| **E. Host subsystems**       | The stores/services a transformed card's pieces live in                             | lorebook / regex / preset / plugin / mvu / template services               |
| **F. Game-platform targets** | The "make it a game" components (panels, native stat UI, combat, agent)             | mostly design-stage                                                        |

---

## 2. Layer A — Card runtime API (`thRuntime`)

The **single canonical surface** is `createThRuntime(host)` ([thRuntime/index.ts](../../src/shared/thRuntime/index.ts)),
built over a realm-agnostic **`Host` seam** ([thRuntime/types.ts](../../src/shared/thRuntime/types.ts)). Two
transports implement the same surface, so a card behaves identically in either
(parity by construction — [th-parity-status.md](../superpowers/specs/2026-06-23-th-parity-status.md)):

- **Inline** (default) — `createThRuntime(createInlineHost(ctx))` at
  [createCardBridge.ts:9](../../src/renderer/src/cardBridge/createCardBridge.ts); Host backed by Zustand
  reads + `window.api` ([cardBridge/host.ts](../../src/renderer/src/cardBridge/host.ts)).
- **Isolated / WCV** — `createThRuntime(...)` at `wcvPreload.ts:280`; Host backed by `ipcRenderer.sendSync`
  (sync getters) + `invoke` (async) over the `wcv-host-*` IPC.

**WCV-transport-only host method** (not on the `thRuntime` surface — a WCV is a native overlay with its
own screen rect, which an inline DOM card doesn't need): `window.rptHost.getPanelGeometry()` →
`{ x, y, width, height, viewportWidth, viewportHeight }` (the page's slot rect in window-content coords
+ the window content size), with `onPanelGeometry(cb)` for changes and a `rpt:panelgeometry` window
event. Lets a page draw a full-viewport background offset by its own `x` so adjacent seamless slots
compose into one continuous stage (the seam-slicing primitive — pairs with `panel_ui.seamless`, §4).
Seeded synchronously at preload load; refreshed by main on every bounds change. Verify:
[`wcvPreload.ts:98`](../../src/preload/wcvPreload.ts), [`wcvGeometry.ts`](../../src/main/services/wcvGeometry.ts).

**WCV-transport-only host method** (sibling-panel coordination — only meaningful when a card runs across
multiple WCV surfaces): `window.rptHost.broadcastEvent(name, payload)` fans a card-authored event out to
the OTHER card panels on the same chat (not back to the sender); they receive it via `eventOn(name, cb)`.
The chat is resolved from the sender in main (a card can't target another session) and the name is opaque
to RPT, so this stays card-agnostic. The poem play-area surfaces use it for `self:fold` /
`stage:cast-changed` (redesign §5.3). Verify: [`wcvIpc.ts`](../../src/main/ipc/wcvIpc.ts)
(`wcv-host-broadcast-event`) → [`wcvManager.notifyEvent`](../../src/main/services/wcvManager.ts).

### Globals exposed to a card

| Global                          | Contents                                                                                                                                         | Status          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `TavernHelper` (+ bare helpers) | variables (+ script scope), chat r/w, worldbook CRUD, char/preset read, regex read/format/write, generate, events, `triggerSlash`, macros, audio | ✅ (gaps below) |
| `Mvu`                           | `getMvuData`/`getMvuVariable`/`setMvuVariable`/`replaceMvuData`/`parseMessage`/`events`                                                          | ✅              |
| `SillyTavern`                   | `getContext()`, `chat[]` (+swipes), `substituteParams`, `saveChat`, `reloadCurrentChat`, `eventSource`, `saveSettingsDebounced` (no-op)          | ✅              |
| `EjsTemplate`                   | `evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`/…                                                            | ✅              |
| `toastr`, `tavern_events`       | toast bus; the events enum                                                                                                                       | ✅              |
| injected libs                   | see Layer B                                                                                                                                      | ✅              |

### API domains

| Domain                 | Methods                                                                                                                                                | Status  | Notes                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Variables / MVU**    | `getVariables`, `insertOrAssignVariables`, `insertVariables` (no-overwrite), `replaceVariables`, `updateVariablesWith`; `Mvu.*`                        | ✅      | State of truth = `floor.variables.stat_data`. Writes → RFC-6902 JSON-Patch (`applyVariableOps`). Scopes: `stat_data` default (MVU; in-prompt), `type:'script'` (per-card KV), `type:'chat'` (per-chat card KV).                                                                                                                |
| **Prompt injection**   | `injectPrompts`, `uninjectPrompts`                                                                                                                     | 🟡      | Safe **no-op** (returns `{ uninject }`). Prompt is built in main; renderer-side injection can't reach it yet — cards calling these per-turn no longer throw.                                                                                                                               |
| **Chat read**          | `getChatMessages`, `getCurrentMessageId`, `getLastMessageId` (alias of `getCurrentMessageId`)                                                          | ✅      | `message_id` = compact chat-array index.                                                                                                                                                                                                                                                   |
| **Chat write**         | `setChatMessages`, `deleteChatMessages`, `saveChat`, `reloadCurrentChat`, `setInput`, `createChatMessages`                                             | ✅ / 🟡 | `createChatMessages` → composer-inject (onboarding); general mid-history insert ⬜ (floor-model decision).                                                                                                                                                                                 |
| **Worldbook**          | get / `createWorldbook` / `deleteWorldbook` / `replaceWorldbook` / `updateWorldbookWith` / `create`+`deleteWorldbookEntries` / `bindWorldbook` / names | ✅      | **Full library CRUD + bind** (trusted-card stance). Entries map TH `WorldbookEntry` (strategy/keys/extra) ↔ native via [`thRuntime/worldbookEntry`](../../src/shared/thRuntime/worldbookEntry.ts).                                                                                         |
| **Character / preset** | `getCharData`, `getCharAvatarPath`, `getPreset`, `getPresetNames`, `getCurrentCharacterName`, `SillyTavern.getCurrentChatId`, `getScriptId`            | ✅      | Read-only (sync).                                                                                                                                                                                                                                                                          |
| **Generation**         | `generate`, `generateRaw` (+ `STREAM_TOKEN_RECEIVED`)                                                                                                  | ✅      | Host-side; **the AI key never reaches the card**. `stopGenerationById` ⬜.                                                                                                                                                                                                                 |
| **Regex**              | `getTavernRegexes(option)`, `isCharacterTavernRegexesEnabled`, `formatAsTavernRegexedString`, `replaceTavernRegexes`, `updateTavernRegexesWith`        | ✅      | Read + **write** (full replace of a scope's bucket via `regexService`; debounced reload). Shapes map in [`thRuntime/tavernRegex`](../../src/shared/thRuntime/tavernRegex.ts).                                                                                                              |
| **Events**             | `eventOn/Once/Emit/MakeFirst/RemoveListener`; `tavern_events`; MVU `mag_variable_*`                                                                    | ✅ / 🟡 | ~10 lifecycle/mutation/stream events wired; the full ST enum is a subset. `MESSAGE_SENT` ⬜. **Payloads match the contract** (both transports): MVU events pass `(variables: MvuData, variables_before_update)` i.e. the wrapped `{ stat_data }`; `MESSAGE_UPDATED` passes the message id. **MVU `mag_variable_update_*` fire only on the model FOLD / external edits — NOT on a card's own programmatic write** (faithful to MIT MagVarUpdate; a card write refreshes the runtime cache so `getvar` sees it, but does not re-fire events — the WS-3 origin-tag fix that closed the write-back loop). |
| **STScript**           | `triggerSlash`                                                                                                                                         | 🟡      | Subset via [`shared/stscript`](../../src/shared/stscript.ts): pipes/closures/macros, chat+global vars, `/gen`·`/genraw`·`/trigger`·`/send`. `while`/loops + long-tail commands ⬜.                                                                                                         |
| **EJS**                | `EjsTemplate.*`                                                                                                                                        | ✅      | Backed by the quickjs engine (Layer C of ST-PT).                                                                                                                                                                                                                                           |
| **Macros**             | `substituteParams`, `substitudeMacros`, `{{get_X_variable}}`/`{{format_X_variable}}`                                                                   | ✅      | `registerMacroLike` ⬜ (cross-process).                                                                                                                                                                                                                                                    |
| **Audio**              | `audioPlay/Pause/Import/Mode/Enable`                                                                                                                   | 🔁      | Cards play audio natively (`<audio>`/WebAudio) under the card CSP — the real path.                                                                                                                                                                                                         |
| **World Assets**       | `assetUrl(name, type, mood?)` → `Promise<rptasset://… \| null>`                                                                                       | ✅      | Resolve an asset (mood-aware) from the active world's asset layer. **The category is inferred from `type`** (via [`categoryForType`](../../src/shared/worldAssets/types.ts): `头像`/`立绘` → `character`, `背景`/`全景` → `location`; any other value → `character`), so a card can reach location art (`背景`/`全景`), not just character portraits — the seam carries no category argument. Returns an `rptasset://` URL loadable in card pages. Prerequisite: the World Assets layer ([world-assets-plan.md](../world-assets-plan.md)). Both transports backed by [`Host.assetUrl`](../../src/shared/thRuntime/types.ts); each fills the category in via `categoryForType` (WCV: `worldAssetService.assetUrlForWorld`; inline: `cardBridge/host.ts`), so they stay at parity. |
| **Duel / deckbuilder**  | `getDuelPreview()` → `Promise<DuelPreview \| null>`                                                                                                    | ✅      | **Read-only host method** (RPT-only). Returns the engine-computed duel build (deck + combatants + resources/relics) for the active chat, produced by the card's combat ruleset. Generic contract: `DuelPreview` = `{ config, lead, party[] }`, each combatant with resources/modifiers/conditions + deck. See [`preview.ts`](../../src/shared/combat/deckbuilder/preview.ts). See design [2026-06-30-duel-build-preview-tab-design.md](../superpowers/specs/2026-06-30-duel-build-preview-tab-design.md) §2 and [duel-card-authoring.md](duel-card-authoring.md). **Consumer (live):** the fork 战斗 tab (`FrontEnd-for-destined-journey-TPR-STS`); `DuelPreview` is mirrored there in `src/status/core/types/duel-preview.d.ts` — two copies, one contract, keep in sync. |

#### Variable scopes

A card can read/write variables in three scopes. The default (stat_data) is selected with no option; named scopes use `getVariables({ type: '…' })` / `updateVariablesWith(updater, { type: '…' })`:

##### `stat_data` / default scope (in-prompt)

The **MVU state tree**, alive in prompts. Read by the AI, modified by the model's `<UpdateVariable>` tags
and the card's MVU methods. Persisted in `floor.variables.stat_data`. **In-prompt** (sent to the model).
**Validated** by the card's `data_schema`. Use this for story/character variables (HP, inventory, quest
state, relationships) — anything the AI knows about.

- Read: `getVariables()` (no option) → `{ stat_data }`.

##### `type:'script'` (per-card, all chats)

A card-owned **key/value store** (arbitrary JSON). Survives app restarts and chat swaps. **Per-card across
all its chats** — a script on character A uses the same `type:'script'` storage across all conversations
with A. **Not in-prompt** (the AI doesn't see it). Use this for a script's private settings, caches, or
UI state that must survive the session (e.g., "did the player see this tutorial?").

- Read: `getVariables({ type: 'script' })` → arbitrary JSON object (sync).
- Write (recommended): `updateVariablesWith(prev => ({ ...prev, 'feat.key': v }), { type: 'script' })`.
- Backed by `pluginStorageService` (`profiles/<profileId>/plugin-storage/card:<id>.json`), exposed via the `Host`.

##### `type:'chat'` (per-chat, general app state)

A per-**chat/session**, card-scoped **key/value store** (arbitrary JSON). Survives app restarts **for that
chat**. A **general scope** for any card's per-session UI/state — its first consumer is the 命定之诗 party
panel, but it's open for any card to store session-specific data.

- Read: `getVariables({ type: 'chat' })` → arbitrary JSON object.
- Write (recommended, no-clobber): `updateVariablesWith(prev => ({ ...prev, 'feat.key': v }), { type: 'chat' })`.
- Write (full replace): `replaceVariables(obj, { type: 'chat' })`.
- **Shared bag — namespace your keys** (e.g. `party.members`, `party.stripPos`) so multiple widgets in
  the same chat don't collide.
- **NOT MVU `stat_data`:** not AI-authored, not sent to the model, not validated/stripped by the card's
  `data_schema`. Use `type:'chat'` for UI/session state; use `stat_data` (the default scope —
  `getVariables()` with no option) for story state.
- Backed by `chatCardVarsService` (`profiles/<profileId>/chat-card-vars.json`), exposed via the `Host`
  (`getChatVars`/`setChatVars`) and both transports.

---

## 3. Layer B — Rendering environment (`cardEnv` + transports)

A card is rendered inside a `<head>` built **once** in [`cardEnv.ts`](../../src/shared/cardEnv.ts) so both
transports inject the same thing (clean-room mirror of JSR's `createSrcContent`/`adjust_viewport.js`):

- **Base CSS reset** (`BASE_RESET_CSS`): `box-sizing:border-box` + `html,body{margin:0;overflow:hidden;…}`
  (≈ Tailwind preflight) — without it `width:100%`+padding cards overflow.
- **`--TH-viewport-height`** bootstrap + `replaceVhInContent` (rewrites a card's `min-height:NNvh` onto the
  variable) for **fill** mode; **fit** mode (default) auto-sizes to content.
- **Assumed libs** the card env provides (cards are authored expecting these to be global):
  - From `cardEnv` (CDN, both transports): **FontAwesome**, **jQuery-UI (+touch-punch)**, **Tailwind** (v3),
    **Motion** (motion.dev, global `window.Motion` — `Motion.animate`/`scroll`/`inView`/…; UMD build via
    `MOTION_JS_URL` in [`cardEnv.ts`](../../src/shared/cardEnv.ts), injected by both
    [`cardBridge/cardLibs.ts`](../../src/renderer/src/cardBridge/cardLibs.ts) builders —
    `buildInlineLibTags`/`buildWcvLibTags`). App-provided for card use only — the native app does not
    depend on it; an RPT/JSR-env addition cards may opt into for animation.
  - From the transport: **jQuery**, **Vue**, **Pinia**, **VueRouter** (iframe-realm classic builds —
    [`cardBridge/cardLibs.ts`](../../src/renderer/src/cardBridge/cardLibs.ts) inline / `wcvPreload` WCV),
    plus **lodash** (`_`) and **Zod** (`z`, self-referential — `z.z === z` — for MVU `z.z.object(...)` schema bundles; see [`shared/cardZod`](../../src/shared/cardZod.ts)) from the bridge.

**Dual-mode routing** ([MessageContent.tsx](../../src/renderer/src/components/MessageContent.tsx)):

| Card shape                                                          | Renders as                                                                             | Why                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Bare top-level HTML (`<div>`/`<table>`/`<details>`…), no `<script>` | **Inline in the message DOM** (`InlineHtml`: DOMPurify-sanitized + per-card CSS scope) | Blends with prose; no frame.                              |
| Full document in an `html`-labeled code fence, a plain code fence beginning with `<!doctype html>`/`<html>`/`<body>`, or a bare `<body>`/`html` block; mode `inline` (default) | **Same-origin `srcdoc` iframe** (`InlineCardFrame`)                                    | Scrolls with chat, auto-sizes.                            |
| Scripted card, mode `isolated`, or full-page / `window.top` apps    | **Out-of-process `WebContentsView`** (`WcvMessageFrame`/`wcvManager`)                  | Crash isolation; full-page cards get a real `window.top`. |
| Passive full doc / non-scripted                                     | Sandboxed `HtmlFrame` (`sandbox="allow-same-origin"`, no scripts)                      | Static, safe.                                             |

Per-card override: a regex `_meta.renderMode` → a `<!--rpt:mode=inline|isolated|panel-->` marker parsed by
`splitHtml`. Global default: `settings.cards.renderMode` (`inline`). A third mode **`panel`** PROMOTES a
UI regex out of the message into a docked WCV **panel** (a selectable workspace view `regex-panel:<file>`,
rendered by `WcvPanel`):
- A loader regex (replacement does `$('body').load('https://…')`) is promoted as-is: the inline marker is stripped, the page URL is exposed via `regexService.listPanelRegexes`.
- An **inline-HTML regex** (bare `<div>`/`<table>`) is promoted by serving its content as a `data:text/html` URL (sanitized + CSS-scoped), allowing card-declared panels without remote URLs. Card import preserves the `renderMode:'panel'` declaration.

Card scripts themselves run app-wide in the invisible session-level **engine** (`CardScriptWcvHost`), not in a panel.

**World Assets on WCV cards**: the `rptasset://` scheme resolves assets from the active world's asset layer. It is registered on the `persist:wcv-cards` session, allowing card pages (both loader-regex and inline-HTML panels) to load mood-aware heads (`头像`) and standing images (`立绘`) — and location art (backgrounds `背景` / panoramas `全景`) — via `window.assetUrl` or direct URL references. `window.assetUrl(name, type, mood?)` infers the asset category from `type` (`头像`/`立绘` → `character`, `背景`/`全景` → `location`), so location lookups reach the `location` index. Prerequisite: [world-assets-plan.md](../world-assets-plan.md).

---

## 4. Layer C — Authoring format (the de-facto standard)

Verified against [`character.ts`](../../src/main/types/character.ts). A card = `chara_card_v3`:

**Standard ST fields** (`data.*`): `name, description, personality, scenario, first_mes, mes_example,
creator_notes, system_prompt, post_history_instructions, alternate_greetings, tags, creator,
character_version, character_book` (embedded lorebook). Unknown ST `extensions.*` keys are **preserved**
(catchall) — so a round-trip through us is lossless for ST tooling.

**`data.extensions.rp_terminal`** — the bundle namespace (`RPTerminalExtSchema`):

| Field                                | Purpose                                                                                                                              | Status                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `ui_layout` (`WidgetDef[]`)          | native status-panel widgets (`{id,type,path,config}`)                                                                                | ✅ schema; renderer 🟡         |
| `css`, `theme`, `assets`             | per-card styling + asset map                                                                                                         | ✅                             |
| `reasoning_template`                 | card-customizable `<think>` UI (`{{reasoning}}`/`{{title}}`/`{{tp}}`/`{{state}}`…)                                                   | ✅                             |
| `state_schema`                       | native `stat_data` defaults                                                                                                          | ✅                             |
| `data_schema`                        | MVU Zod schema **source (JS)**, run sandboxed                                                                                        | ✅                             |
| `scripts` (`[{name,code,enabled?}]`) | card scripts                                                                                                                         | ✅                             |
| `game_rules`                         | freeform rules bag                                                                                                                   | ✅                             |
| `left_panel`                         | `{ name: string }` — a card UI (matched by script `name`) auto-docked left in the workspace when active. Requires `renderMode:'panel'`. | ✅                             |
| `panel_ui`                           | static card-determined grid (slots → native view or `wcv` entry). `seamless:true` drops inter-slot gap/padding + per-slot chrome (border/radius/title) so adjacent WCV surfaces compose into one continuous stage; a slot's `chrome:bool` overrides the layout default. | ✅ schema                      |
| **World Card bundle slots**          | `world_card` (version marker), `meta`, `regex[]`, `presets[]`, `lorebooks[]`, `plugins[]`, `agent`, `combat`, `recommended_settings` | ✅ schema; routing 🟡 (see §5) |

`world_card` present ⇒ the card is a **World Card** (a complete, one-click-installable world). The schema
has a `catchall` so future slots round-trip.

---

## 5. Layer D — Transforming a SillyTavern card → RP Terminal

The mapping from an ST/TH card's pieces to ours. **Tier 1** transforms mechanically; **Tier 2** is
best-effort (arbitrary author JS reaching past the supported surface).

| ST / TH card element                                              | Lives in (ST)                                | RPT destination                                                                                                                                                                                  | Status                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Core character fields                                             | `data.*`                                     | `CardDataSchema` (`data.*`)                                                                                                                                                                      | ✅ direct                                                                                                                           |
| Embedded lorebook                                                 | `data.character_book`                        | lorebook library at `id == characterId` ([`LorebookSchema`](../../src/main/types/character.ts))                                                                                                  | ✅                                                                                                                                  |
| Standalone world info                                             | separate JSON                                | lorebook library (uuid id)                                                                                                                                                                       | ✅                                                                                                                                  |
| World-info **EJS** (`<% %>`, `getvar`)                            | entry `content`                              | `templateService` (build) + `renderTemplate` (display) + WCV preload — one engine, one `buildTemplateContext`; `getvar('x')` and `getvar('stat_data.x')` resolve identically in all three (WS-1) | ✅ A–E ([plan](../st-prompt-template-plan.md), [API §EJS](../rpt-api.md))                                                           |
| Injection **markers/decorators** (`[GENERATE]`, `@INJECT`, `@@…`) | entry `comment`/decorator                    | [`injectMarkers.ts`](../../src/main/parsers/injectMarkers.ts) + `promptBuilder`                                                                                                                  | ✅ build-time; `[RENDER:*]` partial                                                                                                 |
| `[InitialVariables]`                                              | entry                                        | `mvuSchema.parseInitVars` → floor-0 `stat_data`                                                                                                                                                  | ✅                                                                                                                                  |
| **Regex scripts** (beautification + state)                        | `extensions.regex_scripts`                   | regex store + `rp_terminal.regex`; per-card render mode; `renderMode:'panel'` promotes a UI regex to a docked workspace panel (via [`regexService.listPanelRegexes`](../../src/main/services/regexService.ts)) | ✅ engine ([`stRegexEngine`](../../src/main/parsers/stRegexEngine.ts), `regexTransform`); 🟡 bundled import routing (World Card S1) |
| **MVU** `<UpdateVariable>` / `stat_data`                          | model output + MVU bundle                    | **native** [`mvuParser`](../../src/main/parsers/mvuParser.ts) (`_.set` + JSON-Patch + `delta`/array-append); thin `Mvu` shim                                                                     | ✅ (no bundle loaded)                                                                                                               |
| MVU `data_schema` (Zod)                                           | bundle                                       | `rp_terminal.data_schema`, sandboxed                                                                                                                                                             | ✅                                                                                                                                  |
| **TavernHelper scripts** (JS)                                     | script lib / regex-injected                  | `rp_terminal.scripts` + the `thRuntime` surface at render                                                                                                                                        | 🟡 Tier-1 for the supported API; **Tier 2** for arbitrary DOM / ST internals                                                        |
| **Frontend cards** (HTML/Vue/React UI)                            | regex `$('body').load(...)` / `<body>` block / bare HTML | dual-mode frame (inline / WCV) + `cardEnv` libs; inline-HTML cards can declare `renderMode:'panel'` to become docked WCV panels (served as `data:text/html`) | ✅ for the supported env; full-page/`window.top` → Isolated; ✅ inline-HTML as panels |
| Chat-completion **preset**                                        | preset JSON                                  | [`stPresetParser`](../../src/main/parsers/stPresetParser.ts) → preset files + `rp_terminal.presets`                                                                                              | ✅ parser; 🟡 bundle import                                                                                                         |
| Quick replies / STScript                                          | QR sets                                      | `triggerSlash` subset (`shared/stscript`)                                                                                                                                                        | 🟡                                                                                                                                  |
| Avatar / assets                                                   | PNG image / embedded                         | `avatars/<id>.png` + `rp_terminal.assets`                                                                                                                                                        | ✅ avatar; 🟡 binary asset bundle (PNG cartridge ZIP, §6)                                                                           |
| Audio                                                             | TH audio API                                 | native `<audio>`/WebAudio                                                                                                                                                                        | 🔁 (API stubbed)                                                                                                                    |

Regex destination flags mirror ST exports: `markdownOnly` routes to display, `promptOnly` routes to
prompt, neither routes to both, and cards that set **both** flags are treated as both destinations. This
is enforced by `appliesToDisplay` / `appliesToPrompt`
([regexTypes.ts](../../src/shared/regexTypes.ts)) in `getRenderRules` / `getPromptRules`
([regexService.ts](../../src/main/services/regexService.ts)) and in the TavernHelper shape bridge
([tavernRegex.ts](../../src/shared/thRuntime/tavernRegex.ts)).
Replacement syntax is shared by display and prompt transforms: `$0`/`$&` expand to the full match and
`$1`/`$2`... expand capture groups (`regexTransform`).

**What does NOT transform cleanly (Tier 2 — set expectations honestly):** cards whose JS reaches past the
documented surface — full-page apps that read undocumented `window.top` internals, exotic/uncommon
`tavern_events`, timing/DOM-structure assumptions, or a second variable engine. These run _best-effort_;
the importer should **report** them, not silently drop or pretend-support them. (This is the tiered-
compatibility stance: support the dominant MVU+EJS+TH+Vue/Tailwind stack solidly; the long tail is
explicitly out-of-contract.)

**The importer today** ([`characterService.ts`](../../src/main/services/characterService.ts)): preserves
the full `extensions` object (lossless), detects `world_card`, collects bundled regex from
`extensions.regex_scripts`, and `buildWorldCardExport` writes the inverse. Remaining routing (presets/
plugins/scope) is tracked in [world-card-design.md](../world-card-design.md) §5/§9.

---

## 6. The PNG cartridge (your "store everything in a PNG" direction)

This is already specced as **World Card §8**. Concretely:

- **Read** — [`stPngParser.ts`](../../src/main/parsers/stPngParser.ts) parses PNG `tEXt`/`iTXt` chunks for
  the `chara`/`ccv3` keyword and base64-decodes the JSON. Because _scripts, regex, preset and per-card
  customizations are all text under `extensions.rp_terminal`_, a PNG whose embedded JSON is a World Card
  **already carries all of them**. ⚠️ Limitation: **compressed `iTXt` is unsupported** (the parser bails) —
  fix this to read more real-world cards.
- **Write/export** — `buildWorldCardExport` produces the `chara_card_v3` JSON (own lorebook →
  `character_book`, world regex → `extensions.regex_scripts`, `world_card` stamped). ⬜ A **PNG writer**
  (embed that JSON into a `tEXt`/`ccv3` chunk over an avatar image) is not yet built — this is the missing
  piece to make "export a PNG cartridge" real.
- **Binary / large assets** — text outgrows a base64 chunk, so the plan is an **appended ZIP after `IEND`**
  (`adm-zip` is already a dependency): manifest + `assets/` + bundled lorebooks/plugins/scripts. ⬜ planned
  (World Card S5).

**Recommendation:** formally adopt **`chara_card_v3` + `extensions.rp_terminal`** as the standard (no new
spec string → ST stays compatible), and treat the **PNG as the cartridge**: inline JSON for text
(scripts/regex/preset/customizations — exactly your list), appended ZIP for binary. The two build items
are the **PNG writer** and **compressed-`iTXt` read**; everything else (the schema, the bundle slots, the
reader) exists.

---

## 7. Heavy-card playbook (worked example: 命定之诗)

How a heavy card's pieces map, from [card-custom-ui-design.md](../card-custom-ui-design.md) §"boot chain":

- **Status UI** (React ESM, jsDelivr imports) → runs in a frame (WCV isolated / inline); reads `stat_data`
  via the runtime, refreshes live on a model turn. ✅ working.
- **home / custom_start** (Vue apps, env-check at boot) → **onboarding** (one-time): home → creation →
  inject starting prompt → first turn fills MVU vars. Full-page → Isolated/WCV. 🟡 (works in isolated).
- **MVU framework** (`MagVarUpdate`, MIT) → **not loaded**; we run the update pipeline natively
  (`mvuParser`) and serve the UIs' reads via the thin `Mvu` shim. Optionally vendor MVU's
  schema-defaults/`initvar` logic (MIT, reusable with attribution — see the clean-room constraint in
  [CLAUDE.md](../../CLAUDE.md)).
- **data_schema** (Zod) → `rp_terminal.data_schema`, sandboxed, fills `getMvuData().schema`.
- **Lorebook** (469 entries, 34 with build-time EJS) → lorebook library + `templateService`. ✅.

The lesson: a heavy card is _mostly_ declarative data + a known framework stack + a few frontends. That
part is Tier 1. The bespoke JS frontends are the work — supported through the dual-mode frame + the
runtime surface, full-page ones via WCV.

---

## 8. Layer F — Game-platform component targets (the "make it a game" SDK)

Mostly design-stage; these are the components that turn the chat tool into a game platform. Tracked, not
yet an SDK you'd hand a card author:

| Component                  | What                                                                                                                                                              | Status / source                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Static panel workspace     | card-declared `panel_ui` grid → native views + WCV slots                                                                                                          | 🟡 `StaticWorkspace` ([card-custom-ui-design.md](../card-custom-ui-design.md))                         |
| Native MVU view kit        | render StatusMenuBuilder-style declarative widgets (`StatBar/StatRow/Image/Checkbox/RichText/QuestList`) natively (no frame)                                      | ⬜ Option 1 (recommended)                                                                              |
| Variable write-back bridge | panel/script UI mutates `stat_data` (JSON-Patch → persisted)                                                                                                      | ✅ `applyVariableOps`                                                                                  |
| Reasoning UI               | card `reasoning_template` slots fold `<think>`                                                                                                                    | ✅ (`reasoning_template`; `ReasoningPanel`)                                                            |
| Combat engine              | native deterministic d20 grid engine (`shared/combat`); seeded, card-overridable                                                                                  | ✅ (Track Combat P1–P4)                                                                                |
| Combat view                | native `CombatView` (grid · initiative · action bar · log); Combat-mode layout                                                                                    | ✅ (P5)                                                                                                |
| Combat AI touchpoints      | `<rpt-combat-start>` cue, `<rpt-combat-result>` adjudication, narration, `ai` enemy ctrl                                                                          | ✅ (P6)                                                                                                |
| Combat bundle              | card-shipped `rp_terminal.combat` (abilities/bestiary/party/maps/scripts/skin; + `stat_map`/`derive` for MVU import) → `buildEncounter` / `buildEncounterFromMvu` | ✅ schema + builders (P7 + BP1–4); see [combat-system-design.md](../combat-system-design.md) §10 + §8a |
| Agent / FSM modes          | card-defined explore/dialogue/combat tuning + prompts                                                                                                             | 🟡 modes exist; card-defined `agent` slot ⬜                                                           |
| Plugin packages            | bundled `plugins[]` install via the permission/sandbox model                                                                                                      | ⬜ (World Card S3)                                                                                     |

---

## 8a. Combat SDK components (Track Combat)

The combat authoring surface a world targets, all under `extensions.rp_terminal.combat` (the
`CombatBundleSchema`, [character.ts](../../src/main/types/character.ts)) unless noted. The engine
(`src/shared/combat/*`) is native and deterministic; a card supplies **content + skin + optional
script overrides**, never the renderer. Design: [combat-system-design.md](../combat-system-design.md);
methods/tags: [rpt-api.md](../rpt-api.md) §4 (Combat).

### Authorable now (✅ built)

| Component                     | Where / shape                                                                                                                                             | Notes                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Ability catalog               | `combat.abilities[]` (`AbilityDef`)                                                                                                                       | `range`, `shape` (AoE), `toHit`, `save`, `damage`, `damageType`, `effects`, `cost`, `requiresLoS`             |
| Action economy                | `AbilityDef.cost` `'attack'` \| `'action'` (default: attack-roll → attack, else action)                                                                   | one move + one attack + one action per turn (`CombatState.turnUsed`)                                          |
| Line of sight                 | `AbilityDef.requiresLoS` + terrain `blocksLoS`                                                                                                            | true = blocked by walls (ranged); false = lobbed AoE arcs over them                                           |
| AoE shapes                    | `shape.kind` ∈ `self` / `burst{r}` / `aura{r}` / `line{len,width}` / `cone{len}`                                                                          | engine computes covered cells + auto-targets ([grid.ts](../../src/shared/combat/grid.ts) `templateCells`)     |
| Bestiary                      | `combat.bestiary[]` (`id`,`name`,`tier`,`block`,`abilities`,`controller`)                                                                                 | enemies the cue resolves against                                                                              |
| Party templates               | `combat.party[]`                                                                                                                                          | the player-side combatants instantiated at setup                                                              |
| Maps                          | `combat.maps[]` (`w`,`h`,`cell_ft`,`party_spawns`,`enemy_spawns`)                                                                                         | else a default open grid                                                                                      |
| Stat block                    | `block` (`hp`,`maxHp`,`ac`,`speed`,`mods`,`abilities`,`resist`,`vulnerable`)                                                                              | fresh + ephemeral; only consequences fold back to `stat_data`                                                 |
| Enemy controller              | `combat.enemy_controller` `weighted` \| `ai`; per-enemy `controller`                                                                                      | native weighted policy (free) or model-driven                                                                 |
| Resolver override (coarse)    | `combat.scripts.resolveAction` (sandboxed JS)                                                                                                             | `(input{state,action}, rng, emit, log) → {state?, events?}`; replaces native resolution for an action         |
| Combat-start cue              | model emits `<rpt-combat-start enemies="…" map="…">`; the **body may carry a JSON enemy roster** (channel A1)                                             | → Enter-Combat button → `buildEncounter` / `buildEncounterFromMvu({ roster })`                                |
| Encounter lifecycle           | per-chat + ephemeral; **cleared on re-roll/swipe** of the originating message; **Quit-combat** button → back to chat (AI-narrated); no-viable-party guard | combat mode shares the default layout (no swap, 2026-06-26)                                                   |
| Adjudication / mid-fight exit | model replies `<rpt-combat-result>{narration, ops[], end}</rpt-combat-result>`                                                                            | ops: `damage`/`heal`/`move`/`condition`; `end:true` concludes/escapes the fight → prose to chat + exit        |
| Combat prompts                | card `combat.narration_prompt` / `narration_mode` / `improvise_prompt`; user `settings.combat.*`                                                          | steer end-of-combat narration (+ append/new-floor placement) and the freeform-action box; card overrides user |
| Conditions (mechanical)       | `stunned`/`restrained` (immobilize), `prone` (attackers get advantage)                                                                                    | other ids are labels only — extended mechanics are script-authored (below)                                    |
| Ruleset id                    | `combat.ruleset` (`rpt-d20-v1`)                                                                                                                           | selects the native core                                                                                       |

### MVU-driven import + card combat systems (built — the 命定之诗 path)

A world whose stats already live in MVU `stat_data` (e.g. 命定之诗) can build the encounter **party
from those variables** instead of `combat.party` templates, and resolve the fight with its **own**
rules via a **combat system** plugged into the `resolveAction` seam. The card authors combat numbers
into the MVU fields its schema already preserves (`标签`/`效果`/`消耗`) — **no new field** — and the app
parses them. See [combat-poem-of-destiny-expansion.md](../combat-poem-of-destiny-expansion.md). Reference
bundle config: [examples/poem-combat-bundle.json](examples/poem-combat-bundle.json).

| Component        | Where / shape                                                                                                                                                               | Notes                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stat map         | `combat.stat_map` (`StatMap`, [bundle.ts](../../src/shared/combat/bundle.ts))                                                                                               | `player` key, `party{from,filter}` (e.g. `关系列表` where `在场:true`), `paths` (logical→character path). Structural keys are SDK English; values are the card's (`主角`/`属性`/`生命值`…).                                                                         |
| Derive tables    | `combat.derive` (`DeriveConfig`)                                                                                                                                            | pure DATA: `attributes`, `tier_coefficient`, `hp_multiplier`, `mp_sp_multiplier`, `rating_tiers`, `attr_mitigation`, `defense_constant`. No formulas/eval.                                                                                                          |
| Encounter import | `buildEncounterFromMvu(statData, stat_map, system, {derive})`                                                                                                               | walks `stat_map` → player + present companions → `system.buildCombatant` each → grid. Enemies are AI-generated at entry (deferred).                                                                                                                                 |
| Combat system    | `CombatSystem` = `parseItem` + `buildCombatant` + optional `resolveAction`; selected by id via `getSystem()` ([systems/index.ts](../../src/shared/combat/systems/index.ts)) | the card-side adapter. v1 built-in: **`poemD20`**.                                                                                                                                                                                                                  |
| ext bag          | `Combatant.ext` / `AbilityDef.ext` (opaque `Record<string,unknown>`)                                                                                                        | carries the system's parsed stats (五维, `CardCombat`); the native engine ignores it, the system resolver reads it.                                                                                                                                                 |
| Resolver context | `ResolverContext` = `{state, action, abilities, rng, derive}`                                                                                                               | the documented inputs a card resolver receives; `resolveAction` returns `{state?,events?}` or **`null`** (→ native for move/end/improvise/out-of-range). The service injects it as the engine's RunHook (built-in runs first, then sandboxed scripts, then native). |
| 命定之诗 system  | [systems/poemD20.ts](../../src/shared/combat/systems/poemD20.ts)                                                                                                            | parses `标签`/`效果`/`消耗`; resolves the card's `<战斗协议>` — 生命层级 d20 pool, `命中−闪避→评级`, `构成→装备减免/属性减免→×评级→DR`, `附加效果`. Intent/集群/战意/typed-damage **deferred**.                                                                     |

A card-SHIPPED (untrusted, sandboxed) resolver via `combat.scripts` is the **same `ResolverContext`
contract** — deferred hardening; v1 systems are trusted built-ins. Mode selection (Classic / Combat-
system Narrate / Deterministic) at combat entry and AI enemy `char_info`→combatant generation are the
remaining wiring (need the running app).

### Tactical depth = script-authored (deferred, by design)

Cover, opportunity attacks / reactions, flanking, and an extended **conditions library** are **not**
baked into the native engine. They're delivered by **combat scripts that ship with a world or are
installed by the player**, via the card-override hook seam (`combat.scripts`). Today that's the coarse
`resolveAction` hook; the granular hooks (`resolveAttack` / `applyDamage` / `onTurnStart` / `onTurnEnd`
/ `enemyPolicy` / `checkVictory` / `seedCombatant`) are reserved in `HookName` and not yet wired. The
native engine stays lean (grid · d20 · move/attack/action · LoS · base conditions). Deferred.

### Potential / planned (⬜ not built)

| Component                       | What it would add                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Granular resolver hooks         | wire the reserved `HookName`s so scripts can override single steps, not just whole actions                                                                               |
| `ai` enemy controller           | **deferred** — dormant scaffold (`aiChooser`/`buildEnemyPrompt`); needs its **own player/world prompt** (the third combat prompt) + per-round batching before production |
| Hex grid                        | `grid.type:"hex"` distance + neighbors (engine is square-only today)                                                                                                     |
| Keyboard controls               | arrow-key cursor / number-key abilities — **deferred**, mouse-only for now                                                                                               |
| Combat skin (renderer)          | `combat.skin` slot exists (token/tile art, ability icons, `--rpt-*` CSS) but `CombatView` doesn't consume it yet                                                         |
| Encounter / bundle authoring UI | a visual editor for abilities/bestiary/maps (pairs with the state-schema/widget editor, agentic D2)                                                                      |

---

## 9. How to extend this inventory

When you add or change a card-facing capability:

1. **Runtime API** → update [`thRuntime`](../../src/shared/thRuntime/index.ts) (both transports inherit it)
   and §2 here.
2. **Rendering env** → `cardEnv.ts` + §3.
3. **Format / bundle slot** → `RPTerminalExtSchema` ([character.ts](../../src/main/types/character.ts)) + §4,
   and the transform row in §5.
4. **Import/transform** → the parsers + `characterService` + §5/§6.

Keep the status markers honest (✅/🟡/🔁/⬜) and cite the file each row was verified against. This doc and
[rpt-api.md](../rpt-api.md) (the method-level reference) must move together with the code — see
[README.md](README.md).
