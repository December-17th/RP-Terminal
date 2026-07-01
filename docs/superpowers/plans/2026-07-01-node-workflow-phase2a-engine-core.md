# Node Workflow Engine — Phase 2a: Engine Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the main-process workflow executor + node registry that runs a validated `WorkflowDoc` — topological execution, input wiring, branch-prune, pre/post-response phases, error-port routing, and cancellation — proven end-to-end with trivial in-test nodes, touching no existing generation code.

**Architecture:** A generic executor (`src/main/services/workflowEngine.ts`) drives a graph over a node **registry** (`src/main/services/nodes/`). Nodes are `{ ...NodeDescriptor, run(ctx, inputs) }`; the executor is generic over the registry and uses the pure `src/shared/workflow` algorithms (`validateWorkflow`, `topoOrder`) for correctness. Phase 2a uses only trivial test-defined nodes — the real generation nodes and the `generationService` re-plumb are Phase 2b.

**Tech Stack:** TypeScript, Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-01-node-workflow-engine-design.md` (§3 architecture, §4 run-context, §5 execution semantics, §10 error branches, §11 per-node state, §14 extensibility).

## Global Constraints

- **Module boundaries:** the engine lives in `src/main` and may import from `src/shared/workflow` (main→shared is allowed). It MUST NOT import from `src/renderer`. `src/shared/workflow/` stays pure (unchanged this phase). Run `npm run check:deps` after each task.
- **Verification gate:** before declaring the plan done, run `npm run typecheck && npm run check:deps && npm run test` — all must pass.
- **Test location:** Vitest suites under `test/workflow/` (mirrors existing `test/workflow/*`, `test/memory/`).
- **No touching generation code this phase:** do NOT modify `generationService`, `promptBuilder`, `apiService`, parsers, or add real generation nodes. Those are Phase 2b.
- **Prettier style:** no semicolons, single quotes, 2-space indent, no trailing commas.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Reuse the pure layer:** use `validateWorkflow`, `topoOrder` from `src/shared/workflow`; do NOT reimplement validation or topo ordering.

## File structure

- `src/main/services/nodes/types.ts` — runtime node types: `RunContext`, `NodeError`, `NodeResult`, `NodeRunFn`, `NodeImpl`.
- `src/main/services/nodes/registry.ts` — `NodeRegistry` + `createRegistry(impls)`.
- `src/main/services/workflowEngine.ts` — `runWorkflow(doc, registry, ctx)` + `RunResult`/`NodeTrace` + `WorkflowValidationError`.
- `test/workflow/registry.test.ts`, `test/workflow/engine.*.test.ts` — Vitest suites.

---

### Task 1: Node registry + runtime types

**Files:**
- Create: `src/main/services/nodes/types.ts`
- Create: `src/main/services/nodes/registry.ts`
- Test: `test/workflow/registry.test.ts`

**Interfaces:**
- Consumes: `NodeDescriptor` from `src/shared/workflow/types`.
- Produces:
  - `RunContext` (fields: `signal: AbortSignal`, `streamMain(delta: string): void`, `emitPanel(nodeId: string, delta: string): void`, `getNodeState(nodeId: string): unknown`, `setNodeState(nodeId: string, value: unknown): void`, `onResponseReady?(): void`)
  - `NodeError { kind: 'A'|'B'; message: string; code?: string; nodeId: string; attempts: number }`
  - `NodeResult { outputs?: Record<string, unknown>; signals?: string[] }`
  - `NodeRunFn = (ctx: RunContext, inputs: Record<string, unknown>) => NodeResult | Promise<NodeResult>`
  - `NodeImpl extends NodeDescriptor { run: NodeRunFn }`
  - `NodeRegistry { get(type): NodeImpl | undefined; has(type): boolean; descriptors(): Map<string, NodeDescriptor> }`
  - `createRegistry(impls: NodeImpl[]): NodeRegistry` (throws on duplicate type)

- [ ] **Step 1: Write the failing test**

Create `test/workflow/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl } from '../../src/main/services/nodes/types'

const impl = (type: string): NodeImpl => ({
  type,
  title: type,
  inputs: [{ name: 'in', type: 'Text' }],
  outputs: [{ name: 'out', type: 'Text' }],
  run: () => ({ outputs: { out: type } })
})

describe('createRegistry', () => {
  it('looks up impls by type', () => {
    const reg = createRegistry([impl('a'), impl('b')])
    expect(reg.get('a')?.type).toBe('a')
    expect(reg.has('b')).toBe(true)
    expect(reg.get('missing')).toBeUndefined()
  })

  it('exposes descriptors (ports without run) for validation', () => {
    const reg = createRegistry([impl('a')])
    const d = reg.descriptors()
    expect(d.get('a')?.outputs).toEqual([{ name: 'out', type: 'Text' }])
    // the descriptor must not carry run()
    expect('run' in (d.get('a') as object)).toBe(false)
  })

  it('throws on a duplicate node type', () => {
    expect(() => createRegistry([impl('a'), impl('a')])).toThrow(/duplicate node type/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/registry.test.ts`
Expected: FAIL — cannot resolve `../../src/main/services/nodes/registry`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/services/nodes/types.ts`:

```ts
// Runtime types for the node workflow engine (spec §4/§5/§10/§11). The pure port/graph model
// lives in src/shared/workflow; these types add the side-effectful run() surface (main-side).
import { NodeDescriptor } from '../../../shared/workflow/types'

/** The error value carried on a node's `error` output port (spec §10). */
export interface NodeError {
  kind: 'A' | 'B'
  message: string
  code?: string
  nodeId: string
  attempts: number
}

