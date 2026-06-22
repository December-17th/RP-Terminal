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
- `getPreset(name)` → the preset's **prompt content** (today it returns only the name) — via `presetService`.
- `getWorldInfoData(name)` (raw entry) + `getWorldInfoActivatedData()` (keyword-activated entries) — via `lorebookService`.
- `injectPrompt(key, content, position)` / `getPromptsInjected` / `hasPromptsInjected` — a per-build injection registry drained in `promptBuilder`.
- `matchChatMessages(pattern)`, `parseJSON()` (lenient), `jsonPatch()` (reuse `mvuParser`).
- More **constants**: `runType`, `chatId`, `characterId`, `charLoreBook`/`userLoreBook`/`chatLoreBook`, `LAST_SEND_TOKENS`/`LAST_RECEIVE_TOKENS` (from the build context).
- A clean-room **`lodash` (`_`) subset** in the sandbox (mirrors the existing `faker` injection).

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

### Phase D — Injection markers + decorators — **analyze the source first (decided)**
**Step 0 — read the source** (SillyTavern's prompt assembly + ST-Prompt-Template's marker/decorator
implementation) to pin down the EXACT contract before writing any code: positions/ordering, the
regex-target semantics, decorator precedence, and the world-info activation effects. THEN implement in
`promptBuilder` + the WI matcher.
- `[GENERATE:BEFORE/AFTER]`, `[GENERATE:{idx}:BEFORE/AFTER]`, `[GENERATE:REGEX:pattern]`, `@INJECT pos/target/regex`.
- Decorators: `@@activate`, `@@if`, `@@generate_before/after`, `@@render_before/after`, `@@iframe`, `@@private`, `@@dont_activate`, `@@dont_preload`, `@@only_preload`, `@@message_formatting`.

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
