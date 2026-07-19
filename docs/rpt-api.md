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
Full-document frontend cards render from `html`-labeled code fences, plain code fences whose payload starts
with `<!doctype html>`/`<html>`/`<body>`, or bare `<html>`/`<body>` blocks. Bare top-level **non-scripted**
HTML (a `<div>`/`<table>` item card anywhere; phrasing markup such as styled `<span>` / `<ruby>` only when
it stands alone on its own line, so mid-sentence spans and GFM lists stay markdown) renders **inline in the
message DOM** (DOMPurify-sanitized, CSS-scoped), not in a frame — see
[card-custom-ui-design.md](card-custom-ui-design.md).

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

| Global                                         | Purpose                                                                                                                                                                                                                                           | Source                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `window.SillyTavern`                           | `getContext()`, `chat[]` (+ swipes), `chatMetadata.variables` + `saveMetadata()`, `saveChat()`, `reloadCurrentChat()`, `substituteParams()`, `getContext().extensionSettings` (durable) + `saveSettingsDebounced()` (durable flush)               | thRuntime                     |
| `window.TavernHelper` (+ bare helpers)         | the TH JS API (variables, messages, worldbook CRUD, events, generate, `triggerSlash`, …)                                                                                                                                                          | thRuntime                     |
| `window.Mvu`                                   | MagVarUpdate API (`getMvuData`/`getMvuVariable`/`setMvuVariable`/`replaceMvuData`/`parseMessage`/`events`)                                                                                                                                        | thRuntime                     |
| `window.EjsTemplate`                           | the EJS engine API (`evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`/…)                                                                                                                                        | thRuntime                     |
| `window.toastr`, `window.tavern_events`        | toast bus; the events enum                                                                                                                                                                                                                        | thRuntime                     |
| `window._` `window.z` `window.$`               | lodash, Zod, jQuery (the libs cards externalize). `z` is **self-referential** (`z.z === z`) — MVU schema bundles call `z.z.object(...)` as well as `z.object(...)`; injected via [`shared/cardZod`](../src/shared/cardZod.ts) by both transports. | bridge / libs                 |
| `window.Vue` `window.VueRouter` `window.Pinia` | provided for Vue-app cards                                                                                                                                                                                                                        | libs (iframe realm / preload) |
| low-level host bridge                          | inline: `window.parent.__rptCardBridge`; WCV: `window.rptHost` (`getVariables`/`applyVariableOps`/`setVariables`/`setInput`/`onVarsChanged`)                                                                                                      | transport                     |

> Plugins (app extensions, not card UIs) use the separate `rpt.v1` postMessage API — see
> [docs/plugin-api.md](plugin-api.md). The two share the same main-side backing.

---

## 4. API surface by category

TavernHelper's `type:'character'` is an alias for RPT's per-character card KV (`type:'script'`).
`getVariables`, `insertOrAssignVariables`, `insertVariables`, `replaceVariables`,
`updateVariablesWith`, and `deleteVariable` honor both names, persist across chats, and never write to
message `stat_data`.

### Variables / MVU state — ✅

State of truth is `floor.variables.stat_data` (the MVU tree). Reads come from a **synchronous mirror** (the
inline transport reads the chat store; WCV hydrates via `sendSync` + a `wcv-vars-changed` push); writes go
through the host bridge as RFC-6902 JSON Patch.

