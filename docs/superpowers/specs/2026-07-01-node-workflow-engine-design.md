# Node Workflow Engine — Design & Spec

**Status:** Design (approved in brainstorming 2026-07-01; pre-implementation)
**Date:** 2026-07-01
**Author:** brainstormed with the owner
**Supersedes/relates:** replaces the fixed generation pipeline in `promptBuilder`/`generationService`
with a node-graph engine. Reuses the memory system (`docs/episodic-memory-design.md`), the prompt-cache
tail conventions (`docs/prompt-cache-optimization-design.md`), and the existing preset/regex/lorebook
resource pattern.

---

## 1. Goal & scope

Turn RP Terminal's generation from a hardcoded pipeline into a **ComfyUI-style node graph**: an editable,
branchable dataflow the user can see, rearrange, and extend with multi-step agentic behavior. The graph
*is* the program that runs each turn.

**In scope (the four capabilities that motivated this):**
1. **Multi-step LLM chains** — more than one model call per turn (planner / summarizer / draft→revise / judge).
2. **Visible, tweakable assembly** — see and rearrange how the prompt is built without editing code.
3. **Conditional branching** — route by state / mode / model output.
4. **Tools & retrieval nodes** — call retrieval, tools, and app actions as first-class nodes.

**Non-goals (v1):** loops/iteration (the graph is a DAG in v1; retry/iteration is a fast-follow),
card-embedded executable workflows (workflows are user-selected resources, never auto-run from a card),
and bundled local ML.

---

## 2. Core decisions (quick reference)

| # | Decision | Choice |
|---|---|---|
| D1 | Target surface | The generation/prompt pipeline **and** agentic automation, unified as one graph |
| D2 | Migration model | A built-in **default graph reproduces today's pipeline exactly** and becomes THE execution path (one code path, safe migration) |
| D3 | Node granularity | **Coarse stage-nodes**; rich detail lives as config *inside* nodes (edited in a side panel) |
| D4 | Turn output | **One `isMainOutput` node** streams to chat + writes the floor; any other node can opt into its own collapsible output panel |
| D5 | Memory | Decomposed into `memory.recall` / `memory.gate` / `memory.extract` / `memory.write` nodes |
| D6 | Phase rule | The **main-output node is the phase boundary**: upstream = pre-response (blocking); downstream = post-response (async, non-blocking) |
| D7 | LLM prompts | LLM nodes accept a role-tagged `Messages` value; a `prompt.messages` node authors back-and-forth system/user/assistant turns (with prefill) |
| D8 | Distribution | Workflows are a **preset-like resource** (`.rptflow`), user-selected per world/session; card creators may ship companion files (never embedded/auto-run) |
| D9 | Rate limiting | Per-`api_preset` **RPM limit**, enforced by an endpoint-keyed queue in `apiService` (delay, not drop) |
| D10 | Failure handling | **Author-controlled error branches** (each fallible node has an `error` port); unhandled + failed ⇒ abort turn surfaced. Per-node retry/backoff, fallback-connection, validator+corrective-retry run first |
| D11 | MVU triggers | `control.when` (predicate over `stat_data` + per-node persistent state) gates side-effect branches ending in `mvu.set` |
| D12 | Extensibility | Node **registry** + declared (zod) config schemas auto-rendered by the editor; extensible ports/operators; versioned docs + migrations |
| D13 | Engine approach | Our own pure main-process interpreter; built-in nodes delegate to existing services; React Flow (`@xyflow/react`, MIT) for the canvas only |

---

## 3. Architecture & module layout

Split across the existing process boundaries so it passes `check:deps` by construction:

- **`src/shared/workflow/`** — *pure* graph model + algorithms. `WorkflowDoc`/`NodeInstance`/`Edge`/`PortType`
  types, schema + graph validation, topological ordering, branch-prune resolution, port type-compatibility.
  No `main`/`renderer`/Electron imports (same purity rule as `shared/combat`). Unit-test-heavy core.
- **`src/main/services/workflowEngine.ts`** — the *executor*: takes a `WorkflowDoc` + run-context and
  drives execution (topo run, streaming the main output, per-node panel emission, branch prune, phases,
  cancellation, error routing). Side-effectful; lives in main because nodes call main services.
- **`src/main/services/nodes/`** — the **node registry**: one implementation per node type
  (`{ type, inputs, outputs, configSchema, run(ctx, inputs) }`). Built-in stage nodes are thin wrappers
  that delegate to existing code (`buildPrompt`, `selectMemories`, `streamProvider`, `contentParser`,
  the MVU parser, `appendFloor`, `stRegexEngine`).
