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

## Known issues / security

- `sandbox: false` + rendering untrusted card HTML is an XSS surface — must land
  DOMPurify + a sandbox model *with* B1, not after.
- ST-Prompt-Template `<% %>` blocks are currently stripped, not evaluated (C1).
