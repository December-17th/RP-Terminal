# RP Terminal vs. Tavern Helper vs. ST-Prompt-Template

A feature + API comparison of RP Terminal (RPT) against the two SillyTavern extensions it targets
compatibility with. Clean-room throughout — RPT reimplements the _surface/behavior_ from public docs;
no extension code is copied. Sources: [TavernHelper / JS-Slash-Runner
docs](https://n0vi028.github.io/JS-Slash-Runner-Doc/), [ST-Prompt-Template
features](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/features.md) +
[reference](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/reference.md).

Legend: ✅ full · 🟡 partial · ⬜ none · N/A not applicable

---

## 1. What each is, and how it maps to RPT

|                     | Tavern Helper (JS-Slash-Runner)                                                | ST-Prompt-Template                                                                | RP Terminal                                                         |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Kind**            | A **JS script runtime** + frontend-card renderer, as a SillyTavern _extension_ | A **prompt-template engine** (EJS) extending ST's macro syntax, as an _extension_ | A **standalone Electron app** that is _format-compatible_ with both |
| **Runs**            | Inside the ST web page (its runtime, jQuery/DOM)                               | Inside ST's prompt-build + message-render pipeline                                | Its own engine (main process) + an out-of-process WCV for card UI   |
| **License**         | AFPL (non-free) — never vendored; clean-room shim only                         | AGPL-3.0 — clean-room reimpl. of the engine                                       | undecided (leaning AGPL)                                            |
| **RPT counterpart** | `rpt` API + `TAVERN_SHIM` + the **WCV shim** (`wcvPreload`)                    | `templateService` (quickjs EJS engine)                                            | —                                                                   |

RPT carries **both** compat surfaces: the EJS template engine _and_ the TH JS API. The two extensions
overlap (both touch variables/world-info), but their centers differ — ST-PT is templating, TH is scripting.

---

## 2. Prompt templating (vs ST-Prompt-Template → RPT `templateService`)

| Feature                                                                                              | ST-Prompt-Template            | RPT                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| EJS `<% %>` / `<%= %>` / `<%- %>`                                                                    | ✅                            | ✅ (quickjs WASM sandbox)                                                                                                                        |
| `<%# comment %>`, `<#escape-ejs>`                                                                    | ✅                            | 🟡 `<%#` comments ✅ + `<%_`/`_%>` trim ✅; `<#escape-ejs>` ⬜                                                                                   |
| Eval **before send**                                                                                 | ✅                            | ✅ (authored system/char/lore/literal blocks)                                                                                                    |
| Eval **render-time** (on AI output)                                                                  | ✅ `[RENDER:*]`, `@@render_*` | ⬜ deferred (engine is main-side, render is renderer-side → needs an IPC eval bridge; render-time _macros_ cover common cases)                   |
| `getvar/setvar/incvar/decvar/delvar` (+ scope aliases)                                               | ✅                            | ✅ local/global                                                                                                                                  |
| Variable scopes: global / local / **message** / **character**                                        | ✅ all four                   | 🟡 local/global/message/chat aliases exist, but message/character currently map to the chat store (no dedicated per-message/character store yet) |
| `insvar` / `patchVariables` (JSON Patch) / `setVariableSchema` (Zod)                                 | ✅                            | 🟡 (RPT has a native JSON-Patch + Zod schema engine for MVU `stat_data`, but not exposed as these template helpers)                              |
| `getwi` / `getWorldInfoData` / `activewi`                                                            | ✅                            | 🟡 `getwi` ✅ (entry content); `getWorldInfoData`/`activewi` ⬜                                                                                  |
| `getchar` / `getCharData`                                                                            | ✅                            | ✅ `getchar(field)`                                                                                                                              |
| `getpreset` / `getqr`                                                                                | ✅                            | 🟡 `getPreset` → preset NAME only (not prompt content); `getqr` stub                                                                             |
| `getChatMessages` / `matchChatMessages`                                                              | ✅                            | 🟡 `getMessageHistory()` ✅; `matchChatMessages` ⬜                                                                                              |
| `define()` (persistent macros)                                                                       | ✅                            | ✅                                                                                                                                               |
| `injectPrompt` / `getPromptsInjected`                                                                | ✅                            | ⬜                                                                                                                                               |
| `[GENERATE:BEFORE/AFTER]`, `@INJECT`, `[GENERATE:REGEX:]`, decorators (`@@activate/@@if/@@iframe/…`) | ✅                            | ⬜ deferred (uncertain ST contract; verify first)                                                                                                |
| `faker`                                                                                              | ✅                            | 🟡 clean-room subset in the sandbox (number/float/bool/pick/uuid/name/word/lorem)                                                                |
| `lodash` (`_`) / `jQuery` (`$`)                                                                      | ✅                            | ⬜ `_` not in the template sandbox (only `faker`); `$` N/A (template engine, not DOM)                                                            |
| `[InitialVariables]` preload                                                                         | ✅                            | ✅ equivalent: `state_schema.defaults` ⊕ `[initvar]` blocks                                                                                      |
| Token/char counters (`LAST_SEND_TOKENS`, …)                                                          | ✅                            | 🟡 (cache read/write tokens logged; not exposed as template vars)                                                                                |

