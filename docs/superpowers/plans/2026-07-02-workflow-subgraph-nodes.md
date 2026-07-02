# Plan: Sub-Graph Nodes (v1)

**Date:** 2026-07-02 · **Status:** DRAFT (pending Sonnet plan-QA)
**Branch:** `claude/workflow-subgraphs` (off main `64978ed`)
**Process:** plan → Sonnet plan-QA → Sonnet implementation → Opus implementation-QA → gate → PR

## 1. Motivation & shape

With PR #36's components, a creator can assemble 世界推进/剧情推进 as wiring — but sharing means
shipping a whole turn workflow, and reuse means copy-paste. **Sub-graphs** package a component
assembly as ONE node: a creator authors a sub-graph once (with declared input/output slots and
promoted parameters), ships it as its own `.rptflow`, and any user drops it into their workflow
as a single `subgraph.call` node and tweaks its params (spec §18 "hybrid granularity" deferred
item; the reuse story the owner asked for on 2026-07-02).

**v1 core decision — STATIC wrapper ports.** `subgraph.call` has a fixed descriptor:
inputs `gen: Context`, `in1..in4: Any`, `when: Signal`; outputs `out1..out4: Any`,
`error: Error`. Slots map to boundary nodes inside the sub-graph by slot name. This keeps
`validateWorkflow`, the catalog, and the editor's port rendering COMPLETELY unchanged (a
descriptor is still static per type). Typed, dynamically-derived ports are an explicit
fast-follow, not v1. (`Any` ↔ anything is legal per `portCompatible` — `shared/workflow/types.ts`.)

## 2. Doc model changes (`shared/workflow`)

