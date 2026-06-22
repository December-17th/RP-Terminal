# Plan — ST-Prompt-Template engine (remaining work)

How to finish RP Terminal's ST-Prompt-Template compatibility. The engine
([`templateService.ts`](../src/main/services/templateService.ts)) is a quickjs-WASM EJS engine, applied
at prompt-build time in `promptBuilder`. **It's much more built than the comparison doc first implied** —
this plan targets the *actual* gaps. Clean-room throughout (reimplemented from the public docs:
[features](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/features.md) /
[reference](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/reference.md)).

## Status (2026-06-22)
**The engine is built and Phase A is complete.** This session, each step tested (`npm test` — now 278) +
typechecked + built + committed:
- `61be977` — the engine is **togglable** (`settings.templates.enabled`, default on). Off → EJS tags are
  **stripped** (not passed through); `{{macros}}` still expand. Gate lives in `evalTemplate`
  (`ctx.enabled === false → stripTags`), wired from `generationService` + a `SettingsPanel` checkbox.
- `6bb72f1` — clean-room **`lodash` (`_`) subset** (dot-path `get/set/has/keys/…/merge/pick/omit`) +
  no-op **`console`** in the sandbox boot (mirrors the existing `faker`).
- `d7daeb3` — **`matchChatMessages`** (regex over history), **`parseJSON`** (lenient → null),
  **`jsonPatch`** (RFC-6902 via `mvuParser`) + constants **`chatId`/`characterId`/`runType`**.
- `dbfa368` — **`getWorldInfoData(name)`** (raw matched entry) + **`getWorldInfoActivatedData()`**.
- `2a8a955` — **`getPreset(name)`** → the named prompt block's content in the active preset (name /
  identifier / regex match), analyzed from ST-PT `src/function/presets.ts`.

**Next: Phase C (render-time)** — approach decided (full EJS in the renderer, rate-limited). `injectPrompt` +
`activewi` are deferred to **Phase D** (prompt-injection, the same machinery as the markers). Phase B collapses
into Phase C. Details below.

## Already done (verified in code)
- EJS syntax: `<% %>` / `<%= %>` / `<%- %>`, **`<%# comment %>`**, `<%_`/`_%>` whitespace trim.
- Variables: `getvar`/`setvar`/`incvar`/`decvar`/`delvar` + `local`/`global`/`message`/`chat` scope aliases.
- Accessors: `getchar(field)`, `getwi(name)`, `getMessageHistory()`, `getCurrentChatName()`, `getPreset()`, `getqr()` (stub).
- `define(name, value)`, a clean-room **`faker`** subset, `variables` + the constants (`userName`/`charName`/`lastUserMessage`/…).
- Per-profile global persistence; **fail-safe**: any template error strips the tags so generation never breaks.

## Remaining gaps → phased plan

### Phase A — Accessor depth + libs (low-risk wiring, do first)
All backed by existing services / the build context; each is a `reg(name, fn)` in `installBridge` + a value
in `TemplateData`/`constants`.
- ✅ `getPreset(name)` → the named prompt block's content in the active preset (name/identifier/regex match; analyzed from ST-PT `presets.ts`).
- ✅ `getWorldInfoData(name)` (raw matched entry) + `getWorldInfoActivatedData()` (the activated set).
- ✅ `matchChatMessages(pattern)`, `parseJSON()` (lenient), `jsonPatch()` (via `mvuParser`).
- ✅ Constants `chatId`/`characterId`/`runType` (more — `charLoreBook`, token counts — as needed).
- ✅ **`lodash` (`_`) subset + no-op `console`** in the sandbox (mirrors `faker`).
- ➡️ `injectPrompt` + `activewi` MOVED to **Phase D** — they're prompt-INJECTION (writes), the same machinery as the markers, not standalone reads.

**Phase A is complete** (clean reads/libs/constants).

### Phase B — Dedicated variable scopes → **folds into Phase C**
Re-checking the reference: the **template engine's scopes are `local`/`global`/`message`** — `character`/
`script` are TavernHelper-JS-API scopes, *not* the engine. `local`/`global` already have real stores
(chat vars + per-profile globals). The only real gap is a true **`message`** scope — and message vars are
*per-message*, a context RPT only has at **render time**. So "dedicated message scope" is implemented as
part of **Phase C (C2)**, backed by the floor's `variables`. There is no standalone Phase B.

### Phase C — Render-time evaluation (DETAILED DESIGN) — ✅ **implemented** (pending visual check)
ST-PT evaluates templates on **AI output** too (`[RENDER:BEFORE/AFTER]`, `@@render_*`, `<%- %>`).

**Decision (locked):** run the **full EJS engine in the RENDERER** for both modes, **rate-limited** — eval
the accumulated text **every N tokens (default 500, user-adjustable)** rather than per-token — plus an
**optional final pass** when the stream ends.