/** Per-turn runtime context threaded to every node's run() (spec §4). Phase 2a includes the
 *  executor-relevant hooks; Phase 2b augments this with domain fields (floors, settings, world,
 *  userAction, scanText, …) without reshaping the executor. */
export interface RunContext {
  /** Aborts the whole run when the turn is cancelled (Stop). */
  signal: AbortSignal
  /** The main-output node streams the reply here (→ chat message). */
  streamMain: (delta: string) => void
  /** A node with an opt-in panel streams its output here (→ collapsible panel). */
  emitPanel: (nodeId: string, delta: string) => void
  /** Durable per-(chat,node) scratchpad read (spec §11). */
  getNodeState: (nodeId: string) => unknown
  /** Durable per-(chat,node) scratchpad write (spec §11). */
  setNodeState: (nodeId: string, value: unknown) => void
  /** Invoked once, right after the main-output node completes, so the caller can deliver the
   *  response before post-response nodes finish (spec §5 phase boundary). */
  onResponseReady?: () => void
}

/** What a node's run() returns: values per output-port name, plus which Signal output ports
 *  fired (control/branch nodes — spec §5). */
export interface NodeResult {
  outputs?: Record<string, unknown>
  signals?: string[]
}

export type NodeRunFn = (
  ctx: RunContext,
  inputs: Record<string, unknown>
) => NodeResult | Promise<NodeResult>

/** A registered node type: its pure descriptor (ports, from shared) + its run(). */
export interface NodeImpl extends NodeDescriptor {
  run: NodeRunFn
}
```

Create `src/main/services/nodes/registry.ts`:

```ts
import { NodeDescriptor } from '../../../shared/workflow/types'
import { NodeImpl } from './types'

export interface NodeRegistry {
  get(type: string): NodeImpl | undefined
  has(type: string): boolean
  /** The pure descriptors (no run()) for validateWorkflow. */
  descriptors(): Map<string, NodeDescriptor>
}

/** Build a node registry from a list of impls. Adding a node type = pass another impl here;
 *  the executor is generic over the registry (spec §14 extensibility). Throws on duplicate types. */
