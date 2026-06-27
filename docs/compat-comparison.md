# RP Terminal vs. Tavern Helper vs. ST-Prompt-Template

A feature + API comparison of RP Terminal (RPT) against the two SillyTavern extensions it targets
compatibility with. Clean-room throughout — RPT reimplements the _surface/behavior_ from public docs;
no extension code is copied. Sources: [TavernHelper / JS-Slash-Runner
docs](https://n0vi028.github.io/JS-Slash-Runner-Doc/), [ST-Prompt-Template
features](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/features.md) +
[reference](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/reference.md).

Legend: ✅ full · 🟡 partial · ⬜ none · 🔁 stub · N/A not applicable

---

## 1. What each is, and how it maps to RPT

|                     | Tavern Helper (JS-Slash-Runner)                                                                    | ST-Prompt-Template                                                                | RP Terminal                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Kind**            | A **JS script runtime** + frontend-card renderer, as a SillyTavern _extension_                     | A **prompt-template engine** (EJS) extending ST's macro syntax, as an _extension_ | A **standalone Electron app** that is _format-compatible_ with both                                                         |
| **Runs**            | Inside the ST web page (its runtime, jQuery/DOM)                                                   | Inside ST's prompt-build + message-render pipeline                                | Its own engine (main process) + **dual-mode** card UI: inline same-origin iframe (default) or out-of-process WCV (isolated) |
| **License**         | AFPL (non-free) — never vendored; clean-room shim only                                             | AGPL-3.0 — clean-room reimpl. of the engine                                       | undecided (leaning AGPL)                                                                                                    |
| **RPT counterpart** | the **card runtime** `shared/thRuntime` (one surface, two transports: `cardBridge` + `wcvPreload`) | `templateService` + `renderTemplate` (quickjs EJS engine)                         | —                                                                                                                           |

RPT carries **both** compat surfaces: the EJS template engine _and_ the TH JS API. The two extensions
overlap (both touch variables/world-info), but their centers differ — ST-PT is templating, TH is scripting.

---

## 2. Prompt templating (vs ST-Prompt-Template → RPT `templateService` + `renderTemplate`)

> Full status in [st-prompt-template-plan.md](st-prompt-template-plan.md) — **Phases A–E complete.**

