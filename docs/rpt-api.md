# RP Terminal — Card & Script API Reference

The API a **card component** (status / home / creation UI) or an **in-message frontend card** can call.
This is a living document — keep it in sync with `shared/thRuntime` + the transports + IPC as the surface
grows. The higher-level catalog (with the ST→RPT transformation mapping) is
[docs/sdk/component-inventory.md](sdk/component-inventory.md); this file is the method-level reference.

Status legend: ✅ wired · 🟡 partial · ⬜ not yet · 🔁 stub (logs, returns a safe default)

---

## 1. Execution model (dual-mode, 2026-06-23)

> Supersedes the 2026-06-22 "WCV for all card UI; iframes are app-only" decision.

Scripted cards render in one of **two transports**, chosen by
`resolveCardMode(per-card override ?? global default)` (`settings.cards.renderMode`, default `inline`):

- **Inline (default)** — a same-origin `srcdoc` iframe
  ([`InlineCardFrame`](../src/renderer/src/components/InlineCardFrame.tsx)) whose `<head>` bootstrap calls
  `window.parent.__rptCardBridge(ctx)` for the API globals, then loads the DOM libs. Scrolls with the chat,
  auto-sizes to content. API from [`cardBridge`](../src/renderer/src/cardBridge/) (Zustand reads +
  `window.api`).
- **Isolated (opt-in)** — an out-of-process `WebContentsView`
  ([`WcvMessageFrame`](../src/renderer/src/components/WcvMessageFrame.tsx) /
  [`WcvPanel`](../src/renderer/src/components/workspace/WcvPanel.tsx); host process
  [`wcvManager`](../src/main/services/wcvManager.ts); in-page [`wcvPreload`](../src/preload/wcvPreload.ts)).
  A broken card can't freeze the app (separate process); full-page / `window.top` cards need this mode.

Both transports are built from **one clean-room surface**,
[`createThRuntime(host)`](../src/shared/thRuntime/index.ts), over a `Host` seam — so a card behaves
**identically** in either (parity by construction; see
[th-parity-status.md](superpowers/specs/2026-06-23-th-parity-status.md)). The runtime defines the
**TavernHelper / SillyTavern / Mvu / EjsTemplate** globals (clean-room — see
[compat-comparison.md](compat-comparison.md)); heavy reads/writes are backed by host IPC into the existing
services ([`scriptApiService`](../src/main/services/scriptApiService.ts),
[`lorebookService`](../src/main/services/lorebookService.ts), `chatWriteService`, `generationService`).
Bare top-level **non-scripted** HTML (a `<div>`/`<table>` item card) renders **inline in the message DOM**
(DOMPurify-sanitized, CSS-scoped), not in a frame — see [card-custom-ui-design.md](card-custom-ui-design.md).

### Sync vs async (important)

TavernHelper **name/getter** methods are called **synchronously** by cards (no `await`) — the runtime must
return inline (WCV: `ipcRenderer.sendSync`; inline: a Zustand `getState()` read), never a Promise, or
`.primary`/etc. read as `undefined`. Heavy reads/writes (`getWorldbook`, `updateWorldbookWith`, `saveChat`,
`generate`) are async (the card awaits).

---

## 2. Scoping — global access, own session/world only

A card/component gets **global access to the API**, but every call is **scoped to its own session +
world**. It cannot read or modify another session or world, and never receives the AI API key.

Enforcement: each card carries a context `{ profileId, chatId, characterId }` (`CardCtx`). The WCV
transport resolves targets from the calling view's ctx (`wcvManager.contextFor(sender.id)`); the inline
transport's Host closes over the same ctx ([`cardBridge/host.ts`](../src/renderer/src/cardBridge/host.ts),
resolving `characterId` from the chat row when `activeCharacter` is stale). A card can only ever reach its
own session's floors, variables, and worldbooks. Generation is host-side (the card _requests_ it; the key
stays in main, masked from the renderer).

---

## 3. Globals the runtime provides

One surface, two transports — the table is identical inline vs WCV (parity by construction). Only the
low-level bridge name and how the DOM libs are injected differ per transport.