**Renderer-side proved out (runtime spike, since removed).** quickjs runs in the renderer, with two fixes the
spike surfaced: (1) the Vite **dev server mis-serves** the wasmfile `.wasm` (returns index.html → bad magic
bytes), so the renderer uses the **singlefile** variant `@jitl/quickjs-singlefile-browser-release-sync` (WASM
embedded as base64 → no fetch; works in dev + prod, and keeps the wasmfile `.wasm` out of the renderer build);
(2) the app CSP needed **`'wasm-unsafe-eval'`** (permits WASM compile, not JS eval). The engine is now
variant-agnostic (`initEngine(loader)`): `src/shared` imports only quickjs *types*; main injects the wasmfile
variant, the renderer injects the singlefile one (`rendererEngine.initRendererEngine`).

**Two modes (same renderer engine):**
- **(i) Live / render-as-it-goes** — during streaming, re-eval the accumulated text **every N tokens** (the
  rate limit; default 500) so the displayed partial reflects the template. Maps to ST-PT `runType: 'render'`
  — **transient**: re-derived each pass, never persisted.
- **(ii) Final pass (optional)** — one eval when the stream completes. Plain → the last transient render.
  "Permanent" variant (own toggle) → ST-PT `render_permanent`: the rendered text **replaces the stored floor
  response once** (original model output preserved by default, so this is opt-in).

**Architecture — a shared engine (the key refactor, C1):**
- **C1 ✅ — extracted the core engine to `src/shared/templateEngine.ts`.** Moved the pure pieces out of
  `templateService.ts`: `initEngine` (loads quickjs), `compile` (EJS→JS), `installBridge` (the `reg()`
  helpers), `evalTemplate`, and the path / `hasTags` / `stripTags` helpers. Both processes import it.
  - **`src/shared` must not import `src/main`.** The one main-coupled helper, `jsonPatch` (uses
    `mvuParser`), is registered by `templateService` **after** the shared bridge — kept out of the shared
    module. Render-time templates rarely need it.
  - `templateService.ts` keeps the node-coupled parts (global persistence `loadGlobals`/`saveGlobals`, the
    `TemplateData` build wiring) and **re-exports** `evalTemplate` / `initTemplates` / the types, so existing
    imports + the 278 tests stay unchanged (no regression). C1 is verifiable entirely in main.
- **C2 ✅ — renderer render-eval + stream hooks.**
  - `src/renderer/src/plugin/renderTemplate.ts` kicks off `initRendererEngine()` at app start, builds a render
    context from the stores (floor `variables` + `userName`/`charName`/`charData`), and evals message text
    gated by the toggles (master off → strip; render/mode off → raw). Engine errors fall back to raw text.
  - **Final pass** — wired into `ChatView`'s `renderedFloors`: each stored response runs EJS → macros →
    display regex (the floor's `variables` = the `message` scope, so Phase B is realized here).
  - **Live pass** — `StreamingView`: rate-limited via a quantized `checkpoint` `useMemo` dep (no per-frame
    eval, no refs-in-render); shows the rendered head + the raw tail so text keeps flowing. Uses the latest
    committed floor's vars (the in-flight floor isn't folded yet).
- **C3 ✅ — settings.** `templates.render = { enabled, live, rate_tokens: 500, final_pass }` (models + service
  default/normalize + renderer store); nested controls under the engine toggle in `SettingsPanel`.
  *(The `render_permanent` overwrite — rewriting the stored floor — is **deferred**; the final pass is
  transient/display-only, preserving the raw model output.)*

**Sub-step order:** C1 ✅ → runtime spike ✅ → C2 ✅ → C3 ✅. Built + committed (`81e5f92`, `55239a1`,
`9bcc7b0`, `ff12979`). Remaining: a visual check in the running app, then the deferred `render_permanent`
overwrite (opt-in, rewrites the stored floor).

### Phase D — Injection markers + decorators
**Step 0 — source analysis (DONE; from ST-Prompt-Template `src/features/inject-prompt.ts` +
`src/modules/handler.ts`).** The contract:

- **The markers are WORLD-INFO ENTRIES, not inline card text.** An entry whose `comment` (title) IS a
  marker — e.g. `[GENERATE:BEFORE]` — or whose `decorator` is the `@@` form — `@@generate_before` — has its
  CONTENT (an EJS template) injected at that position. In RPT terms: a **lorebook entry** titled/decorated
  as a marker → inject its (template-evaluated) content at the computed spot.
- **Marker → position:** `[GENERATE:BEFORE]`/`@@generate_before` → start of the FIRST message;
  `[GENERATE:AFTER]`/`@@generate_after` → end of the LAST; `[GENERATE:{idx}:BEFORE/AFTER]`/
  `@@generate_before|after {idx}` → before/after message `idx`; `[RENDER:BEFORE/AFTER]`/`@@render_before|after`
  → before/after the rendered message HTML (Phase C).
- **`@INJECT`** (separate; also a WI-entry `comment` prefix): `role=`, `pos=` (1-based; `0`=prepend, negative
  = from end), `target=`+`index=`+`at=before|after` (relative to the nth message of a role), `regex=` (inject
  before/after the first matching message), `order=` (tie-break). Applied **back-to-front** (finalPos desc, then order).