| Feature                                                                          | ST-Prompt-Template            | RPT                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EJS `<% %>` / `<%= %>` / `<%- %>`                                                | ✅                            | ✅ (quickjs WASM sandbox)                                                                                                                                                                                                                         |
| `<%# comment %>`, `<%_`/`_%>` trim, `<#escape-ejs>`                              | ✅                            | 🟡 `<%#` + trim ✅; `<#escape-ejs>` ⬜                                                                                                                                                                                                            |
| Eval **before send**                                                             | ✅                            | ✅ (authored system/char/lore/literal blocks)                                                                                                                                                                                                     |
| Eval **render-time** (on AI output)                                              | ✅ `[RENDER:*]`, `@@render_*` | ✅ full EJS in the renderer, rate-limited live + final pass (`renderTemplate`, gated by `settings.templates.render`); `render_permanent` overwrite ⬜                                                                                             |
| `getvar/setvar/incvar/decvar/delvar` (+ scope aliases)                           | ✅                            | ✅ local/global (message scope realized at render-time)                                                                                                                                                                                           |
| Variable scopes: global / local / **message**                                    | ✅                            | ✅ local/global + message (the floor's `variables` at render-time)                                                                                                                                                                                |
| `getwi` / `getWorldInfoData` / `getWorldInfoActivatedData`                       | ✅                            | ✅ `getwi`/`getWorldInfoData`/`getWorldInfoActivatedData`                                                                                                                                                                                         |
| `getchar` / `getCharData`                                                        | ✅                            | ✅ `getchar(field)`                                                                                                                                                                                                                               |
| `getpreset(name)`                                                                | ✅                            | ✅ named prompt-block content (name/identifier/regex match)                                                                                                                                                                                       |
| `getChatMessages` / `matchChatMessages` / `parseJSON` / `jsonPatch`              | ✅                            | ✅ `getMessageHistory`/`matchChatMessages`/`parseJSON`/`jsonPatch`                                                                                                                                                                                |
| `define()` (persistent macros)                                                   | ✅                            | ✅                                                                                                                                                                                                                                                |
| `[GENERATE:BEFORE/AFTER/{idx}]`, `@INJECT`, `[GENERATE:REGEX:]`, `@@` decorators | ✅                            | ✅ build-time (`injectMarkers` + `promptBuilder`); preload decorators ⬜ (RPT has no card-open preload phase)                                                                                                                                     |
| `[InitialVariables]` / `@@initial_variables` preload                             | ✅                            | ✅ (`mvuSchema.parseInitVars` → floor-0 `stat_data`) + `state_schema.defaults`                                                                                                                                                                    |
| `injectPrompt` / `getPromptsInjected`                                            | ✅                            | 🟡 (the marker/@INJECT machinery covers the inject path; not exposed as these helpers)                                                                                                                                                            |
| `faker`                                                                          | ✅                            | 🟡 clean-room subset (number/float/bool/pick/uuid/name/word/lorem)                                                                                                                                                                                |
| `lodash` (`_`)                                                                   | ✅                            | ✅ clean-room `_` subset in the sandbox (get/set/has, clone/cloneDeep, the collection helpers — map/filter/find/reduce/each/groupBy/sortBy/sumBy/…, type guards); not 100% of lodash                                                              |
| **`await` (async templates)**                                                    | ✅ (runs in the browser)      | ⬜ engine compiles a **sync** IIFE — `await` → `SyntaxError`. Async eval (`evalCodeAsync`) not wired                                                                                                                                              |
| **`TavernHelper.*` inside a template**                                           | ✅ (TH global present)        | ⬜ prompt-build bridge has getvar/`_`/faker but **no `TavernHelper`** (it's renderer-side; `triggerSlash`/`generate` at build time invite re-entrancy). Such async/side-effecting init belongs in a card SCRIPT, not a prompt-injected lore entry |
| `EjsTemplate.*` API surface                                                      | ✅                            | ✅ (`evalTemplate`/`prepareContext`/`getSyntaxErrorInfo`/`allVariables`/`saveVariables`)                                                                                                                                                          |
| Token/char counters (`LAST_SEND_TOKENS`, …)                                      | ✅                            | 🟡 (cache read/write tokens logged; not exposed as template vars)                                                                                                                                                                                 |

---

## 3. Script / card JS API (vs Tavern Helper → RPT `shared/thRuntime`)

The TH JS API a card's scripts + frontend call. **One surface** (`createThRuntime` over a `Host` seam),
**two transports at parity** — inline `cardBridge` (default) and WCV `wcvPreload` (isolated). The old
iframe-`rpt`/`MessageScriptFrame` path is **retired**; the column below applies to both transports.

| Category                                                                       | Tavern Helper         | RP Terminal (`thRuntime`)                                                                                  |
| ------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Variables** get/set/insert/replace/updateWith, MVU                           | ✅                    | ✅ (`stat_data` + RFC-6902 JSONPatch)                                                                      |
| **Chat** read (messages, last id)                                              | ✅                    | ✅                                                                                                         |
| **Chat** write (set/delete/save/reload/setInput)                               | ✅                    | ✅ (shared `chatWriteService`); general mid-history insert ⬜                                              |
| **Worldbook** get/create/edit/delete entries + bind                            | ✅                    | ✅ full library CRUD + bind (read-modify-write; trusted-card stance)                                       |
| `getCharWorldbookNames`                                                        | ✅                    | ✅ (sync)                                                                                                  |
| **Character / preset** read (`getCharData`, avatar, preset)                    | ✅                    | ✅                                                                                                         |
| **Generation** `generate` / `generateRaw`                                      | ✅                    | ✅ host-side (the AI key never reaches the card)                                                           |
| `stop` / stream-token events                                                   | ✅                    | 🟡 `STREAM_TOKEN_RECEIVED` ✅; `stopGenerationById` ⬜                                                     |
| **Regex** `getTavernRegexes` / `formatAsTavernRegexedString` / `replace`       | ✅                    | 🟡 read + format ✅; `replaceTavernRegexes` (write) 🔁 stub                                                |
| **Events** `eventOn/Once/Emit/MakeFirst/RemoveListener`                        | ✅                    | ✅ (local bus + MVU lifecycle + stream)                                                                    |
| Full `tavern_events` enum mapped to pipeline                                   | ✅                    | 🟡 ~10-event subset; `MESSAGE_SENT` ⬜                                                                     |
| **Slash / STScript** `triggerSlash` (pipes, closures)                          | ✅                    | 🟡 subset (`shared/stscript`): `/gen`·`/genraw`·`/trigger`·`/send`, chat+global vars; `while`/long-tail ⬜ |
| **Macros** `substituteParams`/`substitudeMacros` + `{{get/format_X_variable}}` | ✅                    | ✅; `registerMacroLike` ⬜                                                                                 |
| **EJS** `EjsTemplate.*`                                                        | ✅                    | ✅                                                                                                         |
| **Audio** background music / SFX API                                           | ✅                    | 🔁 stub (cards load audio natively under the CSP)                                                          |
| **Embedded interactive HTML / 前端卡**                                         | ✅ (same-page iframe) | ✅ dual-mode: inline same-origin iframe (default) + out-of-process WCV (isolated)                          |

---

## 4. Where RPT is BEHIND (priorities)

- **ST-PT templating:** narrowed to non-goals/edge cases — `render_permanent` (opt-in stored-floor
  overwrite), preload decorators (no card-open preload phase), `<#escape-ejs>`, token-counter template
  vars, `injectPrompt`/`getPromptsInjected` as named helpers. The core (render-time eval, the markers,
  message scope) is **done** ([st-prompt-template-plan.md](st-prompt-template-plan.md)).
- **TH JS API:** `stopGenerationById`/`stopAllGeneration`, the full `tavern_events` enum (we wire ~10) +
  `MESSAGE_SENT`, `replaceTavernRegexes` (regex write), `registerMacroLike`, general mid-history message
  insert / per-message swipe edits, and the **audio** API. Most are graceful stubs or low-value; see
  [docs/rpt-api.md](rpt-api.md) §6 and [th-parity-status.md](superpowers/specs/2026-06-23-th-parity-status.md).

## 5. Where RPT is AHEAD (its own design)

- **Optional out-of-process card isolation** — a card can render in a `WebContentsView` (separate process)
  so a broken card can't freeze the app; ST/TH only have same-page iframes. RPT defaults to an inline
  same-origin iframe (native feel) **with WCV as the opt-in crash-safe escape hatch** — a choice ST doesn't
  offer.
- **Native MVU state engine** — `<UpdateVariable>` (`_.set` + RFC-6902 `<JSONPatch>` incl. `delta` +
  array-append) folded natively into `stat_data`; no MVU bundle loaded, plus a "Re-evaluate" replay.
- **Generation centralized in main** — the card/script never sees the AI key (masked from the renderer);
  four-layer prompt-cache assembly with Anthropic `cache_control` + Gemini/OpenAI prefix caching.
- **FSM modes** (Explore/Dialogue/Combat) with per-mode tuning + L2 lore caching on transition.
- **World Card** superset (ST-compatible) with lossless extract-and-route import + export/packing.
- **App-grade plumbing** — SQLite storage, multi-provider streaming (OpenAI / Anthropic / Gemini /
  OpenRouter / custom), in-app profiles, a plugin system with a manifest + permission model.

## 6. Net

RPT is **strong on the app/engine + MVU + isolation** axes and **format-compatible** with ST cards,
lorebooks, regex, and presets. The remaining compatibility _gaps_ are a thin ST-PT edge-tail and a few TH
JS API leftovers — both clean-room, most backed by services that already exist, so closing them is wiring
work. Tracked under **Track C0** + the
[TH-parity status](superpowers/specs/2026-06-23-th-parity-status.md); the card-author-facing catalog +
ST→RPT transformation mapping live in [docs/sdk/](sdk/component-inventory.md).