| Global | Purpose | Source |
| --- | --- | --- |
| `window.SillyTavern` | `getContext()`, `chat[]` (+ swipes), `saveChat()`, `reloadCurrentChat()`, `substituteParams()` | thRuntime |
| `window.TavernHelper` (+ bare helpers) | the TH JS API (variables, messages, worldbook CRUD, events, generate, `triggerSlash`, …) | thRuntime |
| `window.Mvu` | MagVarUpdate API (`getMvuData`/`getMvuVariable`/`setMvuVariable`/`replaceMvuData`/`parseMessage`/`events`) | thRuntime |
| `window.EjsTemplate` | the EJS engine API (`evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`/…) | thRuntime |
| `window.toastr`, `window.tavern_events` | toast bus; the events enum | thRuntime |
| `window._` `window.z` `window.$` | lodash, Zod, jQuery (the libs cards externalize) | bridge / libs |
| `window.Vue` `window.VueRouter` `window.Pinia` | provided for Vue-app cards | libs (iframe realm / preload) |
| low-level host bridge | inline: `window.parent.__rptCardBridge`; WCV: `window.rptHost` (`getVariables`/`applyVariableOps`/`setVariables`/`setInput`/`onVarsChanged`) | transport |

> Plugins (app extensions, not card UIs) use the separate `rpt.v1` postMessage API — see
> [docs/plugin-api.md](plugin-api.md). The two share the same main-side backing.

---

## 4. API surface by category

### Variables / MVU state — ✅

State of truth is `floor.variables.stat_data` (the MVU tree). Reads come from a **synchronous mirror** (the
inline transport reads the chat store; WCV hydrates via `sendSync` + a `wcv-vars-changed` push); writes go
through the host bridge as RFC-6902 JSON Patch.

- `getVariables()` → `{ stat_data }` · `Mvu.getMvuData()` / `getMvuVariable(path)` — ✅ (sync)
- `Mvu.setMvuVariable(path, value)` · `insertOrAssignVariables(vars)` · `updateVariablesWith(fn)` — ✅ (→ `applyVariableOps` JSONPatch → persisted)
- `Mvu.replaceMvuData(d)` / `replaceVariables(vars)` — ✅
- **Script scope** — `getVariables({type:'script'})` / `updateVariablesWith(fn, {type:'script'})` — ✅ (sync read) a card-owned KV store (`plugin-storage`, owner `card:<id>`), **separate from `stat_data`** so a script's private cache never pollutes the character variables.
- The host folds the model's `<UpdateVariable>` (`_.set` + `<JSONPatch>` incl. `delta`/array-append) natively (`mvuParser`); the runtime does NOT load the full MVU bundle.

### Chat / messages — 🟡

- `SillyTavern.chat[]` — ✅ built from floors (each message carries `swipes`/`swipe_id`); `saveChat()` + `reloadCurrentChat()` — ✅
- `getChatMessages()` (returns `message_id` = compact chat-array index) / `getCurrentMessageId()` — ✅ (read)
- `setChatMessages([{message_id, message}])` — ✅ edit content by index (→ floor+role, re-fold + reload). `deleteChatMessages(ids)` — ✅ truncates from the earliest targeted message's floor (the floor model couples user+assistant, so arbitrary mid-chat single-message deletes aren't supported). Both via the shared `chatWriteService`.
- `createChatMessages` — 🟡 routes to the composer-inject for onboarding; general insert-a-message deferred (ambiguous in the floor model). `createChat` — 🟡 (inline stub; WCV partial). Per-message swipe/var edits — ⬜.

### Worldbook / lorebook — ✅