- **`src/main/services/workflowService.ts`** — persistence/CRUD for workflow resources, scoping/selection
  per world+session, import/export. Mirrors `presetService`.
- **`src/main/services/nodeStateService.ts`** — per-node persistent scratchpad keyed by `(chat_id, node_id)`
  (see §11). Generalizes the memory checkpoint pointer.
- **`src/main/ipc/workflowIpc.ts`** — list/get/save/import/export/select + a run-trace subscription.
- **`generationService.generate()`** — becomes: *resolve the active workflow for (profile, world, session)
  → build run-context → `workflowEngine.run()`*. No workflow selected ⇒ run the built-in default graph.
- **`src/renderer/src/components/workflow/`** — `WorkflowEditorView` workspace view (React Flow canvas +
  node config side-panel + run/trace panel), `workflowStore` (Zustand), registered in `viewRegistry`.
  Per-node output panels generalize the existing reasoning panel.

**Boundary invariant:** `shared/workflow` stays pure; execution stays in `main`; the renderer edits the
JSON doc only over IPC. The overhaul crosses no module boundary.

---

## 4. Graph data model

```
WorkflowDoc {
  id, name, version, description
  schemaVersion            // for migrations (§15)
  nodes: NodeInstance[]
  edges: Edge[]
  meta: { author?, createdFor?: worldId, ... }
}
NodeInstance {
  id           // stable uuid
  type         // registry key, e.g. "llm.sample", "prompt.assemble", "control.when"
  config       // node-specific settings, validated by the node's zod schema
  position     // {x,y} canvas coords
  panel?       // { show: bool, label, collapsed }  — opt-in output panel (D4)
}
Edge { from: {node, port}, to: {node, port} }
```

**Port types** (extensible set — §14):

| Port type | Carries |
|---|---|
| `Messages` | `ChatMessage[]` (role-tagged assembled prompt) |
| `Text` | string / streaming token stream (model output) |
| `Vars` | the MVU `stat_data` tree |
| `Floors` | chat history |
| `Context` | the run bundle (world, settings, action…) |
| `Signal` | control-flow only; carries no data (gates a branch) |
| `Error` | `{ kind: 'A'\|'B', message, code?, nodeId, attempts }` (§10) |
| `Any` | escape hatch (permitted both directions) |

Connecting incompatible ports (e.g. `Text→Messages`) is rejected at edit time and by validation.

**Run-context** (built once per turn, threaded to every `run`):
`{ profileId, chatId, world, floors, settings, userAction, scanText, abortSignal,
   streamMain(delta), emitPanel(nodeId, delta), getNodeState(nodeId), setNodeState(nodeId, v) }`
— `streamMain` feeds the chat message; `emitPanel` feeds a node's collapsible panel; `get/setNodeState`
give a node durable per-chat memory (§11).

---

## 5. Execution semantics

- **Order.** Topologically sort by data edges; run each node once when all its data inputs are ready.
- **Branching & prune.** `control.if` / `control.switch` / `control.when` emit on one `Signal` output; a
  node gated by a `Signal` runs only if that signal fired. The un-taken branch is **pruned** (skipped, not
  merely ignored).
- **Main output = phase boundary (D4/D6).** Exactly one node is `isMainOutput`. Its token stream drives
  `streamMain` → the chat message; its final text is what `output.writeFloor` persists. Everything up to
  and including it runs in the **pre-response** phase (player waiting). Nodes reachable only *after* it run
  in the **post-response** phase — async, non-blocking, fail-open — preserving "never block a player's
  turn" *by construction*. Validation rejects graphs with ≠1 main-output node.
- **Per-node panels.** A node with `panel.show` streams via `emitPanel` into a collapsible message section
  (same component family as the reasoning panel), labeled by `panel.label`.
- **Streaming.** Only the main-output LLM node streams live; other LLM nodes resolve fully before
  downstream nodes run (their panels fill on completion).
- **Cancellation.** The per-turn abort threads through `ctx.abortSignal`; Stop cancels the whole graph
  and drops any queued (RPM-delayed) requests.
- **Loops.** Out of scope v1 (DAG only). Reserved for a fast-follow; not designed out.

---

## 6. The default graph (parity contract)

