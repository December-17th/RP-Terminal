# Plan — ST-Prompt-Template engine (remaining work)

How to finish RP Terminal's ST-Prompt-Template compatibility. The engine
([`templateService.ts`](../src/main/services/templateService.ts)) is a quickjs-WASM EJS engine, applied
at prompt-build time in `promptBuilder`. **It's much more built than the comparison doc first implied** —
this plan targets the *actual* gaps. Clean-room throughout (reimplemented from the public docs:
[features](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/features.md) /
[reference](https://github.com/zonde306/ST-Prompt-Template/blob/main/docs/reference.md)).

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

### Phase B — Dedicated variable scopes
Today `storeFor` maps every non-global scope to the chat vars. Give `message` + `character` real stores:
- `message` scope → the floor's `variables` (persists with the message) — thread the active floor into `TemplateContext`.
- `character` scope → a per-card store (`profiles/<id>/template-char-<cardId>.json`, like globals).
- Persist both on the build path (like `saveGlobals`).

### Phase C — Render-time evaluation — **TWO modes (decided)**
ST-PT evaluates templates on **AI output** too (`[RENDER:BEFORE/AFTER]`, `@@render_*`, `<%- %>`). Both
timings are required:
- **(i) Render-as-it-goes** — eval on each streaming chunk so the displayed partial reflects the template
  LIVE. Favors a **renderer-side** eval (per-chunk IPC to main would be too chatty).
- **(ii) Render-on-complete** — eval the finished response once (renderer engine, or main via IPC). Maps
  to ST-PT `runType: 'render'` (transient) vs `'render_permanent'`.

Likely shape: a small **renderer-side quickjs render-eval** reusing the `installBridge` helpers (the build
data pushed to the renderer), driven by the streaming/finalize hooks in `StreamingView`/`ChatView`, with a
per-mode flag. (The main engine stays the prompt-build path.)

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

**Step 1 — implement in RPT:** carry markers on the **lorebook entry** (the `comment` already exists; add a
`decorators` field); in `promptBuilder`, after normal assembly, drain marker entries into their positions
(reuse `matchAcross` for activation + `evalTemplate` for the content); `[RENDER:*]` entries feed Phase C;
`@INJECT` is the positional injector (back-to-front).

### Phase E — The `EjsTemplate` API surface
For cards/scripts that call the extension directly (`globalThis.EjsTemplate.*` + exposing it through the WCV shim):
`prepareContext`, `evalTemplate`, `getSyntaxErrorInfo`, `allVariables`, `saveVariables`, `setFeatures`/`getFeatures`/`resetFeatures`, `refreshWorldInfo`, `compileTemplate`, `defines`, `initialVariables`. Mostly thin wrappers over the engine + the build data.

## Sequencing
**A → B → C → D → E.** A and B are low-risk wiring + the highest value-per-effort; C and D are the
architectural pieces gated on the decisions below; E is a thin compatibility cap.

## Decisions (answered)
1. **Render-time eval (Phase C):** TWO modes — render-as-it-goes (during streaming) + render-on-complete.
   Leans renderer-side (streaming can't afford per-chunk IPC). See Phase C.
2. **Injection markers (Phase D):** analyze the SillyTavern + ST-Prompt-Template source to establish the
   exact contract before implementing. See Phase D Step 0.
