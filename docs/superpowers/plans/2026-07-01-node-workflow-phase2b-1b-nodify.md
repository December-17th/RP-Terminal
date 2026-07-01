# Node Workflow Phase 2b-1b: Nodify + Parity — Plan (DRAFT for review)

> **STATUS: DRAFT** — surfaces the design + the ONE decision that deviates from the spec's framing (the
> phase-boundary model). Bite-sized tasks are expanded after the owner confirms the design below.

**Goal:** Make the Phase 2a workflow engine drive real generation: wrap each 2b-1a `generation/` stage as a
built-in default-graph node, build the built-in default graph, and re-plumb `generate()` to run it via
`runWorkflow(...)` — with the SAME `generateParity` snapshot proving the graph reproduces today's baseline.

**Architecture:** The engine (`workflowEngine.runWorkflow`) already exists (Phase 2a). The stage functions
(`buildGenContext`, `assemblePrompt`, `callModel`, …) already exist (2b-1a). 2b-1b is the thin glue: node
implementations that delegate to those stages, a default-graph document, an extended per-turn `RunContext`,
and the `generate()` re-plumb. No new generation logic — the parity snapshot is the contract.

**Tech Stack:** TypeScript, Vitest. Builds on main (`e46d9a2`).

---

## THE decision to confirm — the phase boundary (spec §5 refinement)

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

## Task outline (expand to full TDD tasks on approval)

1. Extend `RunContext` (+ a `buildTurnContext` helper) and the `builtin/` node types; unit-test each node
   impl against a fake `GenContext` (delegation correctness).
2. `input.context`, `memory.recall`, `prompt.assemble` nodes + tests.
3. `llm.sample`, `parse.response`, `apply.state` nodes + tests (llm streams via `ctx.streamMain`).
4. `output.writeFloor` (main output) + `memory.compact` (post) nodes + tests.
5. The default-graph doc + `validateWorkflow` passes on it + a `builtinRegistry`.
6. Re-plumb `generate()` → `runWorkflow`; the `generateParity` snapshot passes byte-identical (the milestone).

## Open items for 2b-2 (not this plan)

- Real `nodeStateService` (`node_state` table) for `control.when`.
- Tighter typed ports for `params`/`parsed`/`metrics` (currently `Any`).
- Decompose `memory.compact` into `memory.gate`/`extract`/`write` (2b-1a kept `maybeCompact` as one call).
- `GenContext.floor0Vars` (unused-after-derivation) — drop or justify when it's carried into `RunContext`.