export function createRegistry(impls: NodeImpl[]): NodeRegistry {
  const byType = new Map<string, NodeImpl>()
  for (const impl of impls) {
    if (byType.has(impl.type)) throw new Error(`duplicate node type "${impl.type}"`)
    byType.set(impl.type, impl)
  }
  return {
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    descriptors: () => {
      const out = new Map<string, NodeDescriptor>()
      for (const [type, impl] of byType) {
        const { run: _run, ...descriptor } = impl
        out.set(type, descriptor)
      }
      return out
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/nodes/types.ts src/main/services/nodes/registry.ts test/workflow/registry.test.ts
git commit -m "feat(workflow): node registry + runtime types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Executor core — validate, topo run, input wiring, branch-prune

**Files:**
- Create: `src/main/services/workflowEngine.ts`
- Test: `test/workflow/engine.core.test.ts`

**Interfaces:**
- Consumes: `WorkflowDoc` from `src/shared/workflow/types`; `validateWorkflow` from `src/shared/workflow/validate`; `topoOrder` from `src/shared/workflow/graph`; `RunContext`, `NodeResult`, `NodeError` from `./nodes/types`; `NodeRegistry` from `./nodes/registry`.
- Produces:
  - `class WorkflowValidationError extends Error { errors: ValidationError[] }`
  - `interface NodeTrace { nodeId: string; status: 'ran' | 'skipped' | 'failed'; phase: 'pre' | 'post'; error?: NodeError; ms?: number }`
  - `interface RunResult { ok: boolean; aborted: boolean; traces: NodeTrace[]; outputs: Map<string, Record<string, unknown>>; error?: NodeError }`
  - `function runWorkflow(doc: WorkflowDoc, registry: NodeRegistry, ctx: RunContext): Promise<RunResult>`

  In Task 2, `runWorkflow` runs every node in one topo pass (all `phase: 'pre'`); phases, error routing, and abort arrive in Tasks 3–5. A `control`-style node fires a subset of its Signal output ports via `NodeResult.signals`; edges from a Signal port that did NOT fire are dead, and any node whose incoming edges are all dead is skipped (branch-prune).

- [ ] **Step 1: Write the failing test**

Create `test/workflow/engine.core.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runWorkflow, WorkflowValidationError } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

// --- test harness ---------------------------------------------------------
const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

// nodes: `src` emits a constant; `upper` uppercases its `in`; `sink` records its `in` (main output);
// `gate` fires exactly one of its two Signal outputs based on config.which.
const impls: NodeImpl[] = [
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'hi' } })
  },
  {
    type: 'upper',
    title: 'upper',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: (_ctx, inputs) => ({ outputs: { out: String(inputs.in).toUpperCase() } })
  },
  {
    type: 'sink',
    title: 'sink',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    isMainOutputCapable: true,
    run: () => ({})
  },
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [
      { name: 'then', type: 'Signal' },
      { name: 'else', type: 'Signal' }
    ],
    run: (_ctx, _inputs) => ({ signals: ['then'] })
  },
  {
    // a branch target: gated by a Signal input, emits Text downstream
    type: 'branchTarget',
    title: 'branchTarget',
    inputs: [{ name: 'in', type: 'Signal' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'ran' } })
  }
]
const reg = createRegistry(impls)

describe('runWorkflow — core', () => {
  it('throws WorkflowValidationError on an invalid graph', async () => {
    // zero main-output nodes → invalid
    const d = doc([{ id: 's', type: 'src' }], [])
    await expect(runWorkflow(d, reg, ctx())).rejects.toBeInstanceOf(WorkflowValidationError)
  })

  it('runs a linear graph and wires outputs to downstream inputs', async () => {
    const d = doc(
      [
        { id: 's', type: 'src' },
        { id: 'u', type: 'upper' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 's', port: 'out' }, to: { node: 'u', port: 'in' } },
        { from: { node: 'u', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.outputs.get('u')).toEqual({ out: 'HI' })
    expect(res.traces.find((t) => t.nodeId === 'k')?.status).toBe('ran')
  })

  it('prunes the branch of a Signal port that did not fire', async () => {
    // gate fires `then`; the `else`-fed node must be skipped, the `then`-fed node runs.
    const d = doc(
      [
        { id: 'g', type: 'gate' },
        { id: 'a', type: 'branchTarget' },
        { id: 'b', type: 'branchTarget' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'g', port: 'then' }, to: { node: 'a', port: 'in' } },
        { from: { node: 'g', port: 'else' }, to: { node: 'b', port: 'in' } },
        { from: { node: 'a', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'a')?.status).toBe('ran')
    expect(res.traces.find((t) => t.nodeId === 'b')?.status).toBe('skipped')
  })
})
```

The branch-target nodes take a `Signal` input (`gate`'s `then`/`else` are `Signal` ports), so the graph passes `validateWorkflow`'s port-type check; `a` (fed by the fired `then`) runs and `b` (fed by the unfired `else`) is pruned.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/engine.core.test.ts`
Expected: FAIL — cannot resolve `../../src/main/services/workflowEngine`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/services/workflowEngine.ts`:

```ts
import { WorkflowDoc, Edge } from '../../shared/workflow/types'
import { validateWorkflow, ValidationError } from '../../shared/workflow/validate'
import { topoOrder } from '../../shared/workflow/graph'
import { NodeRegistry } from './nodes/registry'
import { RunContext, NodeError } from './nodes/types'

export class WorkflowValidationError extends Error {
  errors: ValidationError[]
  constructor(errors: ValidationError[]) {
    super(`invalid workflow: ${errors.map((e) => e.code).join(', ')}`)
    this.name = 'WorkflowValidationError'
    this.errors = errors
  }
}

export interface NodeTrace {
  nodeId: string
  status: 'ran' | 'skipped' | 'failed'
  phase: 'pre' | 'post'
  error?: NodeError
  ms?: number
}

export interface RunResult {
  ok: boolean
  aborted: boolean
  traces: NodeTrace[]
  outputs: Map<string, Record<string, unknown>>
  error?: NodeError
}

const edgeKey = (e: Edge): string => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`

/** Mutable state shared across the run passes. */
interface ExecState {
  outputs: Map<string, Record<string, unknown>>
  deadEdge: Set<string>
  skipped: Set<string>
  traces: NodeTrace[]
}

/** Run a list of node ids (already in topological order) against the registry, mutating `state`.
 *  Handles input wiring, branch-prune, and per-node output/signal bookkeeping. */
async function runNodes(
  ids: string[],
  doc: WorkflowDoc,
  registry: NodeRegistry,
  ctx: RunContext,
  state: ExecState,
  phase: 'pre' | 'post'
): Promise<void> {
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  const outgoing = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) {
    incoming.get(e.to.node)?.push(e)
    outgoing.get(e.from.node)?.push(e)
  }

  for (const id of ids) {
    const node = nodeById.get(id)!
    const impl = registry.get(node.type)!
    const ins = incoming.get(id) ?? []

    // Branch-prune: a node with ≥1 incoming edge, all dead, is skipped; its outgoing edges die too.
    if (ins.length > 0 && ins.every((e) => state.deadEdge.has(edgeKey(e)))) {
      state.skipped.add(id)
      for (const out of outgoing.get(id) ?? []) state.deadEdge.add(edgeKey(out))
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }

    // Gather inputs from live incoming edges (last edge into a port wins).
    const inputs: Record<string, unknown> = {}
    for (const e of ins) {
      if (state.deadEdge.has(edgeKey(e))) continue
      inputs[e.to.port] = state.outputs.get(e.from.node)?.[e.from.port]
    }

    const started = Date.now()
    const result = (await impl.run(ctx, inputs)) ?? {}
    state.outputs.set(id, result.outputs ?? {})
    state.traces.push({ nodeId: id, status: 'ran', phase, ms: Date.now() - started })

    // Kill edges from Signal output ports that did not fire (branch selection).
    const fired = new Set(result.signals ?? [])
    for (const out of outgoing.get(id) ?? []) {
      const port = impl.outputs.find((p) => p.name === out.from.port)
      if (port?.type === 'Signal' && !fired.has(out.from.port)) state.deadEdge.add(edgeKey(out))
    }
  }
}

/** Execute a workflow. Phase 2a runs every node in one topological pass. */
export async function runWorkflow(
  doc: WorkflowDoc,
  registry: NodeRegistry,
  ctx: RunContext
): Promise<RunResult> {
  const v = validateWorkflow(doc, registry.descriptors())
  if (!v.ok) throw new WorkflowValidationError(v.errors)

  const state: ExecState = {
    outputs: new Map(),
    deadEdge: new Set(),
    skipped: new Set(),
    traces: []
  }
  await runNodes(topoOrder(doc), doc, registry, ctx, state, 'pre')
  return { ok: true, aborted: false, traces: state.traces, outputs: state.outputs }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/engine.core.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/workflowEngine.ts test/workflow/engine.core.test.ts
git commit -m "feat(workflow): executor core — validate, topo run, wiring, branch-prune

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pre/post-response phases + onResponseReady

**Files:**
- Modify: `src/main/services/workflowEngine.ts` (add phase computation; split `runWorkflow` into two passes)
- Test: `test/workflow/engine.phases.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: no signature change to `runWorkflow`. New behavior: nodes that are the `isMainOutput` node or its ancestors run in the **pre** phase; all other nodes run in the **post** phase. `ctx.onResponseReady()` (if provided) is invoked once, after the pre pass completes (the main-output node is topologically last in the pre set) and before the post pass. `NodeTrace.phase` reflects each node's phase.
- Adds internal helper `computePhases(doc: WorkflowDoc): { preIds: Set<string>; postIds: Set<string> }`.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/engine.phases.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const order: string[] = []
const impls: NodeImpl[] = [
  {
    type: 'pre',
    title: 'pre',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => {
      order.push('pre-node')
      return { outputs: { out: 'x' } }
    }
  },
  {
    type: 'main',
    title: 'main',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    isMainOutputCapable: true,
    run: () => {
      order.push('main')
      return { outputs: { out: 'reply' } }
    }
  },
  {
    type: 'post',
    title: 'post',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    run: () => {
      order.push('post-node')
      return {}
    }
  }
]
const reg = createRegistry(impls)

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('runWorkflow — phases', () => {
  it('runs pre nodes, fires onResponseReady, then post nodes', async () => {
    order.length = 0
    const events: string[] = []
    const ctx: RunContext = {
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {},
      onResponseReady: () => events.push('ready')
    }
    // pre -> main (main output); main -> post (post phase, downstream of main output)
    const d = doc(
      [
        { id: 'p', type: 'pre' },
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'q', type: 'post' }
      ],
      [
        { from: { node: 'p', port: 'out' }, to: { node: 'm', port: 'in' } },
        { from: { node: 'm', port: 'out' }, to: { node: 'q', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx)
    expect(res.ok).toBe(true)
    // ordering: pre-node, main, ready, post-node
    expect([...order.slice(0, 2), 'ready', order[2]]).toEqual([
      'pre-node',
      'main',
      'ready',
      'post-node'
    ])
    expect(res.traces.find((t) => t.nodeId === 'p')?.phase).toBe('pre')
    expect(res.traces.find((t) => t.nodeId === 'm')?.phase).toBe('pre')
    expect(res.traces.find((t) => t.nodeId === 'q')?.phase).toBe('post')
  })

  it('puts an independent side node (no path to main output) in the post phase', async () => {
    order.length = 0
    const ctx: RunContext = {
      signal: new AbortController().signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }
    // `p2` feeds nothing that reaches main; it is background → post phase.
    const d = doc(
      [
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'p2', type: 'pre' }
      ],
      []
    )
    const res = await runWorkflow(d, reg, ctx)
    expect(res.traces.find((t) => t.nodeId === 'm')?.phase).toBe('pre')
    expect(res.traces.find((t) => t.nodeId === 'p2')?.phase).toBe('post')
  })
})
```

Note: the `main` impl declares an `in` input but the second test gives it no incoming edge — that is fine (a node may run with no inputs; `validateWorkflow` does not require every input port to be wired).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/engine.phases.test.ts`
Expected: FAIL — both assertions about `phase: 'post'` fail (Task 2 marks every node `'pre'` and never calls `onResponseReady`).

- [ ] **Step 3: Write minimal implementation**

In `src/main/services/workflowEngine.ts`, add the phase helper above `runWorkflow`:

```ts
/** Pre-phase = the main-output node and every node that can reach it (its ancestors). Everything
 *  else (downstream + independent side branches) is post-phase — async, off the hot path (spec §5). */
function computePhases(doc: WorkflowDoc): { preIds: Set<string>; postIds: Set<string> } {
  const main = doc.nodes.find((n) => n.isMainOutput)!.id
  const revAdj = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) revAdj.get(e.to.node)?.push(e.from.node)

  const preIds = new Set<string>([main])
  const stack = [main]
  while (stack.length) {
    const cur = stack.pop()!
    for (const parent of revAdj.get(cur) ?? []) {
      if (!preIds.has(parent)) {
        preIds.add(parent)
        stack.push(parent)
      }
    }
  }
  const postIds = new Set(doc.nodes.map((n) => n.id).filter((id) => !preIds.has(id)))
  return { preIds, postIds }
}
```

Replace the body of `runWorkflow` (the part after validation) with a two-pass run:

```ts
  const state: ExecState = {
    outputs: new Map(),
    deadEdge: new Set(),
    skipped: new Set(),
    traces: []
  }

  const order = topoOrder(doc)
  const { preIds, postIds } = computePhases(doc)

  await runNodes(
    order.filter((id) => preIds.has(id)),
    doc,
    registry,
    ctx,
    state,
    'pre'
  )
  ctx.onResponseReady?.()
  await runNodes(
    order.filter((id) => postIds.has(id)),
    doc,
    registry,
    ctx,
    state,
    'post'
  )

  return { ok: true, aborted: false, traces: state.traces, outputs: state.outputs }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/engine.phases.test.ts`
Then re-run Task 2's suite to confirm no regression: `npx vitest run test/workflow/engine.core.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/workflowEngine.ts test/workflow/engine.phases.test.ts
git commit -m "feat(workflow): pre/post-response phases + onResponseReady

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Error-port routing

**Files:**
- Modify: `src/main/services/workflowEngine.ts` (wrap `impl.run` in try/catch inside `runNodes`)
- Test: `test/workflow/engine.errors.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces: no signature change. New behavior when a node's `run` throws:
  - Build a `NodeError { kind: 'A', message, nodeId: id, attempts: 1 }`.
  - If the node has an output port named `error` of type `Error` **with at least one outgoing edge**, put the `NodeError` value on that `error` port, kill the node's other (non-`error`) outgoing edges (the normal branch is pruned), and trace `status: 'failed'` — the run continues down the error branch.
  - Otherwise (unwired): trace `status: 'failed'`; if the node is in the **pre** phase, the run stops immediately with `ok: false` and `error` set (turn aborts); if in the **post** phase, fail-open — record it and continue the remaining post nodes.
- `runNodes` returns a signal to stop: change it to return `Promise<{ fatal?: NodeError }>` so `runWorkflow` can halt after a fatal pre-phase failure.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/engine.errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const impls: NodeImpl[] = [
  {
    type: 'boom',
    title: 'boom',
    inputs: [],
    outputs: [
      { name: 'out', type: 'Text' },
      { name: 'error', type: 'Error' }
    ],
    run: () => {
      throw new Error('kaboom')
    }
  },
  {
    type: 'handler',
    title: 'handler',
    inputs: [{ name: 'err', type: 'Error' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: (_ctx, inputs) => ({ outputs: { out: 'handled:' + (inputs.err as { message: string }).message } })
  },
  {
    type: 'main',
    title: 'main',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    isMainOutputCapable: true,
    run: (_ctx, inputs) => ({ outputs: { out: inputs.in ?? 'reply' } })
  },
  {
    type: 'postboom',
    title: 'postboom',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'error', type: 'Error' }],
    run: () => {
      throw new Error('post failure')
    }
  }
]
const reg = createRegistry(impls)

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('runWorkflow — error routing', () => {
  it('routes a throw down a wired error branch and keeps the run ok', async () => {
    // boom throws -> error edge -> handler -> main
    const d = doc(
      [
        { id: 'b', type: 'boom' },
        { id: 'h', type: 'handler' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [
        { from: { node: 'b', port: 'error' }, to: { node: 'h', port: 'err' } },
        { from: { node: 'h', port: 'out' }, to: { node: 'm', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.traces.find((t) => t.nodeId === 'b')?.status).toBe('failed')
    expect(res.outputs.get('h')).toEqual({ out: 'handled:kaboom' })
  })

  it('fails the run when an unwired pre-phase node throws', async () => {
    // boom is the main output's ancestor with no error edge → fatal
    const d = doc(
      [
        { id: 'b', type: 'boom' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [{ from: { node: 'b', port: 'out' }, to: { node: 'm', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(false)
    expect(res.error?.nodeId).toBe('b')
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).not.toBe('ran')
  })

  it('fails open when an unwired post-phase node throws', async () => {
    // main output runs; a downstream post node throws with no error edge → recorded, run stays ok
    const d = doc(
      [
        { id: 'm', type: 'main', isMainOutput: true },
        { id: 'x', type: 'postboom' }
      ],
      [{ from: { node: 'm', port: 'out' }, to: { node: 'x', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.ok).toBe(true)
    expect(res.traces.find((t) => t.nodeId === 'x')?.status).toBe('failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/engine.errors.test.ts`
Expected: FAIL — the throw propagates out of `runWorkflow` (Task 2/3 has no try/catch), so the tests error instead of asserting.

- [ ] **Step 3: Write minimal implementation**

In `runNodes`, replace the single `impl.run` call block with a try/catch and change the return type. The full updated `runNodes` (and the `runWorkflow` call sites) is:

```ts
async function runNodes(
  ids: string[],
  doc: WorkflowDoc,
  registry: NodeRegistry,
  ctx: RunContext,
  state: ExecState,
  phase: 'pre' | 'post'
): Promise<{ fatal?: NodeError }> {
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  const outgoing = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) {
    incoming.get(e.to.node)?.push(e)
    outgoing.get(e.from.node)?.push(e)
  }

  for (const id of ids) {
    const node = nodeById.get(id)!
    const impl = registry.get(node.type)!
    const ins = incoming.get(id) ?? []
    const outs = outgoing.get(id) ?? []

    if (ins.length > 0 && ins.every((e) => state.deadEdge.has(edgeKey(e)))) {
      state.skipped.add(id)
      for (const out of outs) state.deadEdge.add(edgeKey(out))
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }

    const inputs: Record<string, unknown> = {}
    for (const e of ins) {
      if (state.deadEdge.has(edgeKey(e))) continue
      inputs[e.to.port] = state.outputs.get(e.from.node)?.[e.from.port]
    }

    const started = Date.now()
    try {
      const result = (await impl.run(ctx, inputs)) ?? {}
      state.outputs.set(id, result.outputs ?? {})
      state.traces.push({ nodeId: id, status: 'ran', phase, ms: Date.now() - started })
      const fired = new Set(result.signals ?? [])
      for (const out of outs) {
        const port = impl.outputs.find((p) => p.name === out.from.port)
        if (port?.type === 'Signal' && !fired.has(out.from.port)) state.deadEdge.add(edgeKey(out))
      }
    } catch (err) {
      const nodeError: NodeError = {
        kind: 'A',
        message: err instanceof Error ? err.message : String(err),
        nodeId: id,
        attempts: 1
      }
      const errorPort = impl.outputs.find((p) => p.name === 'error' && p.type === 'Error')
      const errorEdges = outs.filter((o) => o.from.port === 'error')
      const wired = !!errorPort && errorEdges.length > 0
      state.traces.push({ nodeId: id, status: 'failed', phase, error: nodeError, ms: Date.now() - started })
      if (wired) {
        // Deliver the error on the error port; kill the normal (non-error) branch.
        state.outputs.set(id, { error: nodeError })
        for (const out of outs) if (out.from.port !== 'error') state.deadEdge.add(edgeKey(out))
      } else {
        // Kill all outputs; a pre-phase unwired failure is fatal, a post-phase one fails open.
        for (const out of outs) state.deadEdge.add(edgeKey(out))
        if (phase === 'pre') return { fatal: nodeError }
      }
    }
  }
  return {}
}
```

Then update `runWorkflow`'s run section to honor a fatal pre-phase failure:

```ts
  const order = topoOrder(doc)
  const { preIds, postIds } = computePhases(doc)

  const pre = await runNodes(order.filter((id) => preIds.has(id)), doc, registry, ctx, state, 'pre')
  if (pre.fatal) {
    return { ok: false, aborted: false, traces: state.traces, outputs: state.outputs, error: pre.fatal }
  }
  ctx.onResponseReady?.()
  await runNodes(order.filter((id) => postIds.has(id)), doc, registry, ctx, state, 'post')

  return { ok: true, aborted: false, traces: state.traces, outputs: state.outputs }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/engine.errors.test.ts`
Then re-run Tasks 2–3 suites: `npx vitest run test/workflow/engine.core.test.ts test/workflow/engine.phases.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/workflowEngine.ts test/workflow/engine.errors.test.ts
git commit -m "feat(workflow): author-controlled error-port routing + phase-aware give-up

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Cancellation via AbortSignal

**Files:**
- Modify: `src/main/services/workflowEngine.ts` (check `ctx.signal.aborted` inside `runNodes`)
- Test: `test/workflow/engine.abort.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: no signature change. New behavior: before running each node, if `ctx.signal.aborted` is true, stop the pass; mark that node and all remaining nodes in the pass `status: 'skipped'`; the `RunResult` has `aborted: true` and `ok: false`. An abort during the pre pass also skips the post pass and does not fire `onResponseReady`.
- `runNodes` returns `{ fatal?: NodeError; aborted?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/engine.abort.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const impls: NodeImpl[] = [
  {
    type: 'aborter',
    title: 'aborter',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    // aborts the run from inside the first node
    run: (ctx) => {
      ;(ctx as { _ac: AbortController })._ac.abort()
      return { outputs: { out: 'x' } }
    }
  },
  {
    type: 'main',
    title: 'main',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [{ name: 'out', type: 'Text' }],
    isMainOutputCapable: true,
    run: () => ({ outputs: { out: 'reply' } })
  }
]
const reg = createRegistry(impls)

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('runWorkflow — cancellation', () => {
  it('stops the run and marks remaining nodes skipped when aborted mid-run', async () => {
    const ac = new AbortController()
    let readyFired = false
    const ctx = {
      signal: ac.signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {},
      onResponseReady: () => {
        readyFired = true
      },
      _ac: ac
    } as unknown as RunContext
    const d = doc(
      [
        { id: 'a', type: 'aborter' },
        { id: 'm', type: 'main', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'm', port: 'in' } }]
    )
    const res = await runWorkflow(d, reg, ctx)
    expect(res.aborted).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('skipped')
    expect(readyFired).toBe(false)
  })

  it('does not run at all when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx: RunContext = {
      signal: ac.signal,
      streamMain: () => {},
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }
    const d = doc([{ id: 'm', type: 'main', isMainOutput: true }], [])
    const res = await runWorkflow(d, reg, ctx)
    expect(res.aborted).toBe(true)
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('skipped')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/engine.abort.test.ts`
Expected: FAIL — Task 4's engine ignores `ctx.signal`, so `m` runs (`status: 'ran'`) and `aborted` is `false`.

- [ ] **Step 3: Write minimal implementation**

In `runNodes`, at the very top of the `for (const id of ids)` loop (before the prune check), add the abort check; and widen the return type. Add this as the first statement inside the loop:

```ts
    if (ctx.signal.aborted) {
      state.skipped.add(id)
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }
```

Change `runNodes`'s return type to `Promise<{ fatal?: NodeError; aborted?: boolean }>` and, after the `for` loop, return the aborted flag:

```ts
  return { aborted: ctx.signal.aborted }
```

(Keep the `return { fatal: nodeError }` inside the catch as-is.)

Then update `runWorkflow` to honor abort from either pass:

```ts
  const pre = await runNodes(order.filter((id) => preIds.has(id)), doc, registry, ctx, state, 'pre')
  if (pre.fatal) {
    return { ok: false, aborted: false, traces: state.traces, outputs: state.outputs, error: pre.fatal }
  }
  if (pre.aborted) {
    // mark any post nodes as skipped so the trace is complete, then bail without onResponseReady
    for (const id of order.filter((id) => postIds.has(id))) {
      state.traces.push({ nodeId: id, status: 'skipped', phase: 'post' })
    }
    return { ok: false, aborted: true, traces: state.traces, outputs: state.outputs }
  }
  ctx.onResponseReady?.()
  const post = await runNodes(order.filter((id) => postIds.has(id)), doc, registry, ctx, state, 'post')

  return { ok: !post.aborted, aborted: !!post.aborted, traces: state.traces, outputs: state.outputs }
```

- [ ] **Step 4: Run the full workflow suite + gate**

Run: `npx vitest run test/workflow/`
Expected: all `test/workflow/*` suites PASS (registry + the four engine suites + the Phase 1 suites).

Then the full gate:
Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: typecheck clean; `check:deps` no violations (the engine imports `src/shared/workflow` and `./nodes`, never `src/renderer`); full Vitest suite green.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/workflowEngine.ts test/workflow/engine.abort.test.ts
git commit -m "feat(workflow): cancellation via AbortSignal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2a exit criteria

- `src/main/services/nodes/{types,registry}.ts` and `src/main/services/workflowEngine.ts` exist and export the interfaces above.
- The executor runs a validated `WorkflowDoc` over a registry: linear wiring, branch-prune, pre/post phases + `onResponseReady`, author-controlled error-port routing (pre-fatal / post-fail-open), and abort — all covered by `test/workflow/engine.*.test.ts`.
- Full gate green; no `src/renderer` import from the engine; no changes to any existing generation code.

## What Phase 2a deliberately excludes (Phase 2b)

- The **real built-in node catalog** (`input.context`, `memory.recall/gate/extract/write`, `prompt.assemble`/`prompt.messages`/`merge.messages`/`text.template`, `llm.sample`, `parse.response`, `apply.mvu`/`apply.regex`/`mvu.set`, `output.writeFloor`, `control.if`/`switch`/`when`) delegating to existing services.
- The **built-in default graph** and the **parity characterization test** (default graph ⇒ byte-identical prompt + same floor as today's pipeline).
- Re-plumbing `generationService.generate()` to resolve + run a workflow.
- Per-node persistent state store (`nodeStateService`), RPM limiting, persistence (`workflows` table), and the React Flow editor — later phases per the spec.