The built-in workflow reproduces today's pipeline exactly. Pre-response: `input.context` → `memory.recall`
→ `prompt.assemble` → `llm.sample ★` (main output, streams to chat) → `parse.response` →
`apply.mvu + apply.regex` → `output.writeFloor`. Post-response (async, off hot path): `memory.gate`
(every-N-turns checkpoint) → `memory.extract` (summarize aging turns) → `memory.write` (append · upsert ·
embed · advance pointer).

**Parity is guaranteed** because the built-in nodes delegate to the same functions today's pipeline calls.
This is pinned by a characterization test: the default graph must produce a byte-identical prompt and the
same floor as the pre-overhaul pipeline (§16).

The default graph ships **in code** (not the DB) and is the final fallback in the resolution order (§12).
"Clone to edit" copies it into a user-owned workflow; the built-in is never mutated. It also ships with
**reference error wiring** (§10) so out-of-box behavior degrades gracefully and teaches the pattern.

---

## 7. Node palette

**MVP (coarse; rebuilds the default graph + enables a real agentic branch):**

| Category | Nodes | Wraps |
|---|---|---|
| Context | `input.context` | builds the run bundle |
| Prompt | `prompt.assemble`, `prompt.messages`, `merge.messages`, `text.template` | `buildPrompt`; role-message composer (§8); concat; EJS/`substituteParams` |
| Memory | `memory.recall`, `memory.gate`, `memory.extract`, `memory.write` | decomposed retrieval/compaction |
| LLM | `llm.sample` (`isMainOutput` + `panel` opts) | `apiService.streamProvider` |
| Parse/State | `parse.response`, `apply.mvu`, `apply.regex`, `mvu.set` | `contentParser`, MVU parser, `stRegexEngine`, path-write |
| Output | `output.writeFloor` | `chatWriteService.appendFloor` |
| Control | `control.if`, `control.switch`, `control.when` | pure predicate on Vars/Text/Context (+ node-state for `when`) |

**Phase-2 (designed-for, not built in MVP):** tool/action nodes (`tool.lorebookSearch`, `tool.startCombat`,
`tool.startDuel`, `tool.mvuWrite`), sub-graph nodes, loop/iteration nodes. The port model already
accommodates them.

---

## 8. LLM nodes & role-tagged message composition

LLM-facing nodes accept a role-tagged `Messages` value, so an author can craft bespoke back-and-forth
prompts (a planner or judge often needs its own framing, distinct from the game prompt).

- **`prompt.messages` ("Message List")** — an ordered, editable list of `{ role: system|user|assistant,
  content }` rows. `content` is template-aware (interpolates upstream port outputs like `{{recall}}`,
  `{{planner.output}}`, and context vars via EJS/`substituteParams`). Supports a trailing **assistant
  prefill** row. Output: `Messages`.
- **`llm.sample`** consumes a `Messages` input — from `prompt.assemble`, `prompt.messages`, or a
  `merge.messages` concatenation (e.g. system preamble + assembled history + prefill). Same `Messages`
  port type throughout, so it all composes.
- **Provider correctness reused:** the node runs the composed `Messages` through the existing
  `systemToUser` / `mergeConsecutiveRoles` / `orderForProvider` normalization in `promptBuilder`/`apiService`,
  so hand-authored role sequences stay provider-correct for free.
- **Editor:** the node's side-panel is a polished message editor — add/remove/reorder rows, a role selector
  per row, and a template-aware content field with an upstream-port/variable picker.

---

## 9. API presets — RPM limiting (D9)

- Add optional **`rpm_limit`** to each `api_preset` (`0`/unset = unlimited).
- A main-process **rate limiter** (sliding-window/token-bucket) keyed by **endpoint** (presets sharing an
  endpoint share one budget, since limits are per-account/endpoint). All LLM traffic funnels through
  `apiService.streamProvider`, so the limiter lives there: a call **acquires a slot before sending**; if the
  window is full it **waits in a FIFO queue** rather than erroring.
- **Abort-aware:** a queued request cancelled by Stop / turn-abort drops out of the queue instead of firing
  late.
- Composes with multi-call graphs and concurrent turns automatically.
- **UI:** an RPM field in the API-preset editor (`ApiSettingsPanel`), i18n both locales.
- **Optional adjunct (not MVP):** a max-concurrent-per-endpoint cap — RPM alone doesn't bound parallelism.

---

## 10. Failure & bad-output handling (D10)

Two failure classes: **A** — request doesn't go through (network, timeout, 429, 5xx, auth); **B** — output
is bad (empty, refusal, or fails a node validator).

