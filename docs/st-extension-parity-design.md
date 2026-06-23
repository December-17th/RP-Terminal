# SillyTavern-Extension Feature Parity — Implementation Plan (Track TH)

Status: **Shipped (TH-1…TH-8).** Goal: close the gaps from the ROADMAP "ST-extension
feature-parity audit" so RP Terminal matches the feature set of **Tavern Helper**
(js-slash-runner) and **ST-Prompt-Template**. Sequenced by dependency + value into increments
TH-1…TH-8, each shipped as its own commit with typecheck + the Vitest suite green.

**Implemented:**

- **TH-1** `0062350` — canonical `tavern_events` enum + emit (GENERATION/MESSAGE/CHAT/
  STREAM), `eventMakeFirst/Last/WaitFor/RemoveListener/Once`, stream-token forwarding.
- **TH-2** `6b174ff` — swipes (alternate responses) end-to-end; variable scopes
  message/character/script + insert/delete; message script API (get/set/create/delete);
  MESSAGE_UPDATED/SWIPED/DELETED diff events.
- **TH-3** `f147f67` — card/worldbook/preset/regex read+CRUD script API; template helpers
  getchar/getwi/getMessageHistory/getCurrentChatName/getPreset, `<%# %>` fix, define, faker.
- **TH-4** `abcbc4c` — generateRaw (non-persisted, cache-safe), stopGeneration, image hook.
- **TH-5** `fa5394c` — shared macro engine ({{getvar/setvar/roll/random/pick/…}}); fixed the
  macros→EJS→regex order (templates ran through the builder for the first time); render-time
  macro pass on output.
- **TH-6** `627071e` — embedded interactive HTML in messages (frontend cards) at least
  privilege; reuses the card-script sandbox + runtime events.
- **TH-7** `62f8ddc` — audio API (BGM + SFX) behind an `audio` cap.
- **TH-8** `d9880e4` — STScript subset: pipes / closures / named args / `{{pipe}}` + built-ins.

**Deferred (noted in commits):** `[GENERATE:BEFORE]/[GENERATE:AFTER]` + `@INJECT` positional
markers (uncertain ST contract); render-time **EJS** on output (quickjs engine is main-side —
render-time macros cover the common cases); STScript while/loops + the long-tail command set.

**Hard constraint (unchanged):** clean-room only — reimplement the API _surface and behavior_
from public docs/observed behavior; **never** copy js-slash-runner code (AGPL). ST-Prompt-Template
is already a clean-room engine (`templateService`); we extend it the same way.

---

## 1. Architecture seams (where each feature lands)

The parity work threads through five existing seams — no new architecture:

- **Script API** — a new method case in `dispatchRpc` (`src/renderer/src/plugin/dispatch.ts`),
  gated by `ctx.ensure(<perm>)`, plus a thin `rpt.*` wrapper in `BRIDGE_SHIM` and a TH-name alias
  in `TAVERN_SHIM`; the case forwards to an **IPC handler** (`index.ts`) → the owning **service**.
- **Events** — new `emit(name, payload)` points (mostly in `CardScriptHost`'s store subscription +
  `generationService`), with the ST `tavern_events` names mapped in `TAVERN_SHIM`.
- **Template helpers** — new `reg(name, fn)` registrations in `templateService.installBridge`.
- **Prompt assembly** — new passes in `promptBuilder` (macros, GENERATE markers, @INJECT).
- **Render** — message-embedded HTML reuses `buildScriptSrcDoc`; audio is a small renderer service.

Permissions: reuse the card-script auto-grant model (`ensure` returns true for low-risk caps,
prompts for sensitive ones). New sensitive caps: `chat:write`, `worldbook:write`, `audio`.

---

## 2. Phased plan

Effort: S(<½ day) · M(1–2 days) · L(3–5 days) · XL(>1 week). Each phase ends with Vitest for its
pure logic + a commit.

### TH-1 — Event backbone (foundational) · M

The reactive substrate everything else leans on. Today we emit `generation:start/end`,
`chat:changed`, `mag_*`. Deliver:

- A canonical `tavern_events` enum mapped onto our pipeline: `GENERATION_STARTED/ENDED`,
  `MESSAGE_SENT/RECEIVED/UPDATED/DELETED/SWIPED`, `CHAT_CHANGED`, `STREAM_TOKEN_RECEIVED`.
- Emit `STREAM_TOKEN_RECEIVED` by forwarding `apiService` deltas (already on the
  `generation-delta` channel) into `CardScriptHost.emit`.
- `eventWaitFor(name)` (promise), `eventMakeLast`/`eventMakeFirst` ordering.
- **Why first:** generation/message/stream reactivity (TH-2, TH-4) and most front-end scripts
  depend on it; high leverage, contained.

### TH-2 — Message + variable model · L

The data model scripts manipulate; also lands the deprioritized **message swipes**.

- **Chat message script API** over the floor model (a flattened message view):
  `getChatMessages(range, opts)`, `setChatMessages` (edit), `createChatMessages` (insert),
  `deleteChatMessages`, `rotateChatMessages` (swipes). Swipes add an alternate-responses array to
  the floor schema (`floorService`/`chat.ts`) + UI swipe arrows.
- **Variable scopes**: add `character` (bound to card id), `message` (per-floor, persisted with the
  message), and `script` (≈ existing `rpt.storage`) to the local/global model; add
  `insertVariables` (no-overwrite) + `deleteVariable`.
