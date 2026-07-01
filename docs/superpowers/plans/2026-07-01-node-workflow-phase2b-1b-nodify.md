# Node Workflow Phase 2b-1b: Nodify + Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Phase-boundary decision CONFIRMED (owner, 2026-07-01): Option A** — `output.writeFloor` is the
> `isMainOutput` (phase-boundary) node; the whole synchronous chain (incl. `llm.sample`) is pre-response;
> only `memory.compact` (+ any independent side-branches) is post-response/async. `llm.sample` streams the
> reply live via the free `ctx.streamMain` hook (streaming ≠ main-output). **No Phase 2a engine change.**
> Deferred to 2b-2: an explicit `async` node marker (Option B) + "reply node vs result node" editor naming.

**Goal:** Make the Phase 2a workflow engine drive real generation: wrap each 2b-1a `generation/` stage as a
built-in default-graph node, build the built-in default graph, and re-plumb `generate()` to run it via
`runWorkflow(...)` — with the SAME `generateParity` snapshot proving the graph reproduces today's baseline.

**Architecture:** The engine (`workflowEngine.runWorkflow`) already exists (Phase 2a). The stage functions
(`buildGenContext`, `assemblePrompt`, `callModel`, …) already exist (2b-1a). 2b-1b is the thin glue: node
implementations that delegate to those stages, a default-graph document, an extended per-turn `RunContext`,
and the `generate()` re-plumb. No new generation logic — the parity snapshot is the contract.

**Tech Stack:** TypeScript, Vitest. Builds on main (`e46d9a2`).

---

## Global Constraints

- **Parity is the contract.** The graph-driven `generate()` MUST make `test/generation/generateParity.test.ts`
  pass WITHOUT `-u` (byte-identical `{ sendMessages, writtenFloor }`). No behavior change.
- **No Phase 2a engine change** (decision A). `output.writeFloor.isMainOutput = true` is the phase boundary.
- **Node impls are thin glue** — they delegate to the existing 2b-1a `src/main/services/generation/*` stage
  functions; do NOT reimplement any generation logic. Read each stage's real signature before wiring.
- **Module boundaries:** node impls live in `src/main/services/nodes/builtin/`; may import `src/main/services/generation/*`
  + `src/shared/workflow`; never `src/renderer`. `check:deps` clean.
- **Verification gate:** `npm run typecheck && npm run check:deps && npm run test` all pass before done.
- **Prettier:** no semicolons, single quotes, 2-space indent, no trailing commas. Commit trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Design rationale — the phase boundary (confirmed Option A)

Spec §5 says "the main-output node is the phase boundary; its token stream drives `streamMain`; its final
text is what `output.writeFloor` persists." That framing implies **`llm.sample` is the main-output node.**
But that breaks the default graph: in `generate()`, AFTER the model call we still SYNCHRONOUSLY
parse → fold state → build & persist the floor, and the persisted floor is the value `generate()` returns.
If `llm.sample` were the phase boundary, everything downstream (parse/fold/persist) would be classified
**post-response / async** (Phase 2a `computePhases`: post = descendants of main-output) — so `generate()`
would return before the floor exists. Wrong.