**Per-node handling primitives (run in this order):**
1. **Retry with backoff** (N attempts) — default for class A; honors 429 via the RPM queue.
2. **Fallback connection** — optionally chain to an alternate `api_preset`.
3. **Validator + corrective retry** — a node may declare a check (non-empty / regex / JSON-schema /
   predicate); on fail it retries, optionally injecting the error as a corrective nudge (mirrors the memory
   system's self-correcting structured writes).

**Give-up = author-controlled error branches (the default model):**
- Every fallible node (LLM/tool) exposes an **`error` output port** carrying an `Error` value.
- **Wired** → execution follows that branch: canned-response node, alternate-connection retry, skip, or even
  a "re-run default graph" node (so whole-workflow fallback is just one error-branch target, not a special
  rule).
- **Unwired + node fails** (after retries/fallback) → the turn **aborts with the error surfaced** to the
  user; the trace panel shows which node failed and why.
- **The default graph ships with reference error wiring:** memory `extract`/`write` errors → error branch →
  a no-op/log node (this is how the fail-open memory invariant is now expressed — explicitly in the graph);
  the main `llm.sample` leaves its error unwired, so a hard generation failure surfaces as a retryable
  failed turn, exactly like today.

Net effect: fail-open-for-memory and whole-workflow-fallback stop being bespoke engine behaviors and become
ordinary, visible graph wiring.

---

## 11. MVU-triggered optional calls (D11)

Conditional side-effect branches that write to game state instead of the reply — e.g. a "monthly agent job"
that runs once per in-game month and writes its result to a variable.

```
control.when  ──fires──▶  llm.sample (the job; its own role-messages)
 (reads stat_data:            │
  in-game month changed?)     ▼
                          mvu.set  ──▶ writes result to a stat_data path
```

- **`control.when`** — evaluates a predicate over the MVU tree (`stat_data`) using `shared/objectPath`:
  path comparisons, thresholds, equality, and **"changed since last fire."** Gates its downstream branch.
- **`mvu.set` (a.k.a. `vars.write`)** — takes a value + a target `stat_data` path and writes it through the
  same `applyVariableOps`/JSON-patch path the app uses. Distinct from `apply.mvu` (which applies a batch of
  model-emitted MVU commands).
- **Per-node persistent state (new capability)** — a `node_state` store keyed by `(chat_id, node_id)` gives
  a node a durable scratchpad across turns. This is what makes "once per in-game month" expressible: the
  `control.when` node remembers the last in-game month it fired in and only fires on a change. A clean
  generalization of the memory system's `memory_state` pointer, now available to any node.
- These branches live in the **post-response async phase** by default (background world-simulation), so they
  never block the player, and they fail-open via the error-branch model.

---

## 12. Persistence & distribution (D8)

A new **`workflow`** resource, mirroring `presetService`:
- **Storage:** a `workflows` table (`id, profile_id, name, doc JSON, scope, created_for_world?`) +
  `workflowService` CRUD + `workflowIpc`. Import/export as a `.rptflow` JSON file.
- **Binding/selection:** a world (and optionally a session) points at a chosen workflow id.
  **Resolution order:** session override → world default → global default → **built-in default graph**
  (shipped in code; always the safety net).
- **Clone to edit:** editing the built-in copies it into a user-owned workflow; the default is never mutated.
- **Companion files:** a card creator ships `their-world.rptflow` next to the card; the user imports and
  selects it. No embedding in the card, no auto-apply — the user always chooses.
- **Validation gate:** on import/save, schema + graph validation (exactly one main output, DAG, port types
  compatible, all node types known) — invalid workflows are rejected with a reason, never silently loaded.
- **Per-node persistent state** (`node_state`) is separate from the workflow doc — it's runtime chat state,
  not part of the shareable resource.

---

## 13. Editor UI

A `WorkflowEditorView` workspace view (registered in `viewRegistry`), opened for authoring, not shown during
normal play:
- **Canvas** (React Flow) — pan/zoom; wire by dragging port→port; incompatible ports refused with an inline
  hint; handles color-coded by port type.
- **Left:** draggable node palette. **Right:** node config side-panel — "detail as config" (Assemble Prompt →
  preset + block toggles; LLM → connection, params, `isMainOutput`, panel opts, retry/validator/fallback;
  Message List → the role-message editor).
- **Top bar:** workflow selector (which workflow this world uses), Save / Clone-to-edit, Import / Export
  `.rptflow`, Validate, valid/invalid status.
- **Run/trace panel:** per-node status (ran / skipped / failed / timing) + outputs after a turn; errors land
  here.
- **In chat:** per-node output panels generalize the reasoning panel into a reusable, labeled,
  collapsed-by-default component.
- **Polish (explicit requirement):** React Flow is fully re-skinned to the app's `--rpt-*` tokens — node
  cards, edges, handles, selection/running states match the app's design language, **WCAG-AA across
  dark/carbon/light**. No default React-Flow chrome. A first-class, polished authoring surface, not a debug
  tool. `workflowStore` (Zustand) holds the editing doc with debounced autosave.

---

## 14. Extensibility (D12)

Extensibility is a first-class design goal (the owner expects to add more later):
- **Node registry.** Adding a node type = registering `{ type, inputs, outputs, configSchema, run }`. No
  engine changes; the executor is generic over the registry.
- **Declared config schemas (zod).** Each node declares its config schema; the editor **auto-renders** the
  config side-panel from it, so new nodes need no bespoke UI wiring. Validation reuses the same schema.
- **Extensible port types & predicate operators.** The port-type set and the `control.*` predicate operator
  set are registries, not hardcoded switches — new types/operators plug in.
- **Versioned docs + migrations.** `WorkflowDoc.schemaVersion` + a migration pipeline (like
  `migrationService`) so new node types / renamed configs never break saved workflows or shared `.rptflow`
  files.
- **Capability seams for phase-2** (tools, sub-graphs, loops) are already accommodated by the port model
  and registry; they slot in without rearchitecting.

---

## 15. Module boundaries & `check:deps`

- `shared/workflow` is pure (no `renderer`/`main`/Electron) — enforced like `shared/combat`.
- `workflowEngine`, `workflowService`, `nodeStateService`, the node registry live in `main`.
- The renderer edits the doc only through `workflowIpc` (typed IPC), never main internals.
- A new dependency-cruiser rule pins `shared/workflow` purity; added in the same PR as the module (per
  CLAUDE.md — no bypass).

---

## 16. Testing strategy

- **Pure (shared):** graph validation, topological order, branch-prune, port type-compat, doc migration.
- **Per-node units:** each node's `run()` with mocked services.
- **Parity characterization (marquee):** the default graph produces a byte-identical prompt + the same floor
  as the pre-overhaul pipeline — pins current behavior (per CLAUDE.md's characterization requirement).
- **Engine orchestration:** multi-call chains, branch prune, post-response phase runs async/fail-open,
  cancellation drops queued requests, error-branch routing, RPM queueing/delay.
- The existing suite stays green because the default path is behavior-identical, just re-plumbed.

---

## 17. Phasing / build order

One module per change; tests green at each step.

1. **`shared/workflow`** — model + validation + pure executor algorithms.
2. **Engine + registry + default graph** — `generate()` routes through the engine running the default graph.
   *De-risking milestone: the parity test proves the default graph reproduces today exactly, before any
   editing exists.*
3. **Persistence** — `workflows` table/service/IPC + resolution/selection + import/export + `node_state` store.
4. **RPM limiting** — `apiService` endpoint queue + `api_preset.rpm_limit` + UI.
5. **Editor UI** — polished React Flow canvas + clone-to-edit + validation UX + run/trace + per-node panels.
6. **Agentic surfacing** — 2nd LLM node, `prompt.messages`/`merge.messages`, `control.if`/`control.when`,
   `mvu.set`, memory nodes exposed; failure/error-branch config.
7. **(later)** tool/action nodes, sub-graphs/loops, companion-file UX, max-concurrent cap.

---

## 18. Open questions / deferred

- **Loops/iteration** — deferred to a fast-follow; needs a bounded-iteration execution model.
- **Max-concurrent-per-endpoint** — optional adjunct to RPM (RPM alone doesn't bound parallelism).
- **Sub-graph nodes** — a stage node expandable into a sub-graph (the "hybrid granularity" we deferred).
- **Card companion-file UX** — the exact import/offer flow for a creator-shipped `.rptflow`.

---

## 19. Licensing note

`@xyflow/react` (React Flow) is **MIT** — used for the editor canvas *only*; execution is our own code. It
would be the app's heaviest renderer UI dependency to date (bigger than `vanilla-jsoneditor`); flagged for
final confirmation at spec review. No third-party runtime touches the generation core.
