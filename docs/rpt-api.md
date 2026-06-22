# RP Terminal — Card & Script API Reference

The API a **card component** (status / home / creation UI) or an **in-message frontend card** can call.
This is a living document — keep it in sync with the shim + IPC as the surface grows.

Status legend: ✅ wired · 🟡 partial · ⬜ not yet · 🔁 stub (logs, returns a safe default)

---

## 1. Execution model (the 2026-06-22 decision)

- **All card-facing rendering/UI runs in an out-of-process `WebContentsView` (WCV).** A broken card
  component can't freeze the app (separate process). The iframe card-script sandbox is **retired for card
  rendering**; iframes are reserved for trusted **app-owned** UI.
- A card UI is loaded by the card's own regex (`$('body').load('https://…/index.html')`) inside a chat
  message, or as a static workspace panel. The renderer component is
  [`WcvMessageFrame`](../src/renderer/src/components/WcvMessageFrame.tsx) /
  [`WcvPanel`](../src/renderer/src/components/workspace/WcvPanel.tsx); the host process is
  [`wcvManager`](../src/main/services/wcvManager.ts); the in-page API is the
  [`wcvPreload`](../src/preload/wcvPreload.ts) shim.
- The shim defines the **TavernHelper / SillyTavern / MVU** globals the card expects (clean-room — see
  [docs/compat-comparison.md](compat-comparison.md)). Heavy reads/writes are backed by host IPC into the
  existing services ([`scriptApiService`](../src/main/services/scriptApiService.ts),
  [`lorebookService`](../src/main/services/lorebookService.ts), `floorService`, `generationService`).

### Sync vs async (important)
TavernHelper **name/getter** methods are called **synchronously** by cards (no `await`) — the shim must
return inline (`ipcRenderer.sendSync`), never a Promise, or `.primary`/etc. read as `undefined`. Heavy
reads/writes (`getWorldbook`, `updateWorldbookWith`, `saveChat`, `generate`) are async (the card awaits).

---

## 2. Scoping — global access, own session/world only

A card/component gets **global access to the API**, but every call is **scoped to its own session +
world**. It cannot read or modify another session or world, and never receives the AI API key.

Enforcement: each WCV carries a context `{ profileId, chatId, characterId }` (set when the view is
created). The host IPC handlers resolve targets **from that context** (`wcvManager.contextFor(sender.id)`)
— a card can only ever reach its own session's floors, variables, and its own card's lorebook. Generation
is host-side (the card *requests* it; the key stays in main, masked from the renderer).

---

## 3. Globals the shim provides

| Global | Purpose | Source |
|---|---|---|
| `window.SillyTavern` | `getContext()`, `chat[]` (+ swipes), `saveChat()`, `reloadCurrentChat()`, `substituteParams()` | wcvPreload |
| `window.TavernHelper` | the TH JS API (variables, messages, worldbook, events, …) | wcvPreload |
| `window.Mvu` | MagVarUpdate API (`getMvuData`/`getMvuVariable`/`setMvuVariable`/`replaceMvuData`/`parseMessage`/`events`) | wcvPreload |
| `window.rptHost` | low-level host bridge (`getVariables`/`applyVariableOps`/`setVariables`/`setInput`/`onVarsChanged`) | wcvPreload |
| `window._` `window.z` `window.$` `window.toastr` | lodash, Zod, jQuery, toastr (the libs cards externalize) | wcvPreload |
| `window.Vue` `window.VueRouter` `window.Pinia` | lazily provided for Vue-app cards | wcvPreload |

> Plugins (app extensions, not card UIs) use the separate `rpt.v1` postMessage API — see
> [docs/plugin-api.md](plugin-api.md). The two share the same main-side backing.

---

## 4. API surface by category

### Variables / MVU state — ✅
State of truth is `floor.variables.stat_data` (the MVU tree). Reads come from a **synchronous mirror**
(hydrated via `sendSync`, kept fresh by a `wcv-vars-changed` push); writes go through the host bridge.

- `getVariables()` → `{ stat_data }` · `Mvu.getMvuData()` / `getMvuVariable(path)` — ✅ (sync)
- `Mvu.setMvuVariable(path, value)` · `insertOrAssignVariables(vars)` · `updateVariablesWith(fn)` — ✅ (→ `applyVariableOps` JSONPatch → persisted)
- `Mvu.replaceMvuData(d)` / `replaceVariables(vars)` — ✅ (→ `wcv-host-set-vars`)
- The host folds the model's `<UpdateVariable>` (`_.set` + `<JSONPatch>` incl. `delta`/array-append) natively (`mvuParser`); the shim does NOT load the full MVU bundle.

