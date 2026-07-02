# Plan: `subgraph.loop` — bounded loops/iteration for the node workflow engine

**Date:** 2026-07-02 · **Spec ref:** §18 "Loops/iteration — deferred to a fast-follow; needs a
bounded-iteration execution model" (docs/superpowers/specs/2026-07-01-node-workflow-engine-design.md)
· **Executor:** Opus subagent (medium effort) · **Reviewer:** controller (final review)

## Design (LOCKED — do not re-litigate)

One new builtin node, **`subgraph.loop`**, sibling of `subgraph.call` in
`src/main/services/nodes/builtin/subgraphNodes.ts`. The parent graph stays a DAG: iteration lives
entirely inside this node's `run()`, driving `runSubgraph()` once per pass. **Zero engine changes.**

- **Config (zod):** `{ workflow_id: string.min(1), mode?: 'foreach' | 'until' (default 'foreach'),
  max_iterations?: int 1..100 (default 10), params?: record }` — the hard 100 cap IS the
  bounded-iteration model; there is no unbounded while.
- **Static ports**, identical to `subgraph.call`: inputs `gen: Context`, `in1..in4: Any`,
  `when: Signal`; outputs `out1..out4: Any`, `error: Error`.
- **Per-pass boundary seeding:** `gen`/`in3`/`in4` pass through unchanged; **`in2` seeds the
  iteration index** (a wire into the wrapper's `in2` is ignored — documented in port desc).
  - **foreach:** `in1` must be an array (`null`/`undefined` ⇒ empty; any other non-array ⇒
    class-B `NodeRunFailure` code `bad-loop-input`). Pass i seeds `in1 = items[i]`. Items beyond
    `max_iterations` are dropped with a `log('info', …)`. Outputs: `out1` = array collecting each
    pass's `out1` (holes preserved as `undefined`), `out2` = passes run, `out3`/`out4` = last
    pass's values.
  - **until:** pass 0 seeds `in1` from the wire; later passes seed `in1` with the previous pass's
    `out1` (the carry — an UNWRITTEN `out1` keeps the previous carry, via `'out1' in outputs`).
    Loop stops when a pass reports a **truthy `out2`**, or at `max_iterations`. Outputs: `out1` =
    final carry, `out2` = passes run, `out3`/`out4` = last pass's values.
- **Shared plumbing with `subgraph.call`** (extracted helpers, already in the working tree):
  `guardAndLoadSubgraph(ctx, workflowId)` (depth/recursion guards → load via leaf `workflowStore`
  → kind check → `validateWorkflow`; all failures class-B, codes `recursion`/`bad-subgraph`) and
  `wrapCallCtx(ctx, wrapperId, workflowId)` (recursion-stack push + node-state/panel prefixing
  `${wrapperId}/`). The state prefix is **iteration-INDEPENDENT on purpose**: a
  `control.when('changed')` inside a loop body compares against the previous iteration.
- **Failure/abort:** an inner fatal throws a `NodeRunFailure` carrying the inner kind/attempts/code
  with `iteration ${i}:` prefixed to the message (routable via the wrapper's `error` port). An
  abort (`ctx.signal.aborted` before a pass, or an aborted `runSubgraph`) returns `{ outputs: {} }`
  immediately.
- **Bundling follows loop refs:** `workflowService.ts`'s export bundling must treat
  `subgraph.loop` like `subgraph.call` when collecting/remapping `config.workflow_id`
  (`SUBGRAPH_REF_TYPES` set — already in the working tree).

## Current working-tree state (UNCOMMITTED — inherit, verify, complete; do not redo from scratch)

Already done (verify against the design above rather than trusting this list):
1. `subgraphNodes.ts`: helpers extracted, `subgraph.call` refactored onto them, `subgraphLoop`
   implemented + exported.
2. `builtin/index.ts`: `subgraphLoop` registered.
3. `workflowService.ts`: `SUBGRAPH_REF_TYPES = {'subgraph.call','subgraph.loop'}` in
   `referencedSubgraphIds`/`remapSubgraphRefs`.
4. `locales/en.ts`: `nodeTitle`/`nodeDesc`/`portDesc.*` keys for `subgraph.loop` added.
5. `locales/zh.ts`: ONLY `nodeTitle.subgraph.loop` added so far.

## Remaining work

1. **zh locale completion** (`src/renderer/src/i18n/locales/zh.ts`): add
   `workflowEditor.nodeDesc.subgraph.loop` and the ten
   `workflowEditor.portDesc.subgraph.loop.{gen,in1,in2,in3,in4,out1,out2,out3,out4}` keys (note:
   `when`/`error` fall back to `portDesc.common.*` — do NOT add per-node keys for those, en didn't).
   Mirror the en meanings; use the file's existing terminology (子图 = sub-graph, 槽位 = slot,
   端口 = port, 轮/次 for passes). Place them adjacent to the `subgraph.call` keys.
2. **Tests** — new file `test/workflow/subgraphLoop.test.ts`, modeled EXACTLY on
   `test/workflow/subgraphCall.test.ts` (same `vi.mock` of the leaf
   `src/main/services/workflowStore`, same side-effect import of `builtin/index` to trigger
   `setBuiltinRegistry`, same `baseCtx` shape). Cover at minimum:
   - foreach happy path: array in → per-item sub-graph run → `out1` array, `out2` count. Use a
     sub-graph that transforms `in1` (e.g. via the real `text.template` or a boundary pass-through
     with promotions — whatever is simplest with REAL builtin node types, since the real registry
     is wired).
   - foreach index seeding: a sub-graph whose `subgraph.input {slot: 'in2'}` routes to `out1`
     proves passes see 0,1,2….
   - foreach null/undefined `in1` ⇒ zero passes, `out1: []`, `out2: 0`; non-array `in1` ⇒ rejects
     with `{kind:'B', code:'bad-loop-input'}`.
   - foreach truncation: 5 items with `max_iterations: 3` ⇒ 3 passes.
   - until carry: a sub-graph that increments its `in1` number and reports `out2 = (value >= 3)`
     ⇒ loop stops early, final `out1` = 3, `out2` (wrapper) = pass count. Simplest real-node
     construction: `subgraph.input(in1)` → … — if no real builtin can increment, drive carry via
     promotions + `text.template` string growth (e.g. append 'x' per pass, until length ≥ 3), or
     temporarily `setBuiltinRegistry(createRegistry([...custom impls]))` in that test with a
     try/finally restore, exactly like subgraphCall.test.ts's "unwired inner failure" test does.
   - until max_iterations bound: a body that never reports done ⇒ exactly `max_iterations` passes
     (default 10 when unset — assert the default too).
   - recursion/depth guards apply (stack already containing the target id ⇒ `code: 'recursion'`).
   - inner fatal ⇒ wrapper throw with `iteration N:` in the message and the inner code preserved.
   - state prefixing: `setNodeState` spy sees `loop-1/<innerId>` keys.
   - **Bundling:** in `test/workflowService.test.ts`, add one test that a parent whose
     `subgraph.loop` references a sub-graph exports as a bundle and the ref is remapped on import
     (mirror the existing `subgraph.call` round-trip test; keep it inside the existing
     `sub-graph export bundling` describe block).
3. **Editor palette affordance** (`src/renderer/src/components/workflow/WorkflowEditorView.tsx`):
   the "Sub-graphs" palette section currently drags only `subgraph.call`. Add a second draggable
   row per sub-graph (or a small secondary chip on the same card — pick whichever needs LESS code
   and stays visually consistent) that sets `application/rpt-node-type` to `subgraph.loop` with
   the same `application/rpt-subgraph-id` payload, so a loop node can be dropped preconfigured.
   Label it with `workflowEditor.nodeTitle.subgraph.loop`. The generic palette already lists
   `subgraph.loop` from the catalog — this is just the preconfigured-drop convenience.
4. **Docs note:** append a "Loops" subsection to `docs/workflow-manual-tests.md` (2–4 manual
   steps: build a trivial counting sub-graph, drop a Sub-graph Loop, run, check trace/panel).
   This file is a living checklist the owner runs by hand — match its existing step format.

## Constraints (project law — violating any of these fails review)

- **No engine changes** (`workflowEngine.ts` untouched). No new deps. No eslint-disables.
- Every user-facing string through `t()`/`useOptionalT()` with keys in BOTH `en.ts` and `zh.ts`.
- Characterization tests must stay green untouched; only ADD tests.
- Verification gate before declaring done: `npm run typecheck && npm run check:deps && npm run test`
  — run the FULL suite, report the exact counts.
- Do not commit — leave changes in the working tree for the controller's final review.

## Out of scope (do not build)

- Loop constructs in the parent graph (cycles/back-edges) — the DAG stays a DAG.
- Per-iteration trace breakout (v1 traces show only the wrapper, same as `subgraph.call`).
- Parallel iteration (passes run strictly sequentially).
- Dynamic/typed boundary ports.