- Emits the TH-1 message events on each mutation.
- **Why second:** unblocks message-scope templates (TH-3/5) and is the highest-touch data change.

### TH-3 — Read/CRUD API batch (lorebook · card · preset · regex) + template helpers · L

High compatibility value, lower risk — mostly wiring existing services to the dispatch + template
bridge.

- **World-Info/lorebook script API** (`lorebookService`): read (`getWorldbook`, entries),
  CRUD (`createWorldbook`/entries, edit, delete), `getCharWorldbookNames`/`getChatWorldbook`,
  bind/unbind. Gate writes behind `worldbook:write`.
- **Character-card** (`getCharData`, `getCharAvatarPath`, history brief/length), **preset/settings**
  (`getPreset`/`setPreset`, sampler params + prompt order), **regex** (`getTavernRegexes`,
  `replaceTavernRegexes`, `formatAsTavernRegexedString`) script APIs over the existing services.
- **ST-Prompt-Template helpers** reusing the above: `getwi/getchar/getPreset/getqr`,
  `getMessageHistory()`, `getCurrentChatName()`, `define()`; plus the `<%# comment %>` tag and
  `faker` in the quickjs sandbox.
- **Why third:** big surface, batchable, builds confidence before the riskier generation/prompt work.

### TH-4 — Generation control · M

- `generateRaw(config)` — custom prompt injects, builtin-prompt overrides, sampler/max_tokens
  overrides; extend the `generate` IPC contract + `generationService` to accept an override config.
- `stopGeneration` — expose the existing `abortGeneration`.
- Image generation hook (provider-dependent; stub + one provider).
- (Stream-token events already shipped in TH-1.)

### TH-5 — Prompt-text features · M

- **Macro system**: a substitution pass for the ST built-ins + TH macros (`{{getvar::}}`,
  `{{get_message_variable::}}`, `{{roll}}`, `{{random}}`, `{{pick}}`, …) in prompts + messages — a
  pure `expandMacros(text, ctx)` run in `promptBuilder` and at render, reusing the var stores.
- **`[GENERATE:BEFORE]`/`[GENERATE:AFTER]`** injection markers + **`@INJECT`** (regex/position
  message insertion) in prompt assembly.
- **Render-time template evaluation** on AI output — a second `evalTemplate` pass at display.

### TH-6 — Embedded interactive HTML in messages ("前端卡") · L

Render `<script>`/HTML blocks _inside a chat message_ as sandboxed interactive iframes (distinct
from card-level scripts). Detect embedded blocks in a floor's response → mount per-block
`CardScriptHost`-style iframes via `buildScriptSrcDoc` (same sandbox, CSP, `rpt` API). Reuses TH-1/2
events so the embedded UI is reactive.

### TH-7 — Audio API · M

A small renderer audio service + `rpt.audio` (play/pause/stop BGM, one-shot SFX, playback modes),
gated by an `audio` cap. Self-contained; can slot anytime after TH-1.

### TH-8 — STScript slash-command language · XL (last)

A parser/interpreter for the ST slash-command language: the built-in `/command` set
(`/setvar /getvar /if /gen /trigger /send /addswipe /echo …`), pipes, and closures, over the
existing `slash` registry. Largest item, and partly obviated for power users by the JS API — so last.

- N/A throughout: direct ST DOM/jQuery manipulation (RP Terminal isn't ST; the `$` stub stays a stub).

---

## 3. Sequencing rationale

```
TH-1 events ──┬─> TH-2 messages/vars ──┬─> TH-3 read/CRUD APIs + template helpers
              │                        └─> TH-5 prompt-text (macros/inject/render-eval)
              └─> TH-4 generation control
TH-6 embedded HTML  (after TH-1/2)
TH-7 audio          (after TH-1, independent)
TH-8 STScript       (last)
```

Recommended order: **TH-1 → TH-2 → TH-3 → TH-4 → TH-5 → TH-6 → TH-7 → TH-8.** TH-7 (audio) is
independent and can be pulled earlier if desired; TH-6 (embedded HTML) is the marquee
visual-compat feature and could be pulled ahead of TH-4/5 if that compatibility is the priority.

---

## 4. Risks / decisions to resolve per phase

- **Floor↔message mapping (TH-2):** TH assumes a flat message list with swipes; we have floors
  (user+response). Decide the flattening contract (index = message index vs floor index) and the
  swipe schema before writing the API — it's the load-bearing model decision.
- **Generation overrides vs cache (TH-4):** `generateRaw` injects/overrides must not silently break
  the L1–L4 prompt-cache layering; keep overrides append-only / clearly-scoped.
- **Macro vs template overlap (TH-5):** macros (`{{…}}`) and EJS (`<% %>`) both transform text —
  define evaluation order (macros → EJS → regex) once, centrally.
- **Embedded-HTML trust (TH-6):** message HTML is model-authored (less trusted than card scripts) —
  keep the no-`allow-same-origin` sandbox; remote imports stay behind the per-world grant.
- **Scope creep (TH-8):** STScript is a language; timebox to the common command subset first, not
  full parity, and lean on the JS API for the long tail.

---

## 5. What we already have (so this is incremental)

The `rpt`/`TAVERN_SHIM` runtime (vars local/global, chat read, generate, toast, registerButton,
events on/emit, storage, slash run/register), the quickjs `templateService` (getvar/setvar/…),
the sandbox + permission model, the services for every data type, and the streaming pipeline.
Parity is filling in breadth on these seams, not new infrastructure.