### Chat / messages — 🟡
- `SillyTavern.chat[]` — ✅ built from floors (each message carries `swipes`/`swipe_id`); `saveChat()` + `reloadCurrentChat()` — ✅ (greeting-swipe select → re-fold → reload)
- `getChatMessages(range)` / `getCurrentMessageId()` — ✅ (read)
- `setChatMessages` / `createChatMessages` (insert) / `deleteChatMessages` / per-message vars — 🟡 (`createChatMessages` routes to the composer-inject for onboarding; full write ⬜)

### Worldbook / lorebook — 🟡
- `getCharWorldbookNames('current')` → `{ primary, additional }` — ✅ (sync) · `getWorldbook(name)` → entries — ✅
- `updateWorldbookWith(name, fn)` / `replaceWorldbook(name, entries)` — 🟡 **toggle only** today (the WCV write-back applies `enabled` by uid). ⬜ full CRUD (add/remove/edit) — extend `wcv-host-replace-worldbook` to a full replace (the iframe path's `scriptApiService.setWorldbookEntries` already does this; reuse it).
- `createWorldbook` / bind-unbind to char/chat — ⬜
- Backing: [`scriptApiService`](../src/main/services/scriptApiService.ts) (`getWorldbook`/`setWorldbookEntries`) + `lorebookService`. The card's own book is at `id == characterId`.

### Character card — ✅ (read)
- `SillyTavern.getContext()`, `getCharData()` (via scriptApiService) — ✅ · avatar path — ✅

### Generation — 🔁 / ⬜
- `generate(text)` / `generateRaw(...)` — 🔁 stubs in the WCV shim today. Target: a card *requests*
  generation (host-side, keyed by the active preset); the AI key never reaches the card. (The iframe
  `rpt.generate` path is wired with a per-card grant; bring the equivalent to the WCV shim.)
- `triggerSlash` / `execute` (STScript) — 🔁 stub.

### Regex — ⬜ (in the WCV shim)
- `getTavernRegexes` / `replaceTavernRegexes` / `formatAsTavernRegexedString` — ⬜ in the WCV shim
  (backed by `scriptApiService.formatWithRegex`/`listRegexes` on the iframe path; wire into the shim).

### Events — ✅
- `eventOn`/`eventOnce`/`eventEmit`/`eventMakeFirst`/`eventRemoveListener` + `SillyTavern.eventSource.on/emit` — ✅ (a local bus). MVU lifecycle events (`mag_variable_update_started/updated/ended`, `mag_variable_initialized`) fire on a host vars-changed push.
- The full `tavern_events` enum (GENERATION_STARTED/ENDED, MESSAGE_*, CHAT_CHANGED, STREAM_TOKEN_RECEIVED) mapped to our pipeline — 🟡 (subset).

### UI / misc — ✅ / 🔁
- `toastr.*` — ✅ · `substituteParams`/`substitudeMacros` — 🟡 (pass-through) · `getTavernHelperVersion()` — ✅ (reports ≥ the card's required minimum) · `waitGlobalInitialized()` — ✅ (resolves true)
- Audio (background music / SFX) — ⬜ in the shim (cards currently load audio directly under the widened CSP).

---

## 5. Host bridge IPC (for maintainers)

Card → host channels (resolved against the calling view's ctx), in
[`wcvIpc`](../src/main/ipc/wcvIpc.ts): `wcv-host-get-vars(-sync)`, `wcv-host-apply-vars`,
`wcv-host-set-vars`, `wcv-host-get-messages-sync`, `wcv-host-set-input`,
`wcv-host-get-worldbook-names-sync` / `-get-worldbook` / `-replace-worldbook`,
`wcv-host-get-chat-sync` / `-save-chat` / `-reload-chat`. Host → card: `wcv-vars-changed` (mirror
refresh). To add an API: add the shim method (sync getter → `sendSync`; heavy → `invoke`) + the
ctx-scoped IPC handler, and update this doc.

---

## 6. Near-term gaps (Track C0)

Expose the FULL surface in the WCV shim, all ctx-scoped: lorebook **CRUD** (not just toggle), chat
**write**, **regex** API, **generate-request** (host-side, no key to the card). Each is backed by an
existing service — the work is wiring the shim method + a scoped IPC handler.
