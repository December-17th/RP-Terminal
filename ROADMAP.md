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

## Phase A — Make RP usable (P0)  🚧

- ✅ **A1. Streaming responses** — SSE for OpenAI + Anthropic; deltas over an IPC event
  channel; live text rendered for generate + regenerate.
- ✅ **A2. Message actions** — regenerate + delete-from-here. *(swipe/edit: ⬜ follow-up)*
- ⬜ **A3. Token budget + truncation** — keep system + recent N, drop/condense oldest
  so long sessions don't overflow the context window. *(next focused pass)*
- ✅ **A4. Persona / user name** — `settings.persona.name` wired into `{{user}}`.
- ✅ **A5. Delete sessions/characters** + refresh chat list after generate.
- ✅ **A6. Per-provider trailing-message fix** — drop trailing assistant prefill on the
  OpenAI-compatible path (fixes Claude/Bedrock-proxy 400s).
- ✅ **Extra: session preview panel** — session list shows the latest floor's opening text.

Remaining in Phase A: **A3 (token budget)**, swipe/edit messages.

---

## Phase B — The visual thesis (P0/P1)  ⬜

- ⬜ **B1. Safe HTML render pipeline** — DOMPurify + `rehype-raw` (or sandboxed iframe)
  so card/regex-authored HTML renders; apply card `css` scoped to the chat. This is
  what makes imported `美化` cards look like SillyTavern.
- ⬜ **B2. Regex engine fidelity + management UI** — honor `trimStrings`,
  `markdownOnly`/`promptOnly`, placement, and macro substitution in replacements;
  add regex import + a management panel (mirrors lorebook/preset).

## Phase C — ST-Prompt-Template + advanced preset/lorebook (P1)  ⬜

- ⬜ **C1. EJS-style template engine** — `getvar`/`setvar`/`getwi`/`define` bound to
  `floor.variables`; integrate into `promptBuilder` (replaces today's strip-only stub).
- ⬜ **C2. Preset fidelity** — depth-injected prompts, more markers, per-prompt injection
  position; bind preset params ↔ provider request.
- ⬜ **C3. Lorebook advanced** — insertion position/depth, probability, recursion,
  configurable scan depth; standalone lorebook import/export; multiple books.

## Phase D — Agentic mode (P2, design doc first)  ⬜

- ⬜ **D1. Tool/function-calling loop** — state read/write, lorebook query, dice/RNG,
  sub-generation; explicit stop conditions.
- ⬜ **D2. State-schema + widget editor UI**; richer status widgets.

## Phase E — Quality (ongoing)  ⬜

- ⬜ Tests for pure modules (png/preset/regex parsers, promptBuilder, lorebook
  matching, event folding).
- ⬜ Virtualize the floor list (`react-virtuoso` already a dep).
- ⬜ Remove dead code (`Modal.tsx`, unused `lorebooks` dir); unify shared types.

---

## vNext — CRPG / Visual-Novel engine (Phase F+)

A larger evolution toward a "game cartridge + console" client. Builds on the
existing foundation (Electron shell, provider/streaming layer, prompt builder,
card schema, rpt-event, logs) — additive, not a rewrite.

### Locked stack decisions
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

### Phase F — Relational storage (SQLite)  ✅
- Migrated JSON-per-record to **`better-sqlite3`** (externalized + rebuilt for
  Electron): tables profiles, settings, presets, characters, lorebooks,
  lorebook_entries, chats, floors (+ forward-facing rpg_entities,
  episodic_memory). WAL + FKs; one DB with FKs (not per-session files).
- One-time, atomic, idempotent JSON→SQLite migration on first run.
- *Packaging note:* native `.node` must be asar-unpacked when building installers
  (verify `electron-builder` auto-unpack at Milestone packaging).

### Phase G — Four-layer prompt-cache assembly  ⬜
- Rebuild prompt assembly into immutable layers for provider prompt caching:
  L1 static core (byte-identical every turn), L2 semi-static lore/memory,
  L3 rolling history, L4 volatile state appended at the very bottom.
- Map L1–L2 onto Anthropic `cache_control` breakpoints / OpenAI prefix caching.
  *(Verify exact breakpoint count + TTL against current provider docs.)*

### Phase H — Manual FSM modes + persona expansion  ⬜
- **Manual mode switch** (Explore / Dialogue / Combat) in the UI; each mode tunes
  output-token ceiling, retrieval breadth, and granularity.
- **Optional** auto-routing: a user-configured cheap API classifies intent. Off
  by default; manual is the baseline.
- Expand the decoupled global persona with concrete sensory-grounded attributes.

### Phase I — Combat math engine + append-only injection  ⬜
- Sandboxed scripting (`isolated-vm` or `quickjs-emscripten`, **not** node `vm`)
  in a worker; scripts read/write entity state and do RNG/math.
- LLM becomes flavor-only; results injected as a compact event block at the
  bottom of the prompt (L4) to preserve the cache.

### Phase J — Multi-lorebook + protection/mutation (keyword-based)  ⬜
- Load multiple books per session; per-entry/-book toggles; live mid-session
  edit. Keyword matching (no embeddings required).
- Protected/unprotected entries; model tool-requests mutate unprotected lore via
  a backend gatekeeper; deferred injection at the next mode transition.

### Phase K — Optional embeddings + RAG + auto-routing  ⬜  *(opt-in)*
- User-configured embedding API; vector store via `sqlite-vec`. Episodic memory
  summarization + retrieval. Strictly additive to keyword lorebooks; off unless
  the user enables and configures it.

### Phase L — PNG cartridge + recommended settings  ⬜
- Extend the importer to unpack a ZIP appended after the PNG `IEND` (manifest,
  `ui_schema`, `memory_schema`, bundled lorebooks, scripts). Add export/packing.
- Card-provided **recommended settings** that optionally auto-tune client
  thresholds/limits on load (always user-overridable).

### Phase M — The Forge (authoring tool)  ⬜  *(last)*
- In-app workspace using user-configured text/vision APIs to generate schemas,
  UI layouts, and sandboxed scripts from natural language; preview canvas; pack
  to a cartridge PNG.

---

## Known issues / security

- `sandbox: false` + rendering untrusted card HTML is an XSS surface — must land
  DOMPurify + a sandbox model *with* B1, not after.
- ST-Prompt-Template `<% %>` blocks are currently stripped, not evaluated (C1).
- Combat/Forge scripts run untrusted author code — require a real JS sandbox
  (`isolated-vm`/`quickjs`), never node `vm` (Phase I).
