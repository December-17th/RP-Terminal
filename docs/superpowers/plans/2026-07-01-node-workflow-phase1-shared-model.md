# Node Workflow Engine — Phase 1: Shared Graph Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, environment-agnostic graph foundation (`src/shared/workflow/`) for the node
workflow engine — types, port-type compatibility, topological ordering + cycle detection, branch-prune
resolution, and whole-document validation — fully unit-tested, with zero `main`/`renderer`/Electron
dependencies.

**Architecture:** A single pure module under `src/shared/workflow/`, mirroring the purity of
`src/shared/combat/`. Nothing here performs I/O or calls services; it operates on plain `WorkflowDoc`
data structures and a caller-supplied map of node descriptors. The main-process executor (Phase 2) and the
renderer editor (Phase 5) both consume this module.

**Tech Stack:** TypeScript, Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-01-node-workflow-engine-design.md` (§4 data model, §5 execution
semantics, §14 extensibility, §15 boundaries, §16 testing).

## Global Constraints

- **Purity:** `src/shared/workflow/` MUST NOT import from `src/main`, `src/renderer`, `src/preload`, or
  `electron`. Enforced by the existing dependency-cruiser rule `shared-not-to-main-renderer` (already covers
  `^src/shared`). Run `npm run check:deps` after each task.
- **Verification gate:** before declaring the plan done, run `npm run typecheck && npm run check:deps && npm run test` — all must pass.
- **Test location:** Vitest suites live under `test/workflow/` (mirrors `test/memory/`, `test/combat/`).
- **No behavior in types-only files:** every task ships real, tested behavior.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Port types (fixed set for Phase 1):** `Messages`, `Text`, `Vars`, `Floors`, `Context`, `Signal`,
  `Error`, `Any` (spec §4).

---

### Task 1: Port model + type compatibility

**Files:**
- Create: `src/shared/workflow/types.ts`
- Test: `test/workflow/portCompat.test.ts`

**Interfaces:**
- Produces:
  - `PORT_TYPES: readonly PortType[]`
  - `type PortType = 'Messages'|'Text'|'Vars'|'Floors'|'Context'|'Signal'|'Error'|'Any'`
  - `interface PortSpec { name: string; type: PortType }`
  - `interface NodeDescriptor { type: string; title: string; inputs: PortSpec[]; outputs: PortSpec[]; isMainOutputCapable?: boolean }`
  - `interface NodeInstance { id: string; type: string; config?: Record<string, unknown>; position?: { x: number; y: number }; panel?: { show: boolean; label?: string; collapsed?: boolean }; isMainOutput?: boolean }`
  - `interface EdgeEnd { node: string; port: string }`
  - `interface Edge { from: EdgeEnd; to: EdgeEnd }`
  - `interface WorkflowDoc { id: string; name: string; version: number; schemaVersion: number; description?: string; nodes: NodeInstance[]; edges: Edge[]; meta?: Record<string, unknown> }`
  - `function portCompatible(from: PortType, to: PortType): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/portCompat.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { portCompatible } from '../../src/shared/workflow/types'

