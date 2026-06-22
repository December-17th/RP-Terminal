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

### Phase C — Render-time evaluation **(needs a decision — see below)**
ST-PT also evaluates templates on **AI output** (`[RENDER:BEFORE/AFTER]`, `@@render_*`, `<%- %>` at render).
The engine is **main-side** (quickjs); display is **renderer-side + sync**. Options:
- **(a) IPC eval bridge** — the renderer calls main to eval the response template, then re-renders. Async; one extra round-trip per message render.
- **(b) Renderer-side engine** — a second quickjs instance in the renderer (or the sandbox iframe) evaluating at render. Keeps it sync-ish; duplicates the engine.
- **(c) Macro-only** — keep the existing render-time macro pass (covers `{{getvar}}` etc.); skip full EJS at render.

### Phase D — Injection markers + decorators **(verify the ST contract first)**
Positional prompt injection + world-info activation control, implemented in `promptBuilder` + the WI matcher:
- `[GENERATE:BEFORE/AFTER]`, `[GENERATE:{idx}:BEFORE/AFTER]`, `[GENERATE:REGEX:pattern]`, `@INJECT pos/target/regex`.
- Decorators: `@@activate`, `@@if`, `@@generate_before/after`, `@@render_before/after`, `@@iframe`, `@@private`, `@@dont_activate`, `@@dont_preload`, `@@only_preload`, `@@message_formatting`.
- ROADMAP flags the exact ST semantics as uncertain — **confirm behavior against ST-PT before building.**

### Phase E — The `EjsTemplate` API surface
For cards/scripts that call the extension directly (`globalThis.EjsTemplate.*` + exposing it through the WCV shim):
`prepareContext`, `evalTemplate`, `getSyntaxErrorInfo`, `allVariables`, `saveVariables`, `setFeatures`/`getFeatures`/`resetFeatures`, `refreshWorldInfo`, `compileTemplate`, `defines`, `initialVariables`. Mostly thin wrappers over the engine + the build data.

## Sequencing
**A → B → C → D → E.** A and B are low-risk wiring + the highest value-per-effort; C and D are the
architectural pieces gated on the decisions below; E is a thin compatibility cap.

## Decisions needed
1. **Render-time eval approach (Phase C)** — (a) IPC bridge, (b) renderer-side engine, or (c) macro-only.
2. **Injection markers (Phase D)** — tackle now (after verifying the ST contract) or defer (ROADMAP currently defers them).