**Proposed reconciliation:** designate **`output.writeFloor` as the `isMainOutput` node.** It is the node
whose output value *is* the turn's result (the `FloorFile`), and making it the phase boundary means:
- **Pre-response (synchronous):** `input.context → memory.recall → prompt.assemble → llm.sample → parse.response → apply.state → output.writeFloor`. All the work that produces the floor.
- **Post-response (async, off the hot path):** only `memory.compact` (today's `void maybeCompact`).

**Live streaming is orthogonal to the phase boundary.** `llm.sample` streams the reply text live via
`ctx.streamMain(delta)` during its run (wired to the renderer's `onDelta`), even though it is NOT the
main-output node. `streamMain` is a free `RunContext` hook any node may call — the engine does not tie it to
`isMainOutput`. So: `llm.sample` streams the words; `output.writeFloor` produces the turn result and marks
where async post-work begins.

This is a small, clarifying **refinement of spec §5** (separating "the node that streams the reply" from
"the node that produces the turn result / the phase boundary"). If you'd rather keep `llm.sample` as the
main-output and handle the floor differently, say so — but this model maps cleanly onto the real
`generate()` and onto the Phase 2a engine as-built. **This is the one thing I want your nod on before
expanding tasks.**

---

## RunContext extension (per-turn)

Phase 2a's `RunContext` has executor hooks only (`signal`, `streamMain`, `emitPanel`, `getNodeState`,
`setNodeState`, `onResponseReady`). The default-graph nodes also need the turn seed. Extend it with the
minimum:

```
RunContext (2b-1b additions)
  profileId: string
  chatId: string
  userAction: string
  onDelta: DeltaCallback     // llm.sample streams here (== ctx.streamMain wiring)
```

`generate()` builds this per turn: `signal = controller.signal`; `streamMain = (d) => onDelta({ chatId, delta: d })`
(or however onDelta is shaped today); `getNodeState`/`setNodeState` are **no-op stubs in 2b-1b** (the default
graph doesn't use per-node state — memory compaction manages its own checkpoint internally). The real
`nodeStateService` (`node_state` table, spec §11) is **deferred to 2b-2**, where `control.when` needs it.

The `GenContext` bundle (2b-1a) is NOT a `RunContext` field — it is produced by the `input.context` node and
flows to downstream nodes as a `Context`-typed value along edges (see node set).

---

## The default-graph node catalog (`src/main/services/nodes/builtin/`)

Seven nodes, each delegating to a 2b-1a stage. The `GenContext` (`gen`) flows as a `Context` value; a few
explicit typed outputs feed the model and floor. Ports use the Phase 1 `PortType` set.

| Node type | inputs → outputs | delegates to | phase |
|---|---|---|---|
| `input.context` | (none) → `gen: Context` | `buildGenContext(ctx.profileId, ctx.chatId, ctx.userAction)` | pre |
| `memory.recall` | `gen: Context` → `block: Text` | `recallMemory(gen)` (returns `{block, rows}`; also calls notify internally) | pre |
| `prompt.assemble` | `gen: Context`, `block: Text` → `sendMessages: Messages`, `params: Any` | `matchWorldInfo(gen)` then `assemblePrompt(gen, matched, block)` | pre |
| `llm.sample` | `gen: Context`, `sendMessages: Messages`, `params: Any` → `raw: Text`, `rawUsage: Any` | `callModel(gen, sendMessages, params, ctx.streamMain, ctx.signal)`; streams live via `ctx.streamMain` | pre |
| `parse.response` | `gen: Context`, `raw: Text`, `sendMessages: Messages`, `rawUsage: Any` → `parsed: Any`, `mvu: Any`, `metrics: Any` | `parseResponse(raw)` + `computeMetrics(gen, sendMessages, raw, rawUsage)` | pre |
| `apply.state` | `gen: Context`, `parsed: Any`, `mvu: Any` → `variables: Vars` | `foldState(gen, parsed, mvu, raw)` | pre |
| `output.writeFloor` ★ | `gen: Context`, `raw: Text`, `sendMessages: Messages`, `variables: Vars`, `parsed: Any`, `metrics: Any` → `floor: Any` | `persistFloor(gen, {...})`; **`isMainOutput: true`** | pre (boundary) |
| `memory.compact` | `gen: Context` → (none) | `compactMemory(ctx.profileId, ctx.chatId)` | **post** |

Notes:
- `params` and `parsed`/`mvu`/`metrics` use `Any` ports for now (they're internal bundles, not clean typed
  values); the `Messages`/`Text`/`Vars`/`Context` ports carry the meaningful typed flow. 2b-2 can tighten.
- `llm.sample`'s abort-with-empty (`callModel` returns `null`): the node observes `ctx.signal.aborted` and
  returns no output; the engine's abort path then skips `output.writeFloor` and the run reports aborted →
  `generate()` returns `null`. Abort-with-text persists as today (partial floor).
- `memory.compact` reads `gen` only to be a descendant of `writeFloor` (so it lands in the post phase); it
  fire-and-forgets `compactMemory` and returns immediately (never blocks — matches today's `void maybeCompact`).

---

## The built-in default graph (`src/main/services/nodes/defaultGraph.ts`)

A `WorkflowDoc` in code wiring the seven nodes per the table (each edge respects the port types + the FANIN
rule — one edge per input port). `output.writeFloor.isMainOutput = true`. Shipped in code as the resolution
fallback (spec §12). `validateWorkflow` must pass on it (exactly one main output, DAG, ports compatible).

---

## Re-plumbing `generate()`

`generate()` becomes:
1. Create the `AbortController`, register it in `activeControllers` (unchanged — the map stays here).
2. Build the per-turn `RunContext` (profileId, chatId, userAction, streamMain wired to `onDelta`, signal,
   no-op node-state).
3. `const res = await runWorkflow(defaultGraph, builtinRegistry, ctx)` inside try/finally (delete controller).
4. If `res` aborted / not ok → return `null` (matches abort-empty). Else read the floor from
   `res.outputs.get('<writeFloor node id>')?.floor` and return it.

The `generateParity` test (unchanged) must still snapshot byte-identical `{ sendMessages, writtenFloor }` —
now produced by the graph instead of the inline sequence. That is the proof of parity.

`regenerate`/`generateSwipe`/`generateRaw` are unchanged (they call `generate` / their own path).

---

## Parity strategy

The existing `test/generation/generateParity.test.ts` is the contract: it mocks the same services and
snapshots `{ sendMessages, writtenFloor }`. After the re-plumb it must pass **without `-u`** (byte-identical).
This is the whole point — the graph reproduces the baseline. If the snapshot moves, the nodify changed
behavior.

---

## Tasks

Before writing node impls, READ the real stage signatures in `src/main/services/generation/*.ts` (built in
2b-1a) and the Phase 2a node types in `src/main/services/nodes/types.ts` (`RunContext`, `NodeImpl`,
`NodeResult`) + `registry.ts` (`createRegistry`). Node impls are thin `run()` delegations.

### Task 1: Extend RunContext + `buildTurnContext`
- Modify `src/main/services/nodes/types.ts`: add OPTIONAL fields to `RunContext` — `profileId?: string`,
  `chatId?: string`, `userAction?: string` (only `input.context` reads them; keeping them optional means the
  Phase 2a engine tests that construct bare `RunContext` literals still compile).
- Create `src/main/services/nodes/turnContext.ts`: `buildTurnContext(args: { profileId: string; chatId: string; userAction: string; signal: AbortSignal; onDelta: DeltaCallback }): RunContext` — sets the three
  seed fields, `signal`, `streamMain: (delta) => onDelta(...)` (match the current `onDelta` shape used by
  `callModel`/`streamProvider` — READ how `generate()` calls `onDelta` today), `emitPanel`: no-op,
  `getNodeState`/`setNodeState`: no-op stubs (return undefined / ignore).
- Test (`test/workflow/turnContext.test.ts`): `buildTurnContext(...).streamMain('x')` forwards to the given
  `onDelta`; seed fields are set; `getNodeState('n')` is `undefined`.

### Task 2: Pre-model nodes — `input.context`, `memory.recall`, `prompt.assemble`
- Create `src/main/services/nodes/builtin/generationNodes.ts` exporting these three `NodeImpl`s (per the node
  table): each `run(ctx, inputs)` delegates to the matching stage (`buildGenContext`, `recallMemory`,
  `matchWorldInfo`+`assemblePrompt`) and maps to the declared output ports. `input.context` reads
  `ctx.profileId!/chatId!/userAction!`; the others read `inputs.gen` (the `GenContext`).
- Test (`test/workflow/builtinNodes.pre.test.ts`): with the generation stage functions `vi.mock`ed, assert
  each node calls its stage with the right args and returns `{ outputs: { <port>: <stageResult> } }`. (Thin
  delegation — the parity test covers real behavior later.)

### Task 3: Model + sync post-model nodes — `llm.sample`, `parse.response`, `apply.state`
- Add these three `NodeImpl`s (same file or a sibling). `llm.sample.run` calls
  `callModel(gen, sendMessages, params, ctx.streamMain, ctx.signal)` — it STREAMS via `ctx.streamMain` (verify
  `callModel`'s onDelta param), and on a `null` return (abort-empty) returns `{ outputs: {} }` (the engine's
  abort path handles the rest). `parse.response` delegates to `parseResponse` + `computeMetrics`;
  `apply.state` to `foldState`.
- Test (`test/workflow/builtinNodes.model.test.ts`): mock the stages; assert delegation + that `llm.sample`
  passes `ctx.streamMain` through as the onDelta.

### Task 4: Terminal nodes — `output.writeFloor` (main output) + `memory.compact` (post)
- Add `output.writeFloor` (`isMainOutput: true`) delegating to `persistFloor` → outputs `{ floor }`; and
  `memory.compact` delegating to `compactMemory(gen.profileId, gen.chatId)` → no outputs (fire-and-forget).
- Test (`test/workflow/builtinNodes.terminal.test.ts`): mock stages; assert `writeFloor` returns `{ outputs: { floor } }` and `memory.compact` calls `compactMemory` and returns no outputs.

### Task 5: Default graph doc + builtin registry
- Create `src/main/services/nodes/builtin/index.ts` exporting `builtinRegistry = createRegistry([...all 7 impls])`
  and `src/main/services/nodes/builtin/defaultGraph.ts` exporting `DEFAULT_GRAPH: WorkflowDoc` wiring the seven
  nodes per the node table (one edge per input port — respect FANIN; `output.writeFloor.isMainOutput = true`).
- Test (`test/workflow/defaultGraph.test.ts`): `validateWorkflow(DEFAULT_GRAPH, builtinRegistry.descriptors())`
  returns `{ ok: true }`; exactly one `isMainOutput` node (`output.writeFloor`).

### Task 6: Re-plumb `generate()` → run the graph (the parity milestone)
- Modify `src/main/services/generationService.ts` `generate()`: keep the `AbortController`/`activeControllers`
  lifecycle; build `const ctx = buildTurnContext({ profileId, chatId, userAction, signal: controller.signal, onDelta })`;
  `const res = await runWorkflow(DEFAULT_GRAPH, builtinRegistry, ctx)` in try/finally; if `!res.ok || res.aborted`
  return `null` (matches abort-empty); else `const floor = res.outputs.get('<writeFloor node id>')?.floor as FloorFile`;
  return it. Remove the now-unused direct stage calls from `generate()` (the stage fns stay — the nodes call them).
- **Gate:** `npx vitest run test/generation/generateParity.test.ts` (WITHOUT `-u`) → snapshot BYTE-IDENTICAL.
  This is the milestone: the graph reproduces the baseline. Then the full gate.
- Commit message: `feat(workflow): drive generate() through the default workflow graph (parity preserved)`.

## Open items for 2b-2 (not this plan)

- Real `nodeStateService` (`node_state` table) for `control.when`.
- Tighter typed ports for `params`/`parsed`/`metrics` (currently `Any`).
- Decompose `memory.compact` into `memory.gate`/`extract`/`write` (2b-1a kept `maybeCompact` as one call).
- `GenContext.floor0Vars` (unused-after-derivation) — drop or justify when it's carried into `RunContext`.