- **runType gates timing:** `generate` (build) → `[GENERATE:*]`; `preparation` (preload) → `[GENERATE:BEFORE/
  AFTER]` only, skips `@@dont_preload`; `render` → `[RENDER:*]`; `render_permanent` → rewrites `message.mes`
  once. Each gated by a setting (`generate_loader_enabled` / `render_loader_enabled` / `raw_message_evaluation_enabled`).
- **Decorators:** `@@private` wraps content in an IIFE scope; `@@dont_preload`/`@@dont_activate`/`@@only_preload`
  control activation; `@@generate_*`/`@@render_*` are the decorator form of the markers; `@@if`/`@@iframe`/`@@activate`.
- **Order:** preload WI → `[GENERATE:BEFORE]` → per message (`[GENERATE:idx:BEFORE]` + content + `[GENERATE:idx:
  AFTER]`) → `[GENERATE:AFTER]` → (display) `[RENDER:BEFORE]` + HTML + `[RENDER:AFTER]`.

**Step 1 — implement in RPT (build-time markers DONE — `a6ca8cf` / `4986149` / `724d3dc`):**
- ✅ **D1** `src/main/parsers/injectMarkers.ts` — `parseEntryMarker(comment, content)` classifies an entry
  into a Generate/Render/Inject marker (or plain lore), strips `@@` decorator lines to the template body,
  reads activation (`@@activate`/`@@always_enabled`/`@@dont_activate`) + `@@private`. `markerIndex(marker,
  messages)` is the exact position math (from the ST-PT source).
- ✅ **D2/D3** `promptBuilder` partitions matched entries: plain lore → World Info/depth as before; marker
  entries are drained into message positions via `markerIndex` — `[GENERATE:BEFORE/AFTER/{idx}/REGEX]` +
  `@INJECT` (absolute/target/regex, default role system), spliced high→low so inserts don't shift later
  targets. `@@activate`/`@@always_enabled` force-activate unmatched marker entries; `@@private` wraps the
  content in a block scope; `@@dont_activate` drops it. +16 tests.
- ✅ **`[InitialVariables]` / `@@initial_variables`** (`80c7449`) — `mvuSchema.parseInitVars` recognizes them
  (seeds floor-0 `stat_data` via the existing `buildInitialStatData` → `createChat`); `parseEntryMarker`'s
  `initvars` kind keeps them out of the prompt.
- ✅ **`[RENDER:*]`** (`815159d`) — `collectRenderMarkers` (always-on render entries) → `getRenderMarkers` IPC
  → `ChatView` wraps each displayed message, every template re-evaluated with that floor's vars.
- ⬜ Moot/minor only: the preload decorators (`@@dont_preload`/`@@only_preload`/`@@preprocessing`) — RPT has
  no card-open preload phase; `@@if`/`@@iframe`/`@@message_formatting` are minor display niceties.

**Phase D is complete.** Verified against the example card (no markers used; safe), with the full
marker/decorator surface implemented + unit-tested.
- 🧪 **Tested against the example card (命定之诗, `0bd6360`):** all 469 lorebook entries are plain
  worldbuilding — the `[…]` comments are category labels, **not** markers (0 injection markers in the whole
  book), and 34 entries use **build-time EJS** (`getvar`/`getMessageVar` over `stat_data`, `<%_` trim). Phase
  D correctly leaves them as lore (no false positives). So `[RENDER:*]` / `[InitialVariables]` are **unused by
  this card** — deferred unless full ST-PT parity is wanted (they'd be built speculatively, with nothing to
  validate against).

### Phase E — The `EjsTemplate` API surface
For cards/scripts that call the extension directly (`globalThis.EjsTemplate.*` + exposing it through the WCV shim):
`prepareContext`, `evalTemplate`, `getSyntaxErrorInfo`, `allVariables`, `saveVariables`, `setFeatures`/`getFeatures`/`resetFeatures`, `refreshWorldInfo`, `compileTemplate`, `defines`, `initialVariables`. Mostly thin wrappers over the engine + the build data.

## Sequencing
**A ✅ → C (B folds in) → D → E.** A (reads/libs/constants) is done; B's only real gap (`message` scope) is
realized inside C. **C and D are the architectural pieces** (C is next); E is a thin compatibility cap.

## Decisions (answered)
1. **Render-time eval (Phase C):** **full EJS in the RENDERER**, both modes, **rate-limited** — eval every
   N tokens (**default 500**, adjustable), **not** per-token — plus an **optional final pass** at stream end
   (`render` transient; `render_permanent` opt-in). See Phase C for the full design.
2. **Injection markers (Phase D):** analyze the SillyTavern + ST-Prompt-Template source to establish the
   exact contract before implementing. See Phase D Step 0 (done — contract mapped).
3. **Scopes (Phase B):** the engine's scopes are `local`/`global`/`message`; only `message` was missing, and
   it folds into Phase C (render-time is where the per-message context exists). No standalone Phase B.
4. **`injectPrompt`/`activewi`:** deferred to Phase D — they're prompt-injection (writes), not reads.
