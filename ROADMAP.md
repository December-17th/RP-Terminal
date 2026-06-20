# RP Terminal — Roadmap

An Electron desktop app for sophisticated AI roleplay: SillyTavern-compatible
card/lorebook/preset import, fine-tuned chat-completion presets, ST-Prompt-Template
support, and (eventually) an agentic mode with polished per-card custom UI.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## Foundation (complete)

- ✅ Unified character card on a single Zod schema (`chara_card_v3`); legacy/foreign
  specs migrate on import; embedded `character_book` extracted to a lorebook.
- ✅ Generation centralized in main (`generationService` + `promptBuilder`): card +
  preset + lorebook + history → provider → ST regex → `rpt-event` parse → state fold
  → persisted floor. Renderer calls one `generate` IPC.
- ✅ Floor persistence/resume fixed (load all floors, maintain `floor_index`/
  `floor_count` via `appendFloor`, seed `first_mes` as floor 0).
- ✅ Ordered, marker-based preset model + SillyTavern preset importer.
- ✅ Lorebook keyword/constant/selective matching + injection.
- ✅ UI shell: top-nav tabs (Characters/Sessions/Preset/Lorebook/API) driving a
  tabbed left panel; center chat at ~50%; ST-style lorebook & preset editors.
- ✅ Build/typecheck green; provider call refactor.

---

## Phase A — Make RP usable (P0) 🚧

- ✅ **A1. Streaming responses** — SSE for OpenAI + Anthropic; deltas over an IPC event
  channel; live text rendered for generate + regenerate.
- ✅ **A2. Message actions** — regenerate + delete-from-here. _(swipe/edit: ⬜ follow-up)_
- ✅ **A3. Token budget + truncation** — CJK-aware token estimate; `fitToBudget` keeps
  the system/lore prefix + most-recent turns and trims the oldest history to a
  configurable `max_context_tokens` (API panel); trims are logged. _(condensing/
  summarizing dropped turns is a future refinement.)_
- ✅ **A4. Persona / user name** — `settings.persona.name` wired into `{{user}}`.
- ✅ **A5. Delete sessions/characters** + refresh chat list after generate.
- ✅ **A6. Per-provider trailing-message fix** — drop trailing assistant prefill on the
  OpenAI-compatible path (fixes Claude/Bedrock-proxy 400s).
- ✅ **Extra: session preview panel** — session list shows the latest floor's opening text.

Remaining in Phase A: message swipes (edit is done). Phase A is otherwise complete.

---

## Phase B — The visual thesis ✅ (core)

- ✅ **B1. Safe HTML render pipeline** — `MessageContent` splits ```html fenced blocks
and renders them in a **sandboxed iframe** (`sandbox="allow-same-origin"`, no scripts)
  with DOMPurify sanitization; CSS is fully isolated per card; auto-height via a
  ResizeObserver. Prose renders as GFM markdown. Card scripts are intentionally
  stripped (spec §3.3 — never execute imported scripts), so cards render statically.
- ✅ **B2. Render-time regex** — display regex now runs at render time (stored history
  keeps the model's raw output), with import + a Regex management panel (list/delete).
  ST `findRegex` `/…/flags` parsing, placement-2 (AI-output) filtering, `markdownOnly`
  vs `promptOnly` honored.
- ⬜ Remaining: per-rule enable/disable + edit in the panel; `trimStrings`; macro
  substitution inside replacements; prompt-time regex placement.

## Phase C — ST-Prompt-Template + advanced preset/lorebook (P1) ⬜

- ✅ **C1. ST-Prompt-Template engine** — EJS-style `<% %>`/`<%- %>`/`<%= %>` compiled to
  JS and run in a **quickjs-emscripten WASM sandbox** (fully isolated from Node/FS —
  verified the classic vm escape returns `undefined`). Helpers `getvar/setvar/incvar/