- `getVariables()` → `{ stat_data }` (no option = default stat_data scope) · `Mvu.getMvuData()` / `getMvuVariable(path)` — ✅ (sync)
- `Mvu.setMvuVariable(path, value)` · `insertOrAssignVariables(vars, option)` · `updateVariablesWith(fn)` — ✅ (→ selected scope; default `stat_data` uses `applyVariableOps` JSONPatch → persisted)
- `Mvu.replaceMvuData(d)` / `replaceVariables(vars)` — ✅
- `insertVariables(vars)` — ✅ insert-if-**absent** (never overwrites an existing key); the no-overwrite sibling of `insertOrAssignVariables`, used to seed initial MVU vars.
- `injectPrompts(prompts, {once})` / `uninjectPrompts(ids)` — 🟡 **safe no-op** (returns the `{ uninject }` handle). The prompt is assembled in the MAIN process, so a renderer-side injection doesn't reach the build yet; cards that call these per-turn degrade gracefully instead of throwing. Depth-positioned injection into the build is a future bridge. A separate main-side **pre-dispatch mutation seam** (issue 19 / ADR 0017 — the `CHAT_COMPLETION_PROMPT_READY` analogue) rewrites the FINAL message array at the 18e dispatch boundary; every real change is delta-recorded as an `opaque` execution-record entry (script id + hook + before/after hashes, never a raw swap). Wiring a live high-trust card's late-hook into it across the realm boundary is F2/F3-guarded (docs-silent event name + payload mutability). See `src/main/services/nodes/dispatchHooks.ts` + `promptArtifact.applyDispatchTransforms`.
- **Script scope** — `getVariables({type:'script'})` / `insertOrAssignVariables(obj, {type:'script'})` / `insertVariables(obj, {type:'script'})` / `updateVariablesWith(fn, {type:'script'})` — ✅ (sync read) a card-owned KV store (owner `card:<id>`), **per-card across all its chats**, not in-prompt. Backed by `pluginStorageService` (`profiles/<profileId>/plugin-storage/card:<id>.json`).
- **Chat scope** — `getVariables({type:'chat'})` / `insertOrAssignVariables(obj, {type:'chat'})` / `insertVariables(obj, {type:'chat'})` / `updateVariablesWith(fn, {type:'chat'})` / `replaceVariables(obj, {type:'chat'})` — ✅ (sync read) a per-chat, card-scoped KV store, **general scope for session UI/state** (e.g., adaptive-regex selections and the 命定之诗 party panel). Not in-prompt. **Namespace your keys** (e.g. `party.members`) to avoid collisions across multiple widgets in the same chat. **NOT `stat_data`** — use this for UI state, not story variables. Backed by `chatCardVarsService` (`profiles/<profileId>/chat-card-vars.json`), exposed via `Host.getChatVars`/`setChatVars`.
- **Global scope** — `getVariables({type:'global'})` / `insertOrAssignVariables(obj, {type:'global'})` / `insertVariables(obj, {type:'global'})` / `replaceVariables(obj, {type:'global'})` / `updateVariablesWith(fn, {type:'global'})` — ✅ (sync read) a **per-profile** KV bag shared across every chat and character; survives restarts, not in-prompt. Use it for app-wide UI prefs a card persists everywhere (e.g. the 艾莉亚 beautification's UI settings under `dialog_beauty.ui`). **Namespace your keys.** Backed by the per-profile globals (`profiles/<profileId>/template-globals.json`, `templateService`), exposed via `Host.getGlobalVarsSync`/`setGlobalVars`. Editable in the Variables panel's **全局变量 / Global variables** tab. (Per-key STScript access — `triggerSlash('/setglobalvar key val')` / `'/getglobalvar key'` — hits the SAME store via `Host.getGlobalVars`/`setGlobalVar`.)
- The host folds the model's `<UpdateVariable>` (`_.set` + `<JSONPatch>` incl. `delta`/array-append) natively (`mvuParser`); the runtime does NOT load the full MVU bundle.
- **Card writes survive MVU re-evaluation (journaled).** `stat_data` is rebuilt from the model's `<UpdateVariable>` blocks on re-evaluate (`generationService.reevaluateVariables`, triggered by chat edits/deletes), and card/panel writes are **not** re-derivable from response text. So every card write is journaled per floor to the `vars_ops` table and **REPLAYED after that floor's model fold**: JSON-Patch writes (`applyVariableOps` — `Mvu.setMvuVariable` / `insertOrAssignVariables` / `mvu.set` node) as `'patch'` ops, whole-replace (`replaceVariablesFromCard` — `Mvu.replaceMvuData` / `replaceVariables` via `wcv-host-set-vars`) as `'replace'` ops. Floor truncation (regenerate/swipe/delete-from) rolls back the journal at/after the cut (`chatService.truncateFloors` → `varsOpsService.deleteVarsOpsFrom`); chat deletion clears it via FK cascade. The **Variables-view whole-object debug write** (`setFloorStatData`) is deliberately **NOT** journaled — its contract is re-derive-from-scratch, so a re-evaluate is expected to overwrite it. See `src/main/services/generation/varsWrite.ts` + `src/main/services/varsOpsService.ts`.

### Chat / messages — 🟡

- `SillyTavern.chat[]` — ✅ built from floors (each message carries `swipes`/`swipe_id`); `saveChat()` + `reloadCurrentChat()` — ✅
- `SillyTavern.getContext().chatMetadata.variables` + `saveMetadata()` (also `SillyTavern.saveMetadata()`) — ✅ backed by the same persistent per-chat KV bag as `getVariables({type:'chat'})`. Supports legacy cards that mutate metadata variables in place before saving (for example 读者对话渲染's persona, appearance, silent-mode, and narrative-curve settings).
- `SillyTavern.saveSettingsDebounced()` / `getContext().saveSettingsDebounced` — ✅ **durable** (issue 19). RP Terminal has no ST `settings.json`, so `getContext().extensionSettings` is backed by a per-profile store (`extensionSettingsService` → `profiles/<id>/extension-settings.json`, via `Host.getExtensionSettingsSync`/`setExtensionSettings`). The bag is seeded from that store at runtime boot (an extension card reads its saved settings), `EjsTemplate.enabled` is force-defaulted, and `saveSettingsDebounced()` now PERSISTS the whole bag on a 200 ms debounce (a pending write is also flushed on runtime dispose). Was a no-op stub (`{ EjsTemplate:{enabled:true} }`) whose edits evaporated.
- `getChatMessages(range?)` (returns `message_id` = compact chat-array index; an integer selects one
  message, with negative indexes counting from the end, so `-1` returns the latest message) /
  `getCurrentMessageId()` / `getLastMessageId()` (alias of `getCurrentMessageId`) — ✅ (read)
- `setChatMessages([{message_id, message}])` — ✅ edit content by index (→ floor+role, re-fold + reload). `deleteChatMessages(ids)` — ✅ truncates from the earliest targeted message's floor (the floor model couples user+assistant, so arbitrary mid-chat single-message deletes aren't supported). Both via the shared `chatWriteService`.
  - **No-op guard:** a `setChatMessages` whose text is identical to the current message content is a **complete no-op** — no floor save, no variable re-fold, no chat reload, no events (a card re-rendering the same text must not spin the re-fold/reload chain). See `src/main/services/chatWriteService.ts`.
  - **Echo origin `card-write`:** card-initiated chat mutations (`setChatMessages` / `deleteChatMessages` / `saveChat` / `reloadCurrentChat`) re-fold `<UpdateVariable>` into `stat_data` and echo the result to sibling panels + the host — but **the writing card is excluded and the echo is tagged `card-write`**, so the writer's own MVU variable events do **not** re-fire and sibling panels refresh their caches **without** firing events. MVU variable events fire only on the model fold (the WS-3 stance). See `src/main/ipc/wcvIpc.ts` (`pushVars`/`afterChatMutation`) and `src/renderer/src/stores/chatStore.ts` (`refreshFloors`).
- `createChatMessages` — 🟡 routes to the composer-inject for onboarding; general insert-a-message deferred (ambiguous in the floor model). `createChat` — 🟡 (inline stub; WCV partial). Per-message swipe/var edits — ⬜.

### Worldbook / lorebook — ✅

- `getCharWorldbookNames('current')` → `{ primary, additional }` — ✅ (sync) · `getWorldbook(name)` → entries — ✅
- `updateWorldbookWith(name, fn)` / `replaceWorldbook(name, entries)` — ✅ **full replace** (add/remove/edit via read-modify-write).
- `createWorldbookEntries(name, entries)` → `{ worldbook, new_entries }` · `deleteWorldbookEntries(name, predicate)` → `{ worldbook, deleted_entries }` — ✅ (the workshop's install/uninstall path; predicate filters on `extra`).
- `createWorldbook` / `deleteWorldbook` / `bindWorldbook` (bind-unbind to chat) + `getWorldbookNames`/`getLorebooks` — ✅ **library-wide CRUD + bind** (trusted-card stance). id↔name is resolved in the runtime (`wbIdByName`).
- **Entry shape:** entries cross the card boundary in the TavernHelper `WorldbookEntry` shape (`strategy.{type,keys,keys_secondary}` / `position` / `recursion` / `extra`) and are mapped to/from our native `LorebookEntry` (`keys`/`constant`/`selective`/…) by the shared [`thRuntime/worldbookEntry`](../src/shared/thRuntime/worldbookEntry.ts) on EVERY read+write path, so `strategy.type:'constant'`↔`constant`, `strategy.keys`↔`keys`, and `extra` (card tags like `cw_project_id`) round-trip. (`LorebookEntrySchema` gained an optional `extra`.)
- Backing: file-based [`lorebookService`](../src/main/services/lorebookService.ts) (+ `scriptApiService`). The card's own book is at `id == characterId`.

### Character / preset — ✅ (read + preset write)

- `getCharData()` / `getCharAvatarPath()` — ✅ (sync, ctx-scoped) · `SillyTavern.getContext()` — ✅
- `getPreset('in_use')` / `getPresetNames()` / `getLoadedPresetName()` — ✅ (sync). `getPreset` returns the TavernHelper `Preset` shape (docs-confirmed spec §7): `{ name, settings, parameters, prompts, prompts_unused, extensions }`. `prompts` is the **live control surface** a card (the 狐神抚 case) reads + toggles — each entry carries `{ id (===identifier), name, role, content, enabled, marker, injection_depth, injection_order }`. `settings` is the sampler params (`parameters` kept as the legacy alias). `prompts_unused` + `extensions` come from the lossless envelope; BOTH transports source them from the same main-side `presetService.getActivePresetView` projection (WCV via its sync channel, the inline `cardBridge` via the `getActivePresetViewSync` sync IPC), so they are at parity (`[]`/`{}` only for a pre-envelope import). A non-`in_use` name resolves only when it names the active preset, else `null`.
- **Preset writes** — `replacePreset(['in_use',] preset)` / `setPreset(…)` / `updatePresetWith(fn)` — ✅. The card mutates the object it got from `getPreset` (e.g. flips a prompt's `enabled`) and hands it back; the runtime MERGES it onto the current normalized view by identifier (a partial edit never drops prompts; a card can't invent prompts) and persists a full normalized preset via `Host.savePreset` → `presetService.saveActivePreset` (`PresetSchema.parse` + write). Durable + immediate. TH's exact in-chat-edit-vs-saved divergence semantics are docs-silent (**F6-guarded**); RPT has no un-persisted overlay layer.
- `getCurrentCharacterName()` (from `charData().name`) · `SillyTavern.getCurrentChatId()` (the WCV ctx is empty — resolved from `e.sender` via `-get-chat-id-sync`) · `getScriptId()` (stable per-runtime id) — ✅ (sync)
- **Preset/card scripts preserve their upstream TavernHelper `id`** on import (docs-confirmed `Script.id`, spec §1 — issue 03 used to discard it → a random file id). Enabled scripts run in **ID-sorted** runtime order (`scriptService.getActiveScripts`). TH's real enabled-script execution order is docs-silent (**F1-guarded**) — ID-sorted is the most faithful order the docs support; if F1 shows tree/array order, only the comparator changes (the id is already preserved end-to-end).

**High-trust mode (ADR 0017 / issue 19).** A preset's **remote-code scripts** (a remote ES module / `<script src>` / `importScripts` / fetch of a remote `.js`) are dropped INERT at import. A **per-preset high-trust opt-in** (`presetSetHighTrust` / `presetIsHighTrust`; grant key `preset:<id>`) installs them to RUN — but pinned to the **isolated WCV realm only**: they resolve only when the caller is the isolated realm (`getRuntimeScripts(..., isolatedRealm=true)`, set by `CardScriptWcvHost`), never in the inline app-renderer host. High trust implies the isolated-realm network/CSP grant (`remoteScripts`) but NEVER the app-reaching `trusted` grant — the app renderer, main process, and API keys stay unreachable at every trust level. Worst case is a wrecked card view. All such scripts' variable writes are journaled like any card write; their pre-dispatch mutations are `opaque`-recorded (above).

### Generation — ✅ (request)

- `generate(text)` — ✅ runs a normal visible turn (host-side via `generationService.generate`); resolves
  with the response text, and a card-triggered turn is folded into the chat. `generateRaw(config)` — ✅ a
  one-off completion → text (snake_case `user_input`/`system_prompt`/`max_chat_history`/`overrides`
  normalized to `RawGenConfig`). **The AI key never reaches the card.** ✅ live `STREAM_TOKEN_RECEIVED`
  events fire as tokens stream. `stopGenerationById`/`stopAllGeneration` — ⬜.
- `triggerSlash` (STScript) — ✅ a subset (pipes/closures/`{{pipe}}`/macros, chat + global vars,
  `/gen`·`/genraw`·`/trigger`·`/send`) via the shared [`stscript`](../src/shared/stscript.ts) interpreter.
  `while`/loops + the long-tail command set — ⬜.

### Card Agent scheduling - built (RPT-only)

- `await rpt.agents.run(name, options?)` invokes one enabled Agent. `options.input` is direct JSON; `options.floor` must name an existing committed floor and otherwise defaults to the latest committed floor. An `AbortSignal` cancels the invocation.
- `await rpt.agents.runPlan(plan, { signal }?)` runs the validated top-level sequence / flat-parallel plan form. The same Agent cannot appear twice on one floor.
- `rpt.agents.registerTool(binding, handler)` registers a card-owned implementation for one declared Agent tool and returns an unregister function. Calls are correlated and abortable; arguments and results are size-bounded; staged variable operations commit only with a valid Agent result. Missing, incompatible, duplicate, or unmounted implementations fail before provider dispatch.
- `rpt.agents.onFloorCommitted(handler)` supplies `{ floor, variables, previousVariables }` once for a newly committed floor. Result incorporation and Forward Replay emit state refreshes, never this scheduling event.
- Scope is authoritative. Inline main IPC validates profile/chat/card against the chat; WCV main IPC derives it from the mounted sender. Caller-supplied scope cannot redirect a run or tool callback.
- Scheduling belongs to card JavaScript; RP Terminal has no variable/time scheduler. Repeated same-Agent calls for one floor coalesce to the existing invocation/result.

```js
const stop = rpt.agents.onFloorCommitted(async ({ floor, variables, previousVariables }) => {
  const month = variables.stat_data?.world?.month
  if (month === previousVariables.stat_data?.world?.month) return
  await Promise.all([
    rpt.agents.run('Monthly Property', { floor, input: { month } }),
    rpt.agents.run('World Progression', { floor, input: { month } })
  ])
})
```

The inline and isolated WCV transports share the public runtime shape (`src/shared/thRuntime/index.ts`) and are covered by the same transport fixture (`test/fixtures/cardAgentTransport.ts`). Main dispatch and tool preflight live in `src/main/ipc/agentRunIpc.ts`, `src/main/ipc/wcvIpc.ts`, and `src/main/services/agentRuntime/tools/CardToolRegistry.ts`.
### Regex — ✅

- `getTavernRegexes(option)` → full `TavernRegex[]` for a scope (`{type:'character'}` = the card's world
  bucket, `'global'`, `'preset'`) / `formatAsTavernRegexedString(text)` (apply active display regex to a
  string) / `isCharacterTavernRegexesEnabled()` — ✅ (sync). Shapes map via
  [`shared/thRuntime/tavernRegex`](../src/shared/thRuntime/tavernRegex.ts).
- `replaceTavernRegexes(regexes, option)` / `updateTavernRegexesWith(fn, option)` — ✅ **write** (full replace
  of the scope's bucket), backed by the existing `regexService` CRUD; the active renderer's regex cache and
  chat are reloaded together, **debounced** so a card can't thrash them. (WCV transport; the inline transport
  is a documented no-op — see `cardBridge/host.ts`.)
- ST destination flags are normalized as follows: `markdownOnly` means display, `promptOnly` means prompt,
  neither means both, and both checked also means both. The active filters live in
  [`regexService`](../src/main/services/regexService.ts); the TavernHelper shape bridge uses the same rules.
- **Application order** follows ST's script priority (ST `regex/engine.js` `SCRIPT_TYPES`, "ORDER
  MATTERS"): global → preset → scoped, where our `world`/`session` scopes are the scoped tier
  (global → preset → world → session), file order within a tier — `regexService.getAllRules`. Cards rely
  on this to run cleanup regexes (global/preset) before card-owned beautification (world) pastes large HTML.
- Replacement syntax supports ST-style `$0` for the full match, `$&` for the full match, and `$1`/`$2`...
  capture groups via the shared [`regexTransform`](../src/shared/regexTransform.ts). `$0` **always** expands
  to the full match, including inside a card payload: it is ST's whole-match token (ST's engine compiles
  `{{match}}` to a literal `$0`, then resolves `$N` → `args[N]` unconditionally; see
  [SillyTavern `engine.js` lines 421–425](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/extensions/regex/engine.js#L421-L425)),
  so a card that writes ``const data = `$0`;`` in its script is using a documented injection point.
  **`$&` in a card payload is a deliberate exception:** when the replacement is a frontend card (carries
  `<script>`/`<style>`/`<html>`/```` ```html ````), `$&` is left **literal** — a card's own script routinely
  contains the escape idiom `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`, and substituting `$&` there would
  splice the entire match into the script and break it. (ST never substitutes `$&` at all; that idiom is
  the reason.) Numbered groups (`$1`…) always inject, with `$N` left literal when the find-regex has no
  group N (so a card's own `$1` backreference survives).

### Events — ✅

- `eventOn`/`eventOnce`/`eventEmit`/`eventMakeFirst`/`eventRemoveListener` + `SillyTavern.eventSource.on/emit` — ✅ (a local bus). The `tavern_events` enum is provided (`window.tavern_events` + `getContext().eventTypes`/`event_types`).
- Lifecycle + mutation events — ✅ `GENERATION_STARTED/ENDED`, `CHAT_CHANGED`, `MESSAGE_RECEIVED/UPDATED/DELETED/SWIPED` are dispatched to BOTH transports (inline via the `cardHostEvents` renderer bus; WCV via `wcv-event`), computed from the chat-store transition. MVU `mag_variable_*` events fire on a vars push. `STREAM_TOKEN_RECEIVED` ✅ — payload is the full accumulated text so far, delivered at most once per animation frame (coalesced with the UI's own stream flush since 2026-07-15; not per raw provider delta). `MESSAGE_SENT` ⬜ (the user message is bundled into the floor — no separate transition); the full `tavern_events` enum is a ~10-event subset.

### EJS / macros — ✅

- `EjsTemplate.*` (`evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`) — ✅ (the clean-room ST-Prompt-Template engine; see [st-prompt-template-plan.md](st-prompt-template-plan.md)).
- **Pinned ST-Prompt-Template profile (WP-2.7).** The engine matches the extension's bundled EJS 3.1.9 +
  wrapper options, verified against `docs/research/sillytavern-prompt-compatibility.md` §6 (clean-room from
  the documented behavior — EJS/ST-PT source is **not** vendored). What the profile guarantees, all in
  [`templateEngine.ts`](../src/shared/templateEngine.ts) `compile`/`evalTemplateDetailed`:
  - **Async templates / top-level `await`.** Each template compiles into an `async` function body, so
    `<% const x = await … %>` and `<%= await … %>` work. RPT resolves the promise **synchronously**
    (drain microtasks + read the settled state) because the renderer loads a sync quickjs variant — template
    `await`s resolve against already-available values, not real host async.
  - **`print()` output function.** `print(x)` appends to the template output (the `outputFunctionName`
    profile), equivalent to a `<%- x %>` raw write.
  - **Bare-identifier context** (`_with:true` / `localsName`): context constants (`userName`, `charName`,
    `lastMessageId`, …) and the hoisted `variables` object resolve as bare identifiers.
  - **Generation escaper is IDENTITY** — `<%=` and `<%-` produce **identical** prompt text (the generation
    escaper returns its value unchanged). The **render/display** path selects a distinct **HTML escaper**
    (`<%=` escapes `& < > " '`, `<%-` stays raw) via `TemplateContext.escape: 'html'` — set it on the
    display context; generation/`EjsTemplate` default to identity.
  - **`include(...)` is a no-op** returning an empty template (RPT has no server-side filesystem include).
  - **Protected regions** `<thinking>` / `<think>` / `<reasoning>` / `<escape-ejs>` are emitted literally —
    EJS-looking text inside is **not** evaluated. Reasoning tags keep their wrapper; `<escape-ejs>` drops it.
  - **Whitespace-slurp** exactness (EJS 3.1.9): `<%_` / `_%>` strip same-line spaces/tabs around the tag,
    `-%>` / `_%>` trim a single following newline; `<%%` / `%%>` emit literal `<%` / `%>`.
- `substituteParams`/`substitudeMacros` (expand `{{macros}}`) — ✅ · `{{get_X_variable}}`/`{{format_X_variable}}` (X ∈ global/chat/message/preset/character) — ✅ · `registerMacroLike` — ⬜ (cross-process).
- **Persona macros** (ST-faithful): `{{user}}` = active persona **name**; `{{persona}}` = active persona **description**. The macro is **ungated** (ST parity): it returns the description even when prompt injection is off — only the prompt *injection* respects the inject toggle. Both transports resolve `{{persona}}` via the `personaDescription` host facet — inline (`cardBridge`) and WCV (`wcvPreload`) are at parity. The description is injected into the prompt (IN_PROMPT) at the preset's `personaDescription` marker position — emitted **raw** there (the preset author owns the framing, e.g. a `<{{user}}_setting>…</{{user}}_setting>` envelope, matching ST). When the preset has no such marker it falls back to a pre-conversation system block prefixed `[<user>'s Persona]`.
  Implementation: [`promptBuilder.ts`](../src/main/services/promptBuilder.ts), the
  [`ChatHost` facet](../src/shared/thRuntime/hostFacets.ts), the
  [inline host](../src/renderer/src/cardBridge/host.ts), and the
  [WCV handler](../src/main/ipc/wcvIpc.ts).
- **Unified variable surface (WS-1).** The EJS engine runs in three contexts — prompt-build (main),
  render-time (renderer), and the WCV preload — built from one shared `buildTemplateContext` and one
  engine. An MVU state key resolves the **same way in all three**, whether read with the explicit
  `stat_data.` prefix OR bare: `getvar('stat_data.主角.hp')` and `getvar('主角.hp')` both work, and
  `variables.主角` / `variables.stat_data.主角` both resolve (the engine falls back to `stat_data` when the
  bare path misses; the `variables` constant is the hoisted view). Top-level (preset/chat) vars win over the
  `stat_data` fallback on a name collision; `global` scope is exempt. _Caveats by context (inherent, not
  drift):_ render-time/WCV expose only `userName`/`charName` constants and no `globals` (the message-index /
  `chatId` / `runType` constants and per-profile globals exist only at prompt-build time); render-time
  `setvar` is **transient** (a fresh copy, never mutates the stored floor).

### World Assets — ✅

- `assetUrl(name, type, mood?)` → `Promise<string | null>` — resolve an asset (variant-aware) from the active world's asset layer. Files follow `<name>_<type>[_<变体>].<ext>`; supported extensions are `.png`, `.jpg`, `.jpeg`, `.jpe`, `.webp`, and `.gif`. A requested variant automatically falls back to the base file when absent. For example, `assetUrl('薇拉', '立绘', '舞台')` prefers `薇拉_立绘_舞台.<ext>` and falls back to `薇拉_立绘.<ext>`. **The category is inferred from `type`** via [`categoryForType`](../src/shared/worldAssets/types.ts) (a real lookup over `TYPES_BY_CATEGORY`): character portraits/gallery `头像`/`立绘`/`相册` → `character`, location art `背景`/`全景` → `location`, cutscene art `CG` → `cg` (any UNKNOWN string → `character`). So a card can request location art, e.g. `assetUrl('雾港', '全景')`, a character gallery slot `assetUrl('薇拉', '相册', '02')` (base = cover; `薇拉_相册_02.png`), or a scene CG `assetUrl('初遇', 'CG', '雨夜')` (`初遇_CG_雨夜.png`) — not just character portraits. Returns an `rptasset://` URL that loads inside card pages (both transports: inline iframes and WCV panels — each fills the inferred category in, so they stay at parity). Prerequisite: the World Assets layer ([world-assets-plan.md](world-assets-plan.md)). Also exposed as `window.assetUrl` and `window.TavernHelper.assetUrl` on card pages.
- `sceneAssetUrl(location, type)` → `Promise<string | null>` — 按层级地点解析`全景`或`背景`。文件名可以只写当前地点，也可选择性写入按原顺序出现的上级地点；如果当前地点无素材，解析器会使用最接近的可用上级地点背景。同分候选会安全失败，不会任意选择。该方法同时暴露为 `window.sceneAssetUrl` 和 `window.TavernHelper.sceneAssetUrl`。（`Host.sceneAssetUrl` 现为必需成员，由两个 transport 各自实现，运行时不再回退到 `assetUrl`。）
- `assetList(name, type)` → `Promise<Array<{ variant: string | null; url: string }>>` (WA-3) — **enumerate** one entry's files (all variants of a single `name`+`type`), for building a gallery (相册) or a CG shelf. Same category inference and lorebook-id precedence as `assetUrl`: the **first** world lorebook that carries the entry wins (entries are not merged across worlds). Order: the **base** file first (`variant: null`, e.g. the 相册 cover), then variant/slot tokens **naturally sorted** (numeric-aware `localeCompare(…, 'zh', {numeric:true})`, so `2` precedes `10`). Empty array on any miss (unknown name/type, empty name, or a type outside `ASSET_TYPES`). Each `url` is a ready-to-load `rptasset://` URL. Also `window.assetList` / `window.TavernHelper.assetList`. Standalone-preview guard: `typeof assetList === 'function'` before calling (it's undefined outside RPT). Backed by [`Host.assetList`](../src/shared/thRuntime/types.ts) — both transports (WCV: `worldAssetService.assetListForWorld`; inline: `cardBridge/host.ts`) at parity.
- `rptHost.requestAssetImport({ name, type, variant? })` → `Promise<string | null>` (WA-3) — **host-privilege write** (RPT-only; like `requestOverlay` it lives on `rptHost`, not as a bare read global). Main opens the OS image file-picker (**user-mediated** — consistent with the deferred-security stance; the card never reads file bytes), copies the chosen image into the calling card's **primary** world under `<name>_<type>[_<variant>].<ext>`, invalidates the asset index, and resolves the new `rptasset://` URL — or `null` on cancel, a bad arg (`type` outside `ASSET_TYPES`, empty `name`, an unsupported extension), or no world for the card. **Overwrite = replace** (no shadow default — design §2). File type must be one of png/jpg/jpeg/jpe/webp/gif. The poem partner sheet's edit mode wires 更换头像 / 添加相册 to this. Exposed as `window.rptHost.requestAssetImport` on both transports (inline cardBridge + WCV); also `window.requestAssetImport` / `window.TavernHelper.requestAssetImport`. Standalone-preview guard: `typeof rptHost?.requestAssetImport === 'function'`. Backed by [`Host.requestAssetImport`](../src/shared/thRuntime/types.ts) (WCV + inline route to the shared `pickAndImportAssetForCard` in `worldAssetIpc.ts`).

### Duel / deckbuilder — ✅

- `getDuelPreview()` → `Promise<DuelPreview | null>` — **read-only host method** (RPT-only; no vanilla-ST equivalent). Returns the engine-computed duel build (deck + combatants + resources/relics) for the active chat, produced by the card's combat ruleset over the active build state. The `DuelPreview` contract is generic (field names are neutral; the card's ruleset supplies values + display strings). Shape: `{ config: {energyPerTurn, handSize}, lead: CombatantPreview, party: CombatantPreview[] }`; each combatant has resources, modifiers, conditions, and a `deck[]` of `CardPreview` (rarity/cost/effects/scaling). See [`preview.ts`](../../src/shared/combat/deckbuilder/preview.ts) for the full type. Designed for the 战斗 tab ([duel-build-preview-tab-design.md](superpowers/specs/2026-06-30-duel-build-preview-tab-design.md) §2) and the poem duel-card authoring guide (now in the `POD-Frontend-For-RPT` repo under `legacy/`). **Consumer (live):** the 命定之诗 status-fork 战斗 tab (`FrontEnd-for-destined-journey-TPR-STS`, on its `main`) — it calls `getDuelPreview()` with a fixture fallback and renders the deck-as-cards. The `DuelPreview` type is **mirrored** in the fork at `src/status/core/types/duel-preview.d.ts`; that copy and [`preview.ts`](../../src/shared/combat/deckbuilder/preview.ts) are the **shared contract** and must be changed together (hand-kept in sync, per the design §7).

### Overlay surfaces — ✅ (PM-A7)

- `requestOverlay(id)` → `Promise<boolean>` — **RPT-only host method** (no vanilla-ST equivalent). Raise a full-play-area overlay surface the active card declares in [`panel_ui.overlays`](sdk/component-inventory.md) (`{ id, entry, title? }`). The app mounts the named surface as a WebContentsView covering the whole `panel_ui` grid region (above the slots, **not** the titlebar / TopStrip) — the mechanism a card surface needs because WCVs composite above the DOM only *inside* their slot rectangle, so a surface can't otherwise escape its slot (partner sheet, 地图). **One overlay at a time:** requesting another id closes the current one first; requesting the already-open id is a no-op. Resolves `true` when it opened, `false` when the id isn't declared by the active card (rejected + `console.warn` main-side). No params in the API — context travels via chat KV + `broadcastEvent` (keeps it one-string simple). The overlay WCV is transparent; the surface paints its own scrim/sheet, and it freeze-frames under TopStrip dropdowns like any WCV (PM-A4). Also exposed as `window.requestOverlay` and `window.TavernHelper.requestOverlay`; on WCV panel surfaces it is additionally `window.rptHost.requestOverlay` (alongside `rptHost.broadcastEvent`). Both transports route to [`Host.requestOverlay`](../src/shared/thRuntime/types.ts).
- `closeOverlay()` → `Promise<void>` — dismiss whatever overlay is open (a no-op when none is). The card's own ✕ / backdrop-click / Esc call this; the app also closes on Esc when focus is outside the overlay and force-closes on session / card switch. Also `window.closeOverlay` / `window.TavernHelper.closeOverlay` / `window.rptHost.closeOverlay` (WCV).

### Theme / appearance — ✅ (runtime-theme-api)

Runtime restyling of the **play shell + chat message box**, extending the static card-theme path (§6a of [ui-rehaul-design.md](ui-rehaul-design.md)). Same trust model as the static theme: token overrides are **untrusted design input** — text/on-* colors are derived (never trusted) and a result failing WCAG-AA is **rejected** (the method returns `false`, prior tokens intact). Honors `settings.ui.allow_card_themes` (off ⇒ no-op returning `false`) and is ctx-scoped — a card themes only its own play session, never the launcher / settings / `<html>`. Full design + trust model: [runtime-theme-api-design.md](runtime-theme-api-design.md).

- `setPlayTheme(theme, opts?)` → `Promise<boolean>` — **RPT-only host method**. Apply a token override at runtime. `theme` is `{ base?, tokens: {…} }` or a bare override map (friendly aliases like `accent`, `bg-1`, or raw `--rpt-*`); `null`/`{}` **clears** the runtime layer (→ static card theme → user theme). `opts.target` = `'shell'` (default; the full alias set, layered over the static card theme) or `'message'` (only the message-box `--rpt-msg-*` / `--rpt-chat-*` family survives; other keys ignored). `opts.persist` = `'session'` (default — ephemeral, lost on restart / world switch), `'chat'` (per-chat card vars), or `'global'` (per-profile globals); persisted overrides re-hydrate on load. Precedence: user base → static card tokens → **runtime override** → user accent. Returns `false` when rejected (contrast/AA fails or `allow_card_themes` off). Emits `PLAY_THEME_CHANGED` on the card event bus so sibling panels re-read. Also `window.setPlayTheme` / `window.TavernHelper.setPlayTheme`; on WCV panels additionally `window.rptHost.setPlayTheme`. Routes to [`Host.setPlayTheme`](../src/shared/thRuntime/types.ts) → the renderer authority ([`cardBridge/playTheme.ts`](../src/renderer/src/cardBridge/playTheme.ts)) on both transports.
- `setMessageTheme(tokens, opts?)` → `Promise<boolean>` — sugar for `setPlayTheme({ tokens }, { target: 'message', ...opts })`. The message-box whitelist: `msg-bg` · `msg-border` · `msg-radius` · `msg-text` · `msg-user` · `chat-size` (`--rpt-chat-font`) · `chat-font`/`prose-font` (`--rpt-chat-font-family`). The color tokens run a message-scoped contrast check (`msg-text`/`msg-user` vs `msg-bg`, falling back to `--rpt-bg-secondary`).
- `getPlayTheme()` → `{ tokens, source }` — **sync**. The fully-resolved effective token map actually on screen + a `source` tag (`'user'` | `'card'` | `'runtime'`). Also `window.getPlayTheme` / `window.TavernHelper.getPlayTheme` / `window.rptHost.getPlayTheme` (WCV).

### UI / misc — ✅ / 🔁

- `toastr.*` — ✅ · `getTavernHelperVersion()` — ✅ (reports ≥ the card's required minimum) · `waitGlobalInitialized()` — ✅ (resolves true) · `errorCatched(fn)` — ✅
- Audio (background music / SFX) — 🔁 stubs (`audioPlay`/`audioPause`/`audioImport`/`audioMode`/`audioEnable`, no-op + logged). Cards play audio directly under the CSP (native `<audio>`/WebAudio) — the real path.

### Combat — ✅ (Track Combat)

A native, deterministic grid combat engine (`src/shared/combat`) the AI drives via tags; the player plays
it in the Combat-mode `CombatView`. The engine owns every number (seeded); the AI only narrates + referees.

- **Initiate** — the model emits `<rpt-combat-start enemies="哥布林 x3 (弱); 头目" map="forest"></rpt-combat-start>`;
  the chat shows an **Enter Combat** button that builds the encounter from the world's `combat` bundle
  (`buildEncounter`, or `buildEncounterFromMvu` when the bundle has a `stat_map`) and switches to Combat
  mode. The tag is hidden in prose; the cue is stashed on the floor. The tag **body may carry a JSON enemy
  roster** (channel A1) — `parseCombatStart` extracts it to `cue.roster` and the engine builds those
  combatants. **Lifecycle:** the encounter is per-chat + ephemeral; re-rolling/swiping the originating
  message clears it (`clearEncounter`), an always-available **Quit combat** button returns to chat
  (continue AI-narrated), and a no-viable-party guard avoids a blank board. Combat mode shares the default
  workspace layout (no swap).
- **Adjudicate / mid-fight exit** (the freeform-action box) — for an action the engine can't model
  (including leaving the fight), the player's prose → an adjudication prompt (steered by the card's
  `combat.improvise_prompt` / the user's `settings.combat.improvisePrompt`); the model replies with
  `<rpt-combat-result>{ "narration": "…", "ops": [ {"op":"damage|heal|move|condition", …} ], "end": false }</rpt-combat-result>`,
  folded into the fight. `"end": true` concludes/escapes combat → the prose lands in the chat and the
  encounter exits.
- **Enemy AI** — **deferred**: a dormant scaffold (`controller:"ai"` → `<rpt-action>{…}</rpt-action>`,
  weighted-policy fallback) that will need its own player/world prompt before production. Today enemies
  use the native weighted policy with no AI call.
- **Action economy / LoS** — each combatant gets one move + one attack + one action per turn
  (`AbilityDef.cost`); abilities with `requiresLoS` are blocked by `blocksLoS` terrain. Deeper tactics
  (cover, opportunity attacks, flanking, extended conditions) are **script-authored** via `combat.scripts`.
- **Narrate / fold-out** — at the end, the log → a narration prompt; lasting consequences are recorded via
  the world's `<UpdateVariable>` into `stat_data` (combat never writes `stat_data` directly).
- **MVU import / card combat systems** — a world whose stats live in MVU `stat_data` (e.g. 命定之诗)
  can build the **party from those variables** (`combat.stat_map` + `combat.derive`) instead of
  `party` templates, and resolve the fight with its **own** rules via a **combat system** (`CombatSystem`
  = `parseItem` + `buildCombatant` + `resolveAction`, selected by `getSystem(id)`; v1 built-in `poemD20`).
  The card authors combat numbers into the MVU fields it already preserves (`标签`/`效果`/`消耗`) — no
  new field; the parsed kit rides in the `Combatant.ext` / `AbilityDef.ext` bag. The system's
  `resolveAction(ResolverContext)` is injected as the engine RunHook (runs first; `null` → native). See
  the 命定之诗 card-side combat expansion doc (`combat-poem-of-destiny-expansion.md`, now in the
  `POD-Frontend-For-RPT` repo under `legacy/`) + component-inventory §8a.
- **Bundle** — `extensions.rp_terminal.combat`: `ruleset`, `grid`, `enemy_controller`, `abilities[]`
  (incl. `cost` / `requiresLoS`), `bestiary[]`, `party[]`, `maps[]`, `scripts{hook→code}` (sandboxed
  overrides), `skin`, the prompts `narration_prompt` / `narration_mode` / `improvise_prompt`, and (MVU
  import) `stat_map` / `derive`. See [combat-system-design.md](combat-system-design.md) §10/§15.

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
`-get-preset-names` / `-get-regexes` / `-format-regex` / `-get-persona-name` / `-get-persona-description`, the regex-full + write channels
(`-get-regexes-full` / `-replace-regexes` / `-is-char-regex-enabled`), `-get-chat-id-sync`, the script-scope
KV channels (`-script-vars-get-sync` / `-script-vars-set`), and the chat-write channels
(`chat-set-messages` / `-delete-messages` / `-save`), and the runtime-theme channels
(`wcv-host-set-play-theme` + `-reply` / `wcv-get-play-theme-sync` / `set-play-theme-cache`). Host → card: `wcv-vars-changed` (mirror refresh) +
`wcv-event` (lifecycle/mutation/stream). **Runtime theme (runtime-theme-api-design §5)** — the theme
authority is the **renderer** (only it has the effective base tokens), so unlike other write channels the
main handler doesn't do the work: `wcv-host-set-play-theme` **relays** the call to the host renderer
(which derives + AA-checks + applies via [`cardBridge/playTheme.ts`](../src/renderer/src/cardBridge/playTheme.ts))
and returns its boolean verdict via a keyed `-reply`; `getPlayTheme` reads a snapshot the renderer keeps
pushing to main (`set-play-theme-cache`). The inline transport calls the same renderer authority directly. **Write-back loop guard (origin-tagged, WS-3 fix 2026-07-02)** —
a card that re-writes on its own `mag_variable_update_ended` / `MESSAGE_UPDATED` used to spin forever,
because its write looped back both directly (`notifyVarsChanged`) and indirectly (the host applies the
change to the floor, whose store update re-broadcasts via `wcv-broadcast-vars` to all slots). The loop is
now closed **at the source, faithfully to real MVU**: every `stat_data` change is tagged with an
**origin** (`model-fold` | `card-write` | `external`) end-to-end — `chatStore.lastVarsOrigin` → the inline
`cardBridge` subscription / `wcv-broadcast-vars` (→ `notifyVarsChanged(…, origin)`) → the shared runtime's
`onVarsChanged(sd, { origin })`. The runtime **always refreshes its `stat` cache** (so `getvar` / EJS
injection see card writes) but fires `mag_variable_update_*` / `MESSAGE_UPDATED` **only for non-`card-write`
origins**. This matches the MIT MagVarUpdate source, where those events are emitted only on the AI-message
fold, never on programmatic writes (`setMvuVariable`/`insertOrAssignVariables` are pure helpers) — so a
card's own write no longer re-triggers its own handler. (Cards that chained init through their own
update events were relying on RPT's old divergent behavior; on real MVU that init runs on the fold, which
still fires.) The remaining defenses are **backstops**: (1) `generationService.applyVariableOps` still
drops a runaway **signature** (the same sorted changed-path list written `LOOP_MAX=40` times consecutively
between folds; reset per model turn) and returns `null` for a **no-op write**, logging the changed
`path`s; (2) the direct write handlers (`wcv-host-apply-vars` / `-set-vars`) pass `e.sender.id` +
`'card-write'` to `notifyVarsChanged`, skipping the author's slot and tagging siblings so no panel
re-fires events for another panel's programmatic write. Both transports inherit the behavior from the
shared runtime. To add an API:
add the runtime method
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

## 7. Template / macro error-handling policy

One stated rule for how the macro/EJS pipeline fails, so each surface is predictable and the next change
preserves the invariant (review WS-9). When you add a new template surface, pick the matching tier:

| Surface                         | On error                                                                                                | Why                                                                                                                                                  | Code                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Preset blocks**               | **Fail loud** — throw, fail the turn (logged with the block name + reason)                              | A preset is author-trusted infrastructure; a broken `<% if %>…<% else %>` must NOT silently leak every branch (or drop all of them) into the prompt. | `promptBuilder.ts` `ejsStrict`             |
| **Card / lorebook content**     | **Degrade gracefully** — strip the `<%…%>` tags, keep the surrounding prose; log the entry + reason     | A 10 KB lore entry with one bad trailing `<%…%>` block should still contribute its prose, not vanish.                                                | `promptBuilder.ts` `renderLoreEntry`       |
| **Engine off / not yet loaded** | **Strip tags** (no eval)                                                                                | The toggle/uninitialized state is not an error; `{{macros}}` still expand.                                                                           | `templateEngine.ts` `evalTemplateDetailed` |
| **Engine eval error (shared)**  | Return **empty output** + the error string (callers decide: presets throw, lore strips-and-keeps-prose) | Returning the tag-stripped template here would leak every branch; the caller owns the user-facing fallback.                                          | `templateEngine.ts` `evalTemplateDetailed` |
| **Unknown `{{macro}}`**         | **Pass through verbatim**                                                                               | An unrecognized macro may be meaningful to a later pass or to the model; never blank it.                                                             | `macros.ts` `expandMacros`                 |

Rule of thumb: **author infrastructure fails loud; card-supplied content degrades; non-errors strip; unknown
passes through.**

This is RPT's mapping of the ST-Prompt-Template layered failure model (research §6): the inner evaluation
logs the error **with a source/line diagnostic** (`evalTemplateDetailed` appends `compiled L{n}: …`); the
handler tier returns the null-equivalent (empty output + error string); and the outer final-prompt caller
either **rethrows** (`ejsStrict`, presets) or keeps/skips the content (`renderLoreEntry`, lore).

## 8. WebContentsView card layout compatibility

SillyTavern frontend cards commonly run in an auto-height iframe. An isolated RPT card instead runs in a
fixed-height `WebContentsView`, where an overflowing child of a vertical flex container can shrink below
its content and clip or overlap text. RPT floors only those collapsed children to
`min-height: fit-content`; elements that own vertical scrolling are left unchanged.

### How to run

Run `npm run dev`, select the isolated card-rendering mode, and open the affected frontend card. The
compatibility pass installs automatically after every main-frame and child-frame navigation and watches
later DOM or viewport changes.

### Decisions

- Main uses Electron's `did-frame-finish-load` and `WebFrameMain.executeJavaScript` so the layout-only
  pass reaches both same-origin and cross-origin child frames.
- Child frames do not receive Node integration or the TavernHelper preload. This preserves the existing
  security boundary while fixing layout in the frame that owns the DOM.
- Detection is behavior-based (`scrollHeight > clientHeight` under a vertical flex parent), not tied to
  card-specific class names.

### Verification

- `npm test`: 294 files and 3,125 tests pass.
- `npm run build`: node and web typechecks plus all Electron Vite bundles pass.
- Electron flex harness: before the fix, 8 of 8 main/child-frame items measured `20px` high with `56px`
  of content; after the fix, all measured `56px` high and zero remained collapsed.