- `getCharWorldbookNames('current')` → `{ primary, additional }` — ✅ (sync) · `getWorldbook(name)` → entries — ✅
- `updateWorldbookWith(name, fn)` / `replaceWorldbook(name, entries)` — ✅ **full replace** (add/remove/edit via read-modify-write).
- `createWorldbookEntries(name, entries)` → `{ worldbook, new_entries }` · `deleteWorldbookEntries(name, predicate)` → `{ worldbook, deleted_entries }` — ✅ (the workshop's install/uninstall path; predicate filters on `extra`).
- `createWorldbook` / `deleteWorldbook` / `bindWorldbook` (bind-unbind to chat) + `getWorldbookNames`/`getLorebooks` — ✅ **library-wide CRUD + bind** (trusted-card stance). id↔name is resolved in the runtime (`wbIdByName`).
- **Entry shape:** entries cross the card boundary in the TavernHelper `WorldbookEntry` shape (`strategy.{type,keys,keys_secondary}` / `position` / `recursion` / `extra`) and are mapped to/from our native `LorebookEntry` (`keys`/`constant`/`selective`/…) by the shared [`thRuntime/worldbookEntry`](../src/shared/thRuntime/worldbookEntry.ts) on EVERY read+write path, so `strategy.type:'constant'`↔`constant`, `strategy.keys`↔`keys`, and `extra` (card tags like `cw_project_id`) round-trip. (`LorebookEntrySchema` gained an optional `extra`.)
- Backing: file-based [`lorebookService`](../src/main/services/lorebookService.ts) (+ `scriptApiService`). The card's own book is at `id == characterId`.

### Character / preset — ✅ (read)

- `getCharData()` / `getCharAvatarPath()` — ✅ (sync, ctx-scoped) · `getPreset()` (active preset name + sampler params) / `getPresetNames()` — ✅ (sync) · `SillyTavern.getContext()` — ✅
- `getCurrentCharacterName()` (from `charData().name`) · `SillyTavern.getCurrentChatId()` (the WCV ctx is empty — resolved from `e.sender` via `-get-chat-id-sync`) · `getScriptId()` (stable per-runtime id) — ✅ (sync)

### Generation — ✅ (request)

- `generate(text)` — ✅ runs a normal visible turn (host-side via `generationService.generate`); resolves
  with the response text, and a card-triggered turn is folded into the chat. `generateRaw(config)` — ✅ a
  one-off completion → text (snake_case `user_input`/`system_prompt`/`max_chat_history`/`overrides`
  normalized to `RawGenConfig`). **The AI key never reaches the card.** ✅ live `STREAM_TOKEN_RECEIVED`
  events fire as tokens stream. `stopGenerationById`/`stopAllGeneration` — ⬜.
- `triggerSlash` (STScript) — ✅ a subset (pipes/closures/`{{pipe}}`/macros, chat + global vars,
  `/gen`·`/genraw`·`/trigger`·`/send`) via the shared [`stscript`](../src/shared/stscript.ts) interpreter.
  `while`/loops + the long-tail command set — ⬜.

### Regex — ✅

- `getTavernRegexes(option)` → full `TavernRegex[]` for a scope (`{type:'character'}` = the card's world
  bucket, `'global'`, `'preset'`) / `formatAsTavernRegexedString(text)` (apply active display regex to a
  string) / `isCharacterTavernRegexesEnabled()` — ✅ (sync). Shapes map via
  [`shared/thRuntime/tavernRegex`](../src/shared/thRuntime/tavernRegex.ts).
- `replaceTavernRegexes(regexes, option)` / `updateTavernRegexesWith(fn, option)` — ✅ **write** (full replace
  of the scope's bucket), backed by the existing `regexService` CRUD; the chat re-render is **debounced** so a
  card can't thrash it. (WCV transport; the inline transport is a documented no-op — see `cardBridge/host.ts`.)

### Events — ✅

- `eventOn`/`eventOnce`/`eventEmit`/`eventMakeFirst`/`eventRemoveListener` + `SillyTavern.eventSource.on/emit` — ✅ (a local bus). The `tavern_events` enum is provided (`window.tavern_events` + `getContext().eventTypes`/`event_types`).
- Lifecycle + mutation events — ✅ `GENERATION_STARTED/ENDED`, `CHAT_CHANGED`, `MESSAGE_RECEIVED/UPDATED/DELETED/SWIPED` are dispatched to BOTH transports (inline via the `cardHostEvents` renderer bus; WCV via `wcv-event`), computed from the chat-store transition. MVU `mag_variable_*` events fire on a vars push. `STREAM_TOKEN_RECEIVED` ✅. `MESSAGE_SENT` ⬜ (the user message is bundled into the floor — no separate transition); the full `tavern_events` enum is a ~10-event subset.

### EJS / macros — ✅

- `EjsTemplate.*` (`evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`) — ✅ (the clean-room ST-Prompt-Template engine; see [st-prompt-template-plan.md](st-prompt-template-plan.md)).
- `substituteParams`/`substitudeMacros` (expand `{{macros}}`) — ✅ · `{{get_X_variable}}`/`{{format_X_variable}}` (X ∈ global/chat/message/preset/character) — ✅ · `registerMacroLike` — ⬜ (cross-process).

### UI / misc — ✅ / 🔁

- `toastr.*` — ✅ · `getTavernHelperVersion()` — ✅ (reports ≥ the card's required minimum) · `waitGlobalInitialized()` — ✅ (resolves true) · `errorCatched(fn)` — ✅
- Audio (background music / SFX) — 🔁 stubs (`audioPlay`/`audioPause`/`audioImport`/`audioMode`/`audioEnable`, no-op + logged). Cards play audio directly under the CSP (native `<audio>`/WebAudio) — the real path.

### Combat — ✅ (Track Combat)

A native, deterministic grid combat engine (`src/shared/combat`) the AI drives via tags; the player plays
it in the Combat-mode `CombatView`. The engine owns every number (seeded); the AI only narrates + referees.

- **Initiate** — the model emits `<rpt-combat-start enemies="哥布林 x3 (弱); 头目" map="forest"></rpt-combat-start>`;
  the chat shows an **Enter Combat** button that builds the encounter from the world's `combat` bundle
  (`buildEncounter`) and switches to Combat mode. The tag is hidden in prose; the cue is stashed on the floor.
- **Adjudicate** (Improvise) — for an action the engine can't model, the player's prose → an adjudication
  prompt; the model replies with
  `<rpt-combat-result>{ "narration": "…", "ops": [ {"op":"damage|heal|move|condition", …} ] }</rpt-combat-result>`,
  folded into the fight.
- **Enemy AI** — an enemy with `controller:"ai"` is asked for
  `<rpt-action>{ "kind":"ability|move|end", … }</rpt-action>` each turn (weighted-policy fallback); otherwise
  the native weighted policy decides with no AI call.
- **Narrate / fold-out** — at the end, the log → a narration prompt; lasting consequences are recorded via
  the world's `<UpdateVariable>` into `stat_data` (combat never writes `stat_data` directly).
- **Bundle** — `extensions.rp_terminal.combat`: `ruleset`, `grid`, `enemy_controller`, `abilities[]`,
  `bestiary[]`, `party[]`, `maps[]`, `scripts{hook→code}` (sandboxed overrides), `skin`. See
  [combat-system-design.md](combat-system-design.md) §10.

---

## 5. Host bridge IPC (for maintainers)

These are the **WCV transport's** channels; the **inline transport** reaches the same services directly via
`window.api` + Zustand store reads ([`cardBridge/host.ts`](../src/renderer/src/cardBridge/host.ts)). When
you add an API, implement BOTH transports — or back both with **one shared service** (as `chatWriteService`
/ the worldbook CRUD do) and have each transport delegate, which is the anti-drift pattern.

Card → host channels (resolved against the calling view's ctx), in
[`wcvIpc`](../src/main/ipc/wcvIpc.ts): `wcv-host-get-vars(-sync)`, `wcv-host-apply-vars`,
`wcv-host-set-vars`, `wcv-host-get-floors-sync`, `wcv-host-set-input`, the worldbook channels
(`-get-worldbook-names-sync` / `-get-worldbook` / `-replace-worldbook` / create / delete / bind),
`-save-chat` / `-reload-chat`, `wcv-host-get-char-data` / `-get-char-avatar` / `-get-preset` /
`-get-preset-names` / `-get-regexes` / `-format-regex` / `-get-persona-name`, the regex-full + write channels
(`-get-regexes-full` / `-replace-regexes` / `-is-char-regex-enabled`), `-get-chat-id-sync`, the script-scope
KV channels (`-script-vars-get-sync` / `-script-vars-set`), and the chat-write channels
(`chat-set-messages` / `-delete-messages` / `-save`). Host → card: `wcv-vars-changed` (mirror refresh) +
`wcv-event` (lifecycle/mutation/stream). To add an API: add the runtime method
([`thRuntime/index.ts`](../src/shared/thRuntime/index.ts)) + a `Host` method on **both** adapters (sync
getter → `sendSync` / store read; heavy → `invoke` / `window.api`) + the ctx-scoped IPC handler, and update
this doc + [docs/sdk/](sdk/component-inventory.md).

---

## 6. Near-term gaps

**Done — the TavernHelper JS API is substantially complete:** variables/MVU (+ script scope), lorebook
**CRUD/bind**, char/preset reads, regex **read+format+write** (`getTavernRegexes`/`updateTavernRegexesWith`/
`replaceTavernRegexes`), chat read+write (`setChatMessages`/`deleteChatMessages`), `generate`/`generateRaw` +
`STREAM_TOKEN_RECEIVED`, `tavern_events` lifecycle+mutation, **`triggerSlash`** (STScript subset),
`EjsTemplate.*`, and the `{{get_X_variable}}`/`{{format_X_variable}}` macros. **Leftovers:**

- ⬜ `createChatMessages` general insert (needs a floor-model design decision); real `createChat`
  (auto-switch UX); per-message swipe/var edits.
- ⬜ `MESSAGE_SENT` event; the full `tavern_events` enum (we wire ~10); `stopGenerationById`.
- 🔁 `registerMacroLike` + the **audio** API — graceful stubs (low-value / risky; native `<audio>`/WebAudio
  covers the real audio cases).

> The **ST-Prompt-Template template engine** (`getwi`/`getchar`/`getpreset`/`define`/`faker`/render-time
> eval / `[GENERATE]`+`@INJECT` markers / `[InitialVariables]` / `[RENDER:*]`) is a separate subsystem
> (`templateService` + `renderTemplate`) and is **complete (Phases A–E)** — see
> [st-prompt-template-plan.md](st-prompt-template-plan.md).