- `WorkflowDoc` gains optional **`kind?: 'turn' | 'subgraph'`** (absent = `'turn'`), in
  `shared/workflow/types.ts` + `docSchema.ts` (`z.enum(['turn','subgraph']).optional()`).
  `editorModel.editorToDoc` spreads the base doc, so the field survives editing round-trips
  (verify, don't assume — it spreads `...base` today).
- `WorkflowDoc.meta` (already `Record<string, unknown>`) carries the sub-graph interface:
  - `meta.promotions?: Array<{ name: string; nodeId: string; configKey: string; label?: string }>`
    — parameters exposed to the wrapper (see §5).
- **Validation branches on kind** (`shared/workflow/validate.ts`):
  - `turn` (default): unchanged rules, PLUS a new error when the doc contains any
    `subgraph.input` / `subgraph.output` node (boundary nodes are meaningless in a turn graph —
    their seeds would be undefined). New code e.g. `BOUNDARY_IN_TURN`.
  - `subgraph`: **skip the exactly-one-main-output rule** (and skip `BOUNDARY_IN_TURN`);
    everything else (DAG, known types, port compat, FANIN) applies; NEW rule: boundary slot
    names must be unique per direction (two `subgraph.input` nodes both slot `in1` = error,
    code e.g. `DUP_BOUNDARY_SLOT`).
  - `validateWorkflow` signature: pass the kind through (either read `doc.kind` directly —
    preferred — or a new options arg; implementer picks the smaller diff, reading `doc.kind`
    directly needs no call-site changes).

## 3. Boundary node types (`nodes/builtin/subgraphNodes.ts`, new)

- **`subgraph.input`** — inputs: none · outputs: `value: Any` ·
  configSchema `z.object({ slot: z.enum(['gen','in1','in2','in3','in4']), label: z.string().optional() })`.
  `run(ctx)` returns `{ outputs: { value: ctx.subgraphSeeds?.[cfg.slot] } }`.
- **`subgraph.output`** — inputs: `value: Any` · outputs: none ·
  configSchema `z.object({ slot: z.enum(['out1','out2','out3','out4']), label: z.string().optional() })`.
  `run(ctx, inputs)` calls `ctx.subgraphCollect?.(cfg.slot, inputs.value)`; returns `{ outputs: {} }`.
- Both registered in `builtin/index.ts` and added to `test/nodeCatalog.test.ts`.

**RunContext extensions** (`nodes/types.ts`, all optional/additive — existing ctx literals in
tests keep compiling):
```ts
subgraphSeeds?: Record<string, unknown>
subgraphCollect?: (slot: string, value: unknown) => void
/** Ids of sub-graph docs currently executing up-stack (recursion guard) + depth cap. */
subgraphStack?: string[]
```

## 4. Execution (`workflowEngine.ts` + the wrapper node)

- **`runSubgraph(doc, registry, ctx, seeds)`** — new export in `workflowEngine.ts`, built on the
  EXISTING module-local `runNodes` (do not fork the loop): one single pass over
  `topoOrder(doc)` with `phase: 'pre'`, a fresh `ExecState`, and a wrapped ctx that carries
  `subgraphSeeds = seeds` + a `subgraphCollect` writing into a local `outputs` record. Returns
  `{ outputs: Record<slot, unknown>, fatal?: NodeError, aborted: boolean, traces: NodeTrace[] }`.
  Signal gating, config parsing, error-port routing inside the sub-graph all come free from
  `runNodes`. No `onResponseReady`, no phases — a sub-graph runs entirely inside its wrapper
  node's run(), inheriting the parent's phase.
- **`subgraph.call`** (`subgraphNodes.ts`) — ports per §1 ·
  configSchema `z.object({ workflow_id: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() })`.
  `run(ctx, inputs, node)`:
  1. Depth/recursion guard: `stack = ctx.subgraphStack ?? []`; if `stack.length >= 8` or
     `stack.includes(workflow_id)` → `throw new NodeRunFailure('B', …, 1, 'recursion')`.
  2. Resolve: `getWorkflowById(ctx.profileId!, workflow_id)` (from `../../workflowService` —
     **check for an import cycle**: workflowService imports `nodes/builtin` (registry) for
     validation, and builtin/index would now import subgraphNodes which imports workflowService
     → CYCLE. Mitigation REQUIRED: lazy-require inside run()
     (`const { getWorkflowById } = require('../../workflowService')` via a typed helper), OR
     extract `getWorkflowById`+`BUILTIN_WORKFLOW_ID` into a leaf `workflowStore.ts` that both
     import (mirrors the `generation/rawGenerate.ts` precedent from PR #35). The plan prefers
     the **leaf extraction** — no runtime require tricks, dependency-cruiser stays at 0.
  3. Missing doc / `doc.kind !== 'subgraph'` → `throw NodeRunFailure('B', …, 1, 'bad-subgraph')`
     (routes on the error port when wired; the save-gate does NOT check dangling ids —
     a parent may be imported before its sub-graph; run-time is the enforcement point, v1).
  4. Validate the sub-doc via `validateWorkflow` (cheap, already loaded registry descriptors);
     invalid → class-B throw.
  5. **Apply promotions:** `structuredClone(doc)`; for each `meta.promotions` entry where
     `node.config.params?.[name] !== undefined`, set `cloned.nodes[nodeId].config[configKey] = value`.
     Unknown promotion nodeIds are skipped with a `log('error', …)`.
  6. Seeds: `{ gen: inputs.gen, in1: inputs.in1, … in4: inputs.in4 }`.
  7. Wrapped ctx: parent ctx spread + seeds/collect + `subgraphStack: [...stack, workflow_id]`
     + **node-state prefixing**: `getNodeState: (id) => parent.getNodeState(`${node.id}/${id}`)`
     (same for set) — a `control.when('changed')` INSIDE a sub-graph must be per-wrapper-instance,
     and two instances of one sub-graph in a workflow must not share state.
  8. `runSubgraph(...)`; `fatal` → re-throw as `NodeRunFailure(fatal.kind, fatal.message,
     fatal.attempts, fatal.code)`; aborted → return `{ outputs: {} }`;
     else `{ outputs: { out1: …, …, out4: … } }`.
- **Traces v1:** the wrapper appears as one node (its ms covers the whole sub-run). Inner traces
  are DROPPED in v1 — flattened `wrapper/inner` trace rows are an explicit fast-follow; note it
  in the node's i18n description so authors aren't surprised.
- **Streaming caution (doc note, no code):** an `llm.sample` inside a sub-graph inherits
  `ctx.streamMain` like any side-branch node — sub-graph authors should set `stream: false`
  unless the sub-graph IS the main path.

## 5. Service/persistence (`workflowService.ts` + renderer surfaces)

- `WorkflowSummary` gains `kind?: 'turn' | 'subgraph'`; `listWorkflows` populates it from the doc.
- `validateWorkflowDoc` — no signature change; the kind-branching lives in `validateWorkflow`
  (§2). Config validation (existing loop) already covers the new node types via their schemas.
- `resolveWorkflowDoc` / `resolveWorkflowId`: a tier whose id resolves to a `kind: 'subgraph'`
  doc **falls through with a log** (a sub-graph must never run as the turn workflow).
- `cloneWorkflow` / import / export: no behavior change needed (kind rides the doc). **Export
  bundling of referenced sub-graphs is explicitly DEFERRED** — v1 shipping story = creator ships
  two `.rptflow` files (parent + sub-graph) or just the sub-graph; document in the PR body.
- **Renderer, WorkflowView:** the three selection dropdowns EXCLUDE `kind === 'subgraph'`
  summaries; the list shows a badge (i18n `workflow.subgraphBadge`: en `Sub-graph` / zh `子图`)
  next to sub-graph entries; a **New sub-graph** button (i18n `workflow.newSubgraph`:
  en `+ New sub-graph` / zh `+ 新建子图`) calls a new IPC-less path? No — add
  `create-workflow` IPC? Smaller: reuse existing import/clone patterns — add
  `createWorkflow(profileId, kind)` to workflowService + one IPC channel
  (`create-workflow`) + preload method, creating a starter doc (name "New Sub-graph", kind
  subgraph, one `subgraph.input`(gen) + one `subgraph.output`(out1) node, no edges), then open
  it in the editor (same flow as WorkflowView's Edit button).
- **Editor palette** (`WorkflowEditorView.tsx`): below the node-type palette, a "Sub-graphs"
  section (i18n `workflowEditor.subgraphs`: en `Sub-graphs` / zh `子图`) listing
  `workflows.filter(w => w.kind === 'subgraph' && w.id !== currentId)`; dragging one inserts a
  `subgraph.call` **preconfigured with `workflow_id`**. `workflowEditorStore.addNode` gains an
  optional `config` argument (additive; existing calls unchanged).
- **NodeConfigPanel:** for `subgraph.call`, above the schema-driven fields, show the referenced
  sub-graph's NAME (from the workflows list; fallback: the raw id + a warning color when
  unknown) and an "Open sub-graph" button (i18n `workflowEditor.openSubgraph`: en
  `Open sub-graph` / zh `打开子图`) that calls `open(profileId, workflow_id)` on the editor
  store. Promoted params v1 are edited through the existing JSON-fallback field on `params`
  (the promotions' names/labels shown as a hint list below it, read from the referenced doc's
  meta via the workflows… summaries don't carry meta — fetch the doc lazily via
  `window.api.getWorkflow` in the panel; keep it best-effort).

## 6. i18n (both locales, per CLAUDE.md)

`workflowEditor.nodeTitle/nodeDesc` for `subgraph.call` (en `Sub-graph` / zh `子图调用`),
`subgraph.input` (en `Sub-graph Input` / zh `子图输入`), `subgraph.output` (en `Sub-graph
Output` / zh `子图输出`) — descs must cover: static in1–in4/out1–out4 slot mapping, gen slot,
params override of promotions, error port on missing/cyclic/invalid sub-graph, v1 wrapper-only
trace, stream:false advice for inner LLM nodes. Plus the four UI strings from §5
(`workflow.subgraphBadge`, `workflow.newSubgraph`, `workflowEditor.subgraphs`,
`workflowEditor.openSubgraph`).

## 7. Tests

Shared (`test/workflow/…`):
1. docSchema accepts kind + rejects bad kind values; kind survives an editor round-trip
   (extend `editorModel.test.ts`).
2. validate: turn doc containing `subgraph.input` → `BOUNDARY_IN_TURN`; subgraph doc without
   main output → ok; duplicate slots → `DUP_BOUNDARY_SLOT`; subgraph doc otherwise follows
   normal rules (cycle still rejected).

Engine/nodes (`test/workflow/subgraph.test.ts`, new — mock workflowService's doc lookup):
3. `runSubgraph` seeds boundary inputs and collects boundary outputs (in1 → transform → out1).
4. Signal gating works inside a sub-graph (a gated inner node skipped; collect not called).
5. Inner unwired failure → fatal returned → wrapper throws NodeRunFailure with the inner
   kind/message; wired inner error port routes normally (no wrapper throw).
6. `subgraph.call`: missing doc → class-B 'bad-subgraph'; kind 'turn' doc → same; recursion
   (self-reference) → class-B 'recursion'; depth cap.
7. Promotions: `params: { x: 5 }` lands on the promoted node's configKey; unknown promotion
   nodeId skipped without throwing.
8. Node-state prefixing: inner `getNodeState('a')` reaches parent as `'<wrapperId>/a'`
   (assert via spy on ctx).
9. Two `subgraph.call` instances of the SAME sub-graph get DISTINCT state keys.

Service:
10. `resolveWorkflowDoc` falls through past a subgraph-kind doc to the next tier.
11. `listWorkflows` carries kind; save-gate accepts a valid subgraph doc and rejects a turn doc
    with boundary nodes.

Renderer (`test/workflowEditorStore.test.ts` extension):
12. `addNode(type, position, config)` presets config; existing 2-arg calls unaffected.

Gotchas for the implementer: braces in `beforeEach` (vitest teardown-hook trap); never edit
files via PowerShell text pipelines (UTF-8 corruption); baseline gate = 1227 tests / 159 files.

## 8. Non-goals (v1)

Typed dynamic wrapper ports · flattened inner traces in the run panel · export bundling of
referenced sub-graphs · "collapse selection into sub-graph" editor gesture · promoted-param
dedicated form UI (JSON field + hint list only) · loops (still §18).

## 9. QA checklists

**Plan QA (Sonnet):** verify every referenced API/file (validateWorkflow shape + where the
main-output rule lives; runNodes reusability for runSubgraph incl. what ExecState needs;
editorToDoc kind passthrough; workflowService imports for the CYCLE claim in §4.2 and whether
the leaf extraction is the right mitigation; addNode signature; NodeConfigPanel structure;
WorkflowView dropdown code paths; listWorkflows summary shape; i18n key sections). Check the
static-slot design against portCompatible and the engine's signal-gating detection (does a
`when: Signal` input on subgraph.call gate correctly given gating is computed from SOURCE port
types?). Flag anything under-specified.

**Implementation QA (Opus):** conformance to this plan; recursion/depth guards actually
unbypassable (indirect A→B→A); node-state prefix collisions; parity (default graph + resolve
untouched for turn docs); boundaries (0 violations — especially the workflowService cycle
mitigation); i18n completeness; test honesty; full gate re-run.