decvar/delvar` (+ local/global aliases) bound to chat vars; `variables`, `userName`,
  `charName`, `lastUserMessage/lastCharMessage` constants. Applied to authored content
  (system/char/lore/literal blocks) in `promptBuilder`; chat-var mutations thread into
  the new floor, global vars persist per profile (`template-globals.json`). Fail-safe:
  any error strips the tags so generation never breaks.
  - ⬜ Remaining (long tail): `getwi/getchar/getpreset/getqr`, message accessors,
    `define`, lodash/faker, prompt/regex injection — not yet bridged.
- ⬜ **C2. Preset fidelity** — depth-injected prompts, more markers, per-prompt injection
  position; bind preset params ↔ provider request.
- ⬜ **C3. Lorebook advanced** — insertion position/depth, probability, recursion,
  configurable scan depth; standalone lorebook import/export; multiple books.

## Phase D — Agentic mode (P2, design doc first) ⬜

- ⬜ **D1. Tool/function-calling loop** — state read/write, lorebook query, dice/RNG,
  sub-generation; explicit stop conditions.
- ⬜ **D2. State-schema + widget editor UI**; richer status widgets.

## Phase P — Plugin / extension system 🚧 (P1–P4 built)

Third-party plugins (js-slash-runner class). **Design doc:**
[docs/plugin-system-design.md](docs/plugin-system-design.md). Changes the threat
model to "run untrusted third-party code" — sandbox-by-construction is the crux.
Builds on existing primitives (B1 iframe sandbox, quickjs, vars engine, IPC) — a new
subsystem, not a rewrite. js-slash-runner is **not** installable as-is (it's a ST
extension bound to ST's runtime); we ship our own versioned API + a Tavern-Helper
compatibility shim.

- ✅ **D0. Design doc** — taxonomy (card scripts vs app extensions), manifest,
  `sandbox="allow-scripts"` iframe + postMessage RPC, permission model, `rpt.v1` API,
  slash/STScript-subset, compat-shim strategy, phased plan, open questions.
- ✅ **P1. Card-script runtime** — `sandbox="allow-scripts"` opaque-origin iframe
  (network-blocking CSP) + `rpt.v1` postMessage bridge: `vars`/`global` get/set/inc/dec/del,
  `chat.getMessages`/`getLastMessage`, `generate` (permission-prompted, per-card grant),
  `ui.toast`, and `on('ready'|'generation:start'|'generation:end'|'chat:changed')`. Runs
  `card.extensions.rp_terminal.scripts` in the right sidebar; local-var writes land on the
  latest floor and sync the status widgets live. Per-card enable toggle. `rpt.log` surfaces
  in the Logs panel. Mock card ships a demo script. (`pluginService` + `bridgeShim` +
  `CardScriptHost`.) In-app **Scripts** tab (`ScriptManager`) to add/edit/delete a card's
  scripts with live reload. Developer API reference: [docs/plugin-api.md](docs/plugin-api.md).
- ✅ **P2. Plugin host/loader** — Zod manifest + `plugins/<id>/` dir; folder
  install/update, uninstall, enable/disable with a permission-approval prompt;
  per-profile enable+grant state; **Plugins** tab. Standalone plugins run app-wide
  (headless) in the same sandbox via a shared RPC dispatcher with manifest-permission
  enforcement; bundled example scaffolder for testing.
  (`pluginHostService`, `pluginsStore`, `PluginHost`, `PluginsPanel`.)
- 🟡 **P3. App-extension contributions** — ✅ `rpt.ui.registerPanel`: a plugin gets a
  visible, titled, auto-sizing panel in the right sidebar (renders its own iframe UI;
  kept on a stable mount so iframes never reparent/reload). Example plugin ships a panel.
  ⬜ Remaining: `registerButton` (shell toolbar) + `registerCommand`.
- ✅ **P4. Slash-command runtime (subset) + Tavern-Helper shim** — `/name args`
  registry with built-ins (`/setvar`, `/getvar`, `/incvar`, `/setglobalvar`, `/echo`,
  `/gen`, `/help`), runnable from the chat box (`/` prefix) or via `rpt.slash.runCommand`;
  `rpt.slash.registerCommand` for plugin/script commands (sensitive `slash` perm).
  Clean-room `TavernHelper` shim maps the common TH surface onto `rpt.v1`. Example plugin
  ships a `/hello` command. (`slash.ts` + `bridgeShim`.) ⬜ Remaining: pipes/closures/macros
  (full STScript), broader TH coverage.
- ⬜ **P5. Packaging** (.zip / PNG cartridge), settings, opt-in `net`.
- ⬜ Open decisions (see doc §12): compat ambition, permission UX, distribution,
  network allowance, whether to allow app-extensions in v1.

## Phase E — Quality (ongoing) ⬜

- ⬜ Tests for pure modules (png/preset/regex parsers, promptBuilder, lorebook
  matching, event folding).
- ⬜ Virtualize the floor list (`react-virtuoso` already a dep).
- ⬜ Remove dead code (`Modal.tsx`, unused `lorebooks` dir); unify shared types.

## UX / polish

- ✅ **FPS / performance overlay** — toggleable bottom-right counter (`FpsOverlay`,
  rAF frame timing, color-coded), off by default, toggled from Settings.
- ✅ **Settings tab (left panel)** — dedicated tab with chat font size + FPS toggle
  (provider keys/persona/context stay in API). ⬜ Future: theme, auto-switch
  behavior, card "recommended settings" auto-apply (vNext).
- ✅ **Streaming perf fix** — stream deltas are coalesced to one render per rAF frame
  and the in-flight partial renders as plain text (markdown/HTML only on finalize),
  fixing the O(n²) re-render freeze (and the lock-up when backgrounded mid-stream).

## Licensing

- **License: undecided** (tentatively leaning AGPL-3.0). No `LICENSE` file or
  `package.json` `license` field set yet — pending the owner's decision.
- Provenance is recorded in `CLAUDE.md` → _Licensing & Attribution_: no third-party
  source is copied; the template engine is a clean-room reimplementation of
  ST-Prompt-Template (AGPL-3.0), and we are format-compatible with SillyTavern
  (AGPL-3.0) without using its code — so neither binds the license choice.
- Before release: choose a license, add the `LICENSE` file + `package.json` field, and
  run a dependency license audit (all current runtime deps are permissive — MIT/Apache/MPL).

---

## vNext — CRPG / Visual-Novel engine (Phase F+)

A larger evolution toward a "game cartridge + console" client. Builds on the
existing foundation (Electron shell, provider/streaming layer, prompt builder,
card schema, rpt-event, logs) — additive, not a rewrite.

### Locked stack decisions

- **Stay on Electron (not Tauri).** Tauri's Rust backend would force rewriting the
  whole Node engine (SQLite/quickjs/streaming/Zod) — or shipping a Node sidecar that
  negates Tauri's benefit — and its per-OS system WebView (esp. Linux WebKitGTK)
  would break the consistent card HTML/CSS/iframe rendering the visual thesis depends
  on. No planned feature needs Tauri (the plugin iframe sandbox is a web standard,
  identical on both). Framework choice is also irrelevant to the AGPL/license concern.
  Revisit only if small footprint becomes a hard requirement — and then via a
  Node-sidecar split, not a rewrite.
- **Node-only, single runtime.** No Python sidecar, no local ML models.
- **Main process = the engine.** No separate REST/WebSocket app; keep Electron
  IPC as the frontend↔backend bridge.
- **Heavy/blocking work → `worker_threads` / `utilityProcess`** (sandbox eval,
  later vector math) so the UI never janks. Decoupling without a second app.
- **All model calls go through user-configured APIs** — including the optional
  intent router and optional embeddings. Nothing runs a local model.
- **Keep React + Zustand**; solve big-history perf with virtualization
  (`react-virtuoso`) + a VN text buffer/pagination, not a framework swap.
- **Keyword-triggered lorebook stays the primary mechanism.** Vector RAG is an
  optional, additive layer — never a prerequisite.

### Phase F — Relational storage (SQLite) ✅

- Migrated JSON-per-record to **`better-sqlite3`** (externalized + rebuilt for
  Electron): tables profiles, settings, presets, characters, lorebooks,
  lorebook_entries, chats, floors (+ forward-facing rpg_entities,
  episodic_memory). WAL + FKs; one DB with FKs (not per-session files).
- One-time, atomic, idempotent JSON→SQLite migration on first run.
- _Packaging note:_ native `.node` must be asar-unpacked when building installers
  (verify `electron-builder` auto-unpack at Milestone packaging).

### Phase G — Four-layer prompt-cache assembly ✅ (increment 1)

- promptBuilder documents + enforces the L1 static core → L2 semi-static lore →
  L3 rolling history → L4 volatile (user action **always last**) layering, so the
  cacheable prefix is byte-stable across turns.
- Anthropic native path: `cache_control: {ephemeral}` breakpoints on the system
  block + the last pre-turn message (2 of the max 4; 5-min TTL); cache read/write
  token counts logged to the Logs panel for verification.
- OpenAI-compatible path relies on the provider's automatic prefix caching, which
  the stable-prefix assembly feeds (no markers in the OpenAI wire format).
- ⬜ Remaining: hold L2 (world info) stable across turns instead of re-matching
  every turn (needs FSM transitions, Phase H); Bedrock `cachePoint` passthrough.

### Phase H — Manual FSM modes + persona expansion ⬜

- **Manual mode switch** (Explore / Dialogue / Combat) in the UI; each mode tunes
  output-token ceiling, retrieval breadth, and granularity.
- **Optional** auto-routing: a user-configured cheap API classifies intent. Off
  by default; manual is the baseline.
- Expand the decoupled global persona with concrete sensory-grounded attributes.

### Phase I — Combat math engine + append-only injection ⬜

- Sandboxed scripting (`isolated-vm` or `quickjs-emscripten`, **not** node `vm`)
  in a worker; scripts read/write entity state and do RNG/math.
- LLM becomes flavor-only; results injected as a compact event block at the
  bottom of the prompt (L4) to preserve the cache.

### Phase J — Multi-lorebook + protection/mutation (keyword-based) ⬜

- Load multiple books per session; per-entry/-book toggles; live mid-session
  edit. Keyword matching (no embeddings required).
- Protected/unprotected entries; model tool-requests mutate unprotected lore via
  a backend gatekeeper; deferred injection at the next mode transition.

### Phase K — Optional embeddings + RAG + auto-routing ⬜ _(opt-in)_

- User-configured embedding API; vector store via `sqlite-vec`. Episodic memory
  summarization + retrieval. Strictly additive to keyword lorebooks; off unless
  the user enables and configures it.

### Phase L — PNG cartridge + recommended settings ⬜

- Extend the importer to unpack a ZIP appended after the PNG `IEND` (manifest,
  `ui_schema`, `memory_schema`, bundled lorebooks, scripts). Add export/packing.
- Card-provided **recommended settings** that optionally auto-tune client
  thresholds/limits on load (always user-overridable).

### Phase M — The Forge (authoring tool) ⬜ _(last)_

- In-app workspace using user-configured text/vision APIs to generate schemas,
  UI layouts, and sandboxed scripts from natural language; preview canvas; pack
  to a cartridge PNG.

---

## Known issues / security

- `sandbox: false` + rendering untrusted card HTML is an XSS surface — must land
  DOMPurify + a sandbox model _with_ B1, not after.
- ST-Prompt-Template `<% %>` blocks are currently stripped, not evaluated (C1).
- Combat/Forge scripts run untrusted author code — require a real JS sandbox
  (`isolated-vm`/`quickjs`), never node `vm` (Phase I).