describe('portCompatible', () => {
  it('accepts identical types', () => {
    expect(portCompatible('Messages', 'Messages')).toBe(true)
    expect(portCompatible('Signal', 'Signal')).toBe(true)
  })

  it('rejects mismatched concrete types', () => {
    expect(portCompatible('Text', 'Messages')).toBe(false)
    expect(portCompatible('Signal', 'Text')).toBe(false)
    expect(portCompatible('Error', 'Vars')).toBe(false)
  })

  it('treats Any as a wildcard in both directions', () => {
    expect(portCompatible('Any', 'Messages')).toBe(true)
    expect(portCompatible('Error', 'Any')).toBe(true)
    expect(portCompatible('Any', 'Any')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/portCompat.test.ts`
Expected: FAIL — cannot resolve module `../../src/shared/workflow/types`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/workflow/types.ts`:

```ts
// Pure graph model for the node workflow engine (spec §4). No I/O; safe to import from
// main, renderer, preload, and tests. See docs/superpowers/specs/2026-07-01-node-workflow-engine-design.md.

export const PORT_TYPES = [
  'Messages',
  'Text',
  'Vars',
  'Floors',
  'Context',
  'Signal',
  'Error',
  'Any'
] as const

export type PortType = (typeof PORT_TYPES)[number]

export interface PortSpec {
  name: string
  type: PortType
}

/** The pure, side-effect-free description of a node type: its ports and metadata.
 *  Main pairs each descriptor with a `run()` implementation (Phase 2); validation uses only this. */
export interface NodeDescriptor {
  type: string
  title: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  isMainOutputCapable?: boolean
}

export interface NodeInstance {
  id: string
  type: string
  config?: Record<string, unknown>
  position?: { x: number; y: number }
  panel?: { show: boolean; label?: string; collapsed?: boolean }
  isMainOutput?: boolean
}

export interface EdgeEnd {
  node: string
  port: string
}

export interface Edge {
  from: EdgeEnd
  to: EdgeEnd
}

export interface WorkflowDoc {
  id: string
  name: string
  version: number
  schemaVersion: number
  description?: string
  nodes: NodeInstance[]
  edges: Edge[]
  meta?: Record<string, unknown>
}

/** Whether an output port of type `from` may connect to an input port of type `to`.
 *  `Any` is a wildcard both ways; otherwise types must match exactly (spec §4). */
export function portCompatible(from: PortType, to: PortType): boolean {
  if (from === 'Any' || to === 'Any') return true
  return from === to
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/portCompat.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workflow/types.ts test/workflow/portCompat.test.ts
git commit -m "feat(workflow): pure graph model types + port compatibility

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Topological ordering + cycle detection

**Files:**
- Create: `src/shared/workflow/graph.ts`
- Test: `test/workflow/graph.test.ts`

**Interfaces:**
- Consumes: `WorkflowDoc`, `Edge` from `./types`
- Produces:
  - `class GraphCycleError extends Error`
  - `function topoOrder(doc: WorkflowDoc): string[]` — node ids in a valid execution order; throws `GraphCycleError` if the graph is not a DAG. Node-level ordering: multiple edges between the same pair of nodes count as one dependency.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { topoOrder, GraphCycleError } from '../../src/shared/workflow/graph'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const node = (id: string): NodeInstance => ({ id, type: 't' })
const edge = (from: string, to: string): Edge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' }
})
const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('topoOrder', () => {
  it('orders a linear chain a->b->c', () => {
    const order = topoOrder(doc([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('includes disconnected nodes', () => {
    const order = topoOrder(doc([node('a'), node('b')], []))
    expect(order.sort()).toEqual(['a', 'b'])
  })

  it('collapses duplicate edges between the same node pair', () => {
    // Two edges a->b (different ports) must not inflate indegree into a false cycle.
    const order = topoOrder(
      doc(
        [node('a'), node('b')],
        [
          { from: { node: 'a', port: 'o1' }, to: { node: 'b', port: 'i1' } },
          { from: { node: 'a', port: 'o2' }, to: { node: 'b', port: 'i2' } }
        ]
      )
    )
    expect(order).toEqual(['a', 'b'])
  })

  it('throws GraphCycleError on a cycle', () => {
    expect(() => topoOrder(doc([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]))).toThrow(
      GraphCycleError
    )
  })

  it('throws GraphCycleError on a self-edge', () => {
    expect(() => topoOrder(doc([node('a')], [edge('a', 'a')]))).toThrow(GraphCycleError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/graph.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/workflow/graph`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/workflow/graph.ts`:

```ts
import { WorkflowDoc } from './types'

export class GraphCycleError extends Error {
  constructor(message = 'workflow graph has a cycle') {
    super(message)
    this.name = 'GraphCycleError'
  }
}

/** Kahn's algorithm over NODE-level dependencies. Duplicate edges between the same pair of
 *  nodes count once. Throws GraphCycleError if the graph is not a DAG (spec §5). */
export function topoOrder(doc: WorkflowDoc): string[] {
  const ids = doc.nodes.map((n) => n.id)
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  const seenPair = new Set<string>()

  for (const e of doc.edges) {
    if (!indeg.has(e.from.node) || !indeg.has(e.to.node)) continue
    const key = `${e.from.node} ${e.to.node}`
    if (seenPair.has(key)) continue
    seenPair.add(key)
    adj.get(e.from.node)!.push(e.to.node)
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1)
  }

  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }

  if (order.length !== ids.length) throw new GraphCycleError()
  return order
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/graph.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workflow/graph.ts test/workflow/graph.test.ts
git commit -m "feat(workflow): topological ordering + cycle detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Branch-prune resolution

**Files:**
- Modify: `src/shared/workflow/graph.ts` (append `prunedNodes`)
- Test: `test/workflow/prune.test.ts`

**Interfaces:**
- Consumes: `WorkflowDoc`, `Edge` from `./types`
- Produces:
  - `function prunedNodes(doc: WorkflowDoc, inactiveEdges: Edge[]): Set<string>` — given the edges that did NOT fire (e.g. an un-taken `Signal` branch), returns the set of node ids that become unreachable. Rule: a node with ≥1 incoming edge is pruned when ALL its incoming edges are dead; pruning a node marks its outgoing edges dead; iterate to a fixpoint. Root nodes (no incoming edges) are never pruned by gating (spec §5, "branch prune").

- [ ] **Step 1: Write the failing test**

Create `test/workflow/prune.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prunedNodes } from '../../src/shared/workflow/graph'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

const node = (id: string): NodeInstance => ({ id, type: 't' })
const e = (from: string, fp: string, to: string, tp: string): Edge => ({
  from: { node: from, port: fp },
  to: { node: to, port: tp }
})
const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('prunedNodes', () => {
  it('prunes a node whose only feeder edge is inactive, and propagates downstream', () => {
    // gate --sig--> job --> sink ; gate's signal did not fire
    const edges = [e('gate', 'sig', 'job', 'in'), e('job', 'out', 'sink', 'in')]
    const pruned = prunedNodes(doc([node('gate'), node('job'), node('sink')], edges), [edges[0]])
    expect(pruned).toEqual(new Set(['job', 'sink']))
  })

  it('does not prune a node that still has a live input', () => {
    // live --> merge ; gate --sig(dead)--> merge  => merge survives (one live input)
    const edges = [e('live', 'out', 'merge', 'a'), e('gate', 'sig', 'merge', 'b')]
    const pruned = prunedNodes(doc([node('live'), node('gate'), node('merge')], edges), [edges[1]])
    expect(pruned.has('merge')).toBe(false)
  })

  it('never prunes root nodes (no incoming edges)', () => {
    const pruned = prunedNodes(doc([node('root')], []), [])
    expect(pruned.size).toBe(0)
  })

  it('returns empty when nothing is inactive', () => {
    const edges = [e('a', 'out', 'b', 'in')]
    const pruned = prunedNodes(doc([node('a'), node('b')], edges), [])
    expect(pruned.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/prune.test.ts`
Expected: FAIL — `prunedNodes` is not exported from `./graph`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/shared/workflow/graph.ts`:

```ts
import { Edge } from './types'

const edgeKey = (e: Edge): string => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`

/** Given the edges that did not fire (inactive Signal branches, etc.), compute the nodes that
 *  become unreachable. A node with ≥1 incoming edge is pruned when ALL its incoming edges are
 *  dead; pruning propagates to its outgoing edges. Roots (no incoming) are never pruned. */
export function prunedNodes(doc: WorkflowDoc, inactiveEdges: Edge[]): Set<string> {
  const dead = new Set<string>(inactiveEdges.map(edgeKey))
  const pruned = new Set<string>()
  const incoming = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))
  const outgoing = new Map<string, Edge[]>(doc.nodes.map((n) => [n.id, []]))

  for (const e of doc.edges) {
    incoming.get(e.to.node)?.push(e)
    outgoing.get(e.from.node)?.push(e)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const n of doc.nodes) {
      if (pruned.has(n.id)) continue
      const ins = incoming.get(n.id) ?? []
      if (ins.length === 0) continue // root
      if (ins.every((e) => dead.has(edgeKey(e)))) {
        pruned.add(n.id)
        for (const out of outgoing.get(n.id) ?? []) {
          if (!dead.has(edgeKey(out))) {
            dead.add(edgeKey(out))
            changed = true
          }
        }
        changed = true
      }
    }
  }

  return pruned
}
```

Note: `import { Edge } from './types'` — merge this into the existing import line at the top of the file so
there is a single `import { WorkflowDoc, Edge } from './types'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/prune.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workflow/graph.ts test/workflow/prune.test.ts
git commit -m "feat(workflow): branch-prune resolution

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Whole-document validation

**Files:**
- Create: `src/shared/workflow/validate.ts`
- Test: `test/workflow/validate.test.ts`

**Interfaces:**
- Consumes: `WorkflowDoc`, `NodeDescriptor`, `portCompatible` from `./types`; `topoOrder`, `GraphCycleError` from `./graph`
- Produces:
  - `interface ValidationError { code: string; message: string; nodeId?: string }`
  - `type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] }`
  - `function validateWorkflow(doc: WorkflowDoc, descriptors: Map<string, NodeDescriptor>): ValidationResult` — checks: unique node ids, known node types, edges reference existing nodes + declared ports, port-type compatibility, exactly one `isMainOutput` node, and DAG-ness (spec §4, §5, §12 validation gate).

- [ ] **Step 1: Write the failing test**

Create `test/workflow/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow/validate'
import { WorkflowDoc, NodeDescriptor, NodeInstance, Edge } from '../../src/shared/workflow/types'

const descriptors = new Map<string, NodeDescriptor>([
  ['src', { type: 'src', title: 'Src', inputs: [], outputs: [{ name: 'out', type: 'Text' }] }],
  [
    'sink',
    {
      type: 'sink',
      title: 'Sink',
      inputs: [{ name: 'in', type: 'Text' }],
      outputs: [],
      isMainOutputCapable: true
    }
  ]
])

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

const good = (): WorkflowDoc =>
  doc(
    [
      { id: 'a', type: 'src' },
      { id: 'b', type: 'sink', isMainOutput: true }
    ],
    [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
  )

describe('validateWorkflow', () => {
  it('accepts a well-formed graph', () => {
    expect(validateWorkflow(good(), descriptors)).toEqual({ ok: true })
  })

  it('rejects an unknown node type', () => {
    const d = good()
    d.nodes[0].type = 'nope'
    const r = validateWorkflow(d, descriptors)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.errors.some((e) => e.code === 'UNKNOWN_TYPE')).toBe(true)
  })

  it('rejects an edge to a non-existent port', () => {
    const d = good()
    d.edges[0].to.port = 'missing'
    const r = validateWorkflow(d, descriptors)
    expect(r.ok === false && r.errors.some((e) => e.code === 'EDGE_PORT')).toBe(true)
  })

  it('rejects incompatible port types', () => {
    const withVars = new Map(descriptors)
    withVars.set('vsrc', { type: 'vsrc', title: 'V', inputs: [], outputs: [{ name: 'out', type: 'Vars' }] })
    const d = doc(
      [
        { id: 'a', type: 'vsrc' },
        { id: 'b', type: 'sink', isMainOutput: true }
      ],
      [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }]
    )
    const r = validateWorkflow(d, withVars)
    expect(r.ok === false && r.errors.some((e) => e.code === 'PORT_TYPE')).toBe(true)
  })

  it('requires exactly one main-output node', () => {
    const d = good()
    d.nodes[1].isMainOutput = false
    const r = validateWorkflow(d, descriptors)
    expect(r.ok === false && r.errors.some((e) => e.code === 'MAIN_OUTPUT')).toBe(true)
  })

  it('rejects a cycle', () => {
    const cyc = new Map(descriptors)
    cyc.set('mid', {
      type: 'mid',
      title: 'Mid',
      inputs: [{ name: 'in', type: 'Text' }],
      outputs: [{ name: 'out', type: 'Text' }],
      isMainOutputCapable: true
    })
    const d = doc(
      [
        { id: 'a', type: 'mid', isMainOutput: true },
        { id: 'b', type: 'mid' }
      ],
      [
        { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
        { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } }
      ]
    )
    const r = validateWorkflow(d, cyc)
    expect(r.ok === false && r.errors.some((e) => e.code === 'CYCLE')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/validate.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/workflow/validate`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/workflow/validate.ts`:

```ts
import { WorkflowDoc, NodeDescriptor, NodeInstance, PortType, portCompatible } from './types'
import { topoOrder, GraphCycleError } from './graph'

export interface ValidationError {
  code: string
  message: string
  nodeId?: string
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] }

type PortLookup = { nodeMissing: true } | { nodeMissing: false; type?: PortType }

/** Validate a workflow document against a map of known node descriptors (spec §12 validation gate). */
export function validateWorkflow(
  doc: WorkflowDoc,
  descriptors: Map<string, NodeDescriptor>
): ValidationResult {
  const errors: ValidationError[] = []
  const nodeById = new Map<string, NodeInstance>(doc.nodes.map((n) => [n.id, n]))

  if (nodeById.size !== doc.nodes.length)
    errors.push({ code: 'DUP_NODE_ID', message: 'duplicate node ids' })

  for (const n of doc.nodes) {
    if (!descriptors.has(n.type))
      errors.push({ code: 'UNKNOWN_TYPE', message: `unknown node type "${n.type}"`, nodeId: n.id })
  }

  const portOf = (nodeId: string, port: string, dir: 'inputs' | 'outputs'): PortLookup => {
    const n = nodeById.get(nodeId)
    if (!n) return { nodeMissing: true }
    const spec = descriptors.get(n.type)?.[dir].find((p) => p.name === port)
    return { nodeMissing: false, type: spec?.type }
  }

  for (const e of doc.edges) {
    const out = portOf(e.from.node, e.from.port, 'outputs')
    const inp = portOf(e.to.node, e.to.port, 'inputs')
    if (out.nodeMissing || inp.nodeMissing) {
      errors.push({ code: 'EDGE_NODE', message: 'edge references a missing node' })
      continue
    }
    if (out.type === undefined) {
      errors.push({ code: 'EDGE_PORT', message: `no output port "${e.from.port}" on ${e.from.node}` })
      continue
    }
    if (inp.type === undefined) {
      errors.push({ code: 'EDGE_PORT', message: `no input port "${e.to.port}" on ${e.to.node}` })
      continue
    }
    if (!portCompatible(out.type, inp.type))
      errors.push({
        code: 'PORT_TYPE',
        message: `${out.type} → ${inp.type} incompatible`,
        nodeId: e.to.node
      })
  }

  const mains = doc.nodes.filter((n) => n.isMainOutput)
  if (mains.length !== 1)
    errors.push({
      code: 'MAIN_OUTPUT',
      message: `expected exactly 1 main-output node, found ${mains.length}`
    })

  try {
    topoOrder(doc)
  } catch (err) {
    if (err instanceof GraphCycleError) errors.push({ code: 'CYCLE', message: 'graph has a cycle' })
    else throw err
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full verification gate**

Run: `npm run typecheck && npm run check:deps && npm run test`
Expected: typecheck clean; `check:deps` reports no violations (the new `src/shared/workflow/*` files import nothing from main/renderer); all Vitest suites pass, including the four new `test/workflow/*` files.

- [ ] **Step 6: Commit**

```bash
git add src/shared/workflow/validate.ts test/workflow/validate.test.ts
git commit -m "feat(workflow): whole-document validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 1 exit criteria

- `src/shared/workflow/` exports: `types.ts` (model + `portCompatible`), `graph.ts` (`topoOrder`,
  `GraphCycleError`, `prunedNodes`), `validate.ts` (`validateWorkflow`).
- All four `test/workflow/*` suites pass; the full gate (`typecheck` + `check:deps` + `test`) is green.
- No imports from `main`/`renderer`/`preload`/`electron` anywhere under `src/shared/workflow/`.

## What Phase 1 deliberately excludes (later phases)

- The node **registry with `run()`** implementations and the built-in node **catalog** (Phase 2, main).
- The `workflowEngine` executor, run-context, streaming, per-node panels, phases (Phase 2).
- Persistence (`workflows` table/service/IPC), `node_state` store, `.rptflow` import/export (Phase 3).
- RPM limiting (Phase 4), the React Flow editor (Phase 5), agentic/tool/MVU-trigger nodes (Phase 6+).
- **Prerequisite for Phase 2:** land `feat/memory-system-integration` in main first — the default graph's
  memory nodes delegate to the decomposed memory services.