---

## 3. Script / card JS API (vs Tavern Helper → RPT `rpt` + WCV shim)

| Category                                                                 | Tavern Helper         | RPT (iframe `rpt` path)                                                                                                                    | RPT (WCV card path)                                                                               |
| ------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Variables** get/set/insert/replace/updateWith, scopes                  | ✅                    | ✅ local/global (message/char/script 🟡)                                                                                                   | ✅ (MVU `stat_data` + JSONPatch)                                                                  |
| **Chat** read (messages, last id)                                        | ✅                    | ✅                                                                                                                                         | ✅                                                                                                |
| **Chat** write (set/create/delete/rotate/swipes)                         | ✅                    | 🟡                                                                                                                                         | 🟡 (`SillyTavern.chat[]`+`saveChat`/`reloadCurrentChat`; greeting-swipe select ✅; full write ⬜) |
| **Worldbook** get/create/edit/delete entries                             | ✅                    | 🟡 read + **replace-all** (`rpt.lore.get/set`, gated `worldbook:read/write`) → add/remove/edit/toggle by read-modify-write; create/bind ⬜ | 🟡 read + **toggle only** (extend to full replace)                                                |
| `getCharWorldbookNames` / bind to char/chat                              | ✅                    | 🟡 names ✅, bind ⬜                                                                                                                       | ✅ names (sync); bind ⬜                                                                          |
| **Character card** read (`getCharData`, avatar)                          | ✅                    | ✅                                                                                                                                         | ✅                                                                                                |
| **Generation** `generate`                                                | ✅                    | ✅ (per-card grant)                                                                                                                        | 🔁 stub (bring host-side generate to the shim)                                                    |
| `generateRaw` / `stop` / stream-token events                             | ✅                    | ⬜                                                                                                                                         | ⬜                                                                                                |
| **Regex** `getTavernRegexes` / `replace` / `formatAsTavernRegexedString` | ✅                    | 🟡 (`scriptApiService` format/list)                                                                                                        | ⬜ (wire into shim)                                                                               |
| **Events** `eventOn/Once/Emit/MakeFirst/RemoveListener`                  | ✅                    | ✅                                                                                                                                         | ✅ (local bus + MVU lifecycle)                                                                    |
| Full `tavern_events` enum mapped to pipeline                             | ✅                    | 🟡 subset                                                                                                                                  | 🟡 subset                                                                                         |
| **Audio** background music / SFX API                                     | ✅                    | ⬜                                                                                                                                         | ⬜ (cards load audio directly under the CSP)                                                      |
| **Slash / STScript** command set, pipes, closures                        | ✅                    | 🟡 small registry + built-ins                                                                                                              | 🔁 `triggerSlash` stub                                                                            |
| **Embedded interactive HTML / 前端卡**                                   | ✅ (same-page iframe) | ✅ (sandboxed iframe + mini-`$().load`)                                                                                                    | ✅ **out-of-process WCV** (the chosen path)                                                       |
| `rpt.storage` (per-owner KV), `rpt.net` (allow-listed fetch)             | ~ (TH has its own)    | ✅                                                                                                                                         | 🟡                                                                                                |

---

## 4. Where RPT is BEHIND (priorities)

- **ST-PT templating long tail** (narrower than first assessed — `getchar`/`getwi`/`getMessageHistory`/
  `define`/`faker`/`<%#` are already done; see [docs/st-prompt-template-plan.md](st-prompt-template-plan.md)):
  render-time eval on AI output, the `[GENERATE/RENDER/INJECT]` markers + decorators, dedicated
  message/character scopes, accessor depth (`getpreset` content, `getWorldInfoData`/`activewi`,
  `injectPrompt`), `lodash` in the sandbox, and the `EjsTemplate` API surface.
- **TH JS API in the WCV shim**: lorebook **CRUD** (not just toggle), chat **write**, **regex** API,
  host-side **generate**, the full `tavern_events` enum, audio API. (Most are backed by an existing
  service — the work is wiring the WCV shim method + a ctx-scoped IPC handler. See
  [docs/rpt-api.md](rpt-api.md).)

## 5. Where RPT is AHEAD (its own design)

- **Out-of-process card isolation** — card UIs run in a `WebContentsView` (separate process); a broken
  card can't freeze the app. ST/TH run frontend cards in same-page iframes (same renderer).
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
lorebooks, regex, and presets. The compatibility _gaps_ are the ST-PT template long-tail and the deeper
TH JS API — both clean-room, both backed by services that already exist, so closing them is wiring work,
tracked under **Track C0** + the **TH-parity audit** in [ROADMAP.md](../ROADMAP.md).
