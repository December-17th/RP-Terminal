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
- `SillyTavern.chat[]` — ✅ built from floors (each message carries `swipes`/`swipe_id`); `saveChat()` + `reloadCurrentChat()` — ✅
- `getChatMessages()` (now returns `message_id` = chat-array index) / `getCurrentMessageId()` — ✅ (read)
- `setChatMessages([{message_id, message}])` — ✅ edit content by index (→ floor+role, then re-fold + reload). `deleteChatMessages(ids)` — ✅ truncates from the earliest targeted message's floor (the floor model couples user+assistant, so arbitrary mid-chat single-message deletes aren't supported).
- `createChatMessages` — 🟡 routes to the composer-inject for onboarding; general insert-a-message deferred (ambiguous in the floor model). Per-message swipe/var edits — ⬜.

### Worldbook / lorebook — 🟡
- `getCharWorldbookNames('current')` → `{ primary, additional }` — ✅ (sync) · `getWorldbook(name)` → entries — ✅
- `updateWorldbookWith(name, fn)` / `replaceWorldbook(name, entries)` — 🟡 **toggle only** today (the WCV write-back applies `enabled` by uid). ⬜ full CRUD (add/remove/edit) — extend `wcv-host-replace-worldbook` to a full replace (the iframe path's `scriptApiService.setWorldbookEntries` already does this; reuse it).
- `createWorldbook` / bind-unbind to char/chat — ⬜
- Backing: [`scriptApiService`](../src/main/services/scriptApiService.ts) (`getWorldbook`/`setWorldbookEntries`) + `lorebookService`. The card's own book is at `id == characterId`.

### Character / preset — ✅ (read)
- `getCharData()` / `getCharAvatarPath()` — ✅ (sync, ctx-scoped) · `getPreset()` (active preset name + sampler params) / `getPresetNames()` — ✅ (sync) · `SillyTavern.getContext()` — ✅

### Generation — ✅ (request)
- `generate(text)` — ✅ runs a normal visible turn (host-side via `generationService.generate`, then a
  host reload refreshes the chat + sibling WCVs); resolves with the response text. `generateRaw(config)`
  — ✅ a one-off completion → text (`user_input`/`system_prompt`/`max_chat_history`/`overrides`,
  mapped to `RawGenConfig`). **The AI key never reaches the card** (generation is fully host-side).
  ✅ live `STREAM_TOKEN_RECEIVED` events fire to the card as tokens stream (the accumulated text).
- `triggerSlash` / `execute` (STScript) — 🔁 stub.

### Regex — 🟡
- `getTavernRegexes()` (list active display regex) / `formatAsTavernRegexedString(text)` (apply them to a
  string) — ✅ (sync, scoped to the card's world+session, via `scriptApiService`). `replaceTavernRegexes`
  (write) — 🔁 stub (runtime regex rewrites are risky — can break the card's own beautification — and rare).

### Events — ✅
- `eventOn`/`eventOnce`/`eventEmit`/`eventMakeFirst`/`eventRemoveListener` + `SillyTavern.eventSource.on/emit` — ✅ (a local bus). The `tavern_events` enum is provided (`window.tavern_events` + `getContext().eventTypes`/`event_types`).
- Lifecycle + mutation events — ✅ `GENERATION_STARTED/ENDED`, `CHAT_CHANGED`, `MESSAGE_RECEIVED/UPDATED/DELETED/SWIPED` are broadcast to WCVs, computed from the chat-store transition (reusing the iframe-script event functions — no generation-pipeline change). MVU `mag_variable_*` events fire on a host vars push. `STREAM_TOKEN_RECEIVED` ✅ (during `generate`); ⬜ `MESSAGE_SENT`.

### UI / misc — ✅ / 🔁
- `toastr.*` — ✅ · `substituteParams`/`substitudeMacros` — 🟡 (pass-through) · `getTavernHelperVersion()` — ✅ (reports ≥ the card's required minimum) · `waitGlobalInitialized()` — ✅ (resolves true)
- Audio (background music / SFX) — 🔁 stubs (`audioPlay`/`audioPause`/`audioImport`/`audioMode`/`audioEnable`, no-op + logged). Cards play audio directly under the CSP (native `<audio>`/WebAudio) — the real path.

---

## 5. Host bridge IPC (for maintainers)

Card → host channels (resolved against the calling view's ctx), in
[`wcvIpc`](../src/main/ipc/wcvIpc.ts): `wcv-host-get-vars(-sync)`, `wcv-host-apply-vars`,
`wcv-host-set-vars`, `wcv-host-get-messages-sync`, `wcv-host-set-input`,
`wcv-host-get-worldbook-names-sync` / `-get-worldbook` / `-replace-worldbook`,
`wcv-host-get-chat-sync` / `-save-chat` / `-reload-chat`, `wcv-host-get-char-data` / `-get-char-avatar` /
`-get-preset` / `-get-preset-names` / `-get-regexes` / `-format-regex`. Host → card: `wcv-vars-changed` (mirror
refresh). To add an API: add the shim method (sync getter → `sendSync`; heavy → `invoke`) + the
ctx-scoped IPC handler, and update this doc.

---

## 6. Near-term gaps (Track C0)

**Done — the TavernHelper JS API is substantially complete:** variables/MVU, lorebook CRUD, char/preset
reads, regex read+format, chat read+write (`setChatMessages`/`deleteChatMessages`), `generate`/
`generateRaw`, `tavern_events` lifecycle+mutation, `STREAM_TOKEN_RECEIVED`. **Leftovers:**

- ⬜ `createChatMessages` general insert (needs a floor-model design decision); per-message swipe/var edits.
- ⬜ `MESSAGE_SENT` event (the user message is bundled into the floor — no separate transition).
- 🔁 `replaceTavernRegexes` (regex write) + the **audio** API — graceful stubs (low-value / risky; the regex
  reads + native `<audio>`/WebAudio cover the real cases).

> The other Track C0 half — the **ST-Prompt-Template template engine** long-tail (`getwi`/`getchar`/
> `getpreset`/`define`/render-time eval/`[GENERATE]`+`@INJECT` markers/`faker`) — extends `templateService`,
> a separate subsystem, **not yet started**.
