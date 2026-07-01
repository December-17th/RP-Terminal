# Node Workflow Engine — Phase 2b-2: Agentic Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the agentic node set the default graph doesn't need — `prompt.messages`, `merge.messages`,
`text.template`, `control.if` / `control.switch` / `control.when`, `mvu.set` — plus the two engine
capabilities they require (per-node config delivery and Signal-gating prune) and the durable per-node
state store (`node_state`) spec §11 promises.

**Architecture:** All new node impls are thin `NodeImpl`s in `src/main/services/nodes/builtin/`,
registered in the existing `builtinRegistry`. The engine gains two small, additive behaviors:
`run(ctx, inputs, node)` now receives the node's id + (zod-validated) config, and a node wired to
Signal outputs is pruned unless at least one of those signals fired (spec §5). `mvu.set` delegates to
the existing `applyVariableOps` write-back bridge, which moves (verbatim, with re-exports) from
`generationService.ts` into `generation/varsWrite.ts` to avoid an import cycle. **Default-graph parity
is untouched** — the existing `test/generation/generateParity*.test.ts` suites must stay green after
every task.

**Tech Stack:** TypeScript, Vitest, zod v4 (already a dependency). No new runtime dependencies.

## Global Constraints

- **Parity stays green.** No behavioral change to the default graph. `test/generation/generateParity.test.ts`
  and `generateParity.abort.test.ts` pass unchanged after every task.
- **Module boundaries.** New code lives in `src/main` (may import `src/shared/*`); never imports renderer.
  `npm run check:deps` clean — the `varsWrite` extraction exists precisely to avoid a
  `generationService ↔ nodes/builtin` cycle.
- **Verification gate per task:** `npm run typecheck && npm run check:deps && npm run test`.
- **Prettier:** no semicolons, single quotes, 2-space indent, no trailing commas.
- **Fan-in rule (settled):** multi-input nodes use DISTINCT input ports (`merge.messages` has `a`–`d`).
- **No card-facing surface change:** no `docs/sdk/` or i18n impact (main-process only, no UI strings).
- Characterization tests updated deliberately in the same commit when a pinned behavior intentionally
  changes (only `turnContext.test.ts`'s node-state stub assertion, Task 3).

## Settled design decisions (grounded 2026-07-01)

1. **`run(ctx, inputs, node)`** — third arg `NodeMeta { id, config }`. Existing impls take fewer params
   (TS-legal, untouched). `NodeImpl.configSchema?: ZodType` — when present the engine parses
   `node.config ?? {}` through it *inside* the per-node try, so a bad config follows the normal
   node-failure path (pre-phase fatal / post-phase fail-open / error port when wired).
2. **Signal gating** — engine rule: if a node has ≥1 incoming edge whose *source output port* is
   `Signal`-typed and ALL of those are dead, the node is skipped even if data edges are live
   (spec §5 "a node gated by a Signal runs only if that signal fired"). Gateable nodes declare a
   `when: Signal` input; `llm.sample` gets one too (additive, unwired in the default graph → parity-safe).
3. **Interpolation order** (`text.template`, `prompt.messages` rows): context macros (`expandMacros`) +
   EJS (`evalTemplate`) run FIRST and only when a `gen: Context` input is wired (they need
   vars/globals); the `{{in1}}`–`{{in4}}` upstream-slot placeholders are substituted LAST so upstream
   text is data, never executable template code. `{{inN}}` is not a known macro, so `expandMacros`
   leaves it alone (verified: unknown macros untouched, `src/shared/macros.ts:81`).
4. **Provider correctness** (spec §8) — a new pure helper `providerShape(settings, messages)`
   (`systemToUser` → `mergeConsecutiveRoles` → `orderForProvider`, same conditions as
   `assemble.ts:207–234`) applied by `prompt.messages`/`merge.messages` when `gen` is wired.
   `assemblePrompt` keeps its inline copy deliberately (parity > DRY here; noted in the helper's doc).
5. **Upstream slots are fixed ports `in1`–`in4`** (`Any`). NodeDescriptor ports are static per type;
   dynamic per-instance ports are an editor-phase concern.
6. **`mvu.set`** writes to the LATEST floor through `applyVariableOps` (spec §11 names it), converting
   its dot/bracket config path to a JSON pointer. `applyVariableOps` + its runaway-loop guard move
   verbatim to `generation/varsWrite.ts`, re-exported from `generationService` (same pattern as
   `composeAddendum`/`applyEvent` in 2b-1a).
7. **`node_state`** — new SQLite table `(chat_id, node_id) PRIMARY KEY, data TEXT, updated_at TEXT`,
   `ON DELETE CASCADE` from chats. `nodeStateService.get/set`; `buildTurnContext` wires
   `ctx.getNodeState/setNodeState` to it. DB is a no-op stub under vitest
   (`test/mocks/better-sqlite3.ts`), so tests cover the pure encode/decode helpers + delegation only
   (established pattern, see `test/memory/memoryStore.test.ts` header).
8. **`control.when` `changed` op** — fires when the JSON encoding of the watched value differs from the
   node-state-remembered last-fired value; empty state (first sight) counts as changed; state updates
   only when it fires.
9. **Not in this phase:** workflow persistence/selection (`workflows` table — own phase, spec §12),
   retry/fallback/validator config (D10 primitives), error output ports on the new nodes, memory node
   decomposition, editor UI.

---

### Task 1: Engine — NodeMeta third run() arg + configSchema validation

**Files:**
- Modify: `src/main/services/nodes/types.ts`
- Modify: `src/main/services/workflowEngine.ts` (runNodes try block)
- Test: `test/workflow/engine.meta.test.ts` (new)

**Interfaces:**
- Produces: `NodeMeta { id: string; config: Record<string, unknown> }`; `NodeRunFn` third param;
  `NodeImpl.configSchema?: ZodType`. All later node tasks consume `node.config` (already
  schema-parsed) and `node.id`.

- [x] **Step 1: Write the failing test** (`test/workflow/engine.meta.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, NodeMeta, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

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

const seen: NodeMeta[] = []

const echoMeta: NodeImpl = {
  type: 'echoMeta',
  title: 'echoMeta',
  inputs: [],
  outputs: [],
  isMainOutputCapable: true,
  run: (_ctx, _inputs, node) => {
    seen.push(node)
    return {}
  }
}

const needsNumber: NodeImpl = {
  type: 'needsNumber',
  title: 'needsNumber',
  inputs: [],
  outputs: [],
  isMainOutputCapable: true,
  configSchema: z.object({ n: z.number().default(7) }),
  run: (_ctx, _inputs, node) => {
    seen.push(node)
    return {}
  }
}

const reg = createRegistry([echoMeta, needsNumber])

describe('runWorkflow — node meta + config', () => {
  beforeEach(() => {
    seen.length = 0
  })

  it('passes the node id and raw config to run() when no schema is declared', async () => {
    const d = doc([{ id: 'e1', type: 'echoMeta', config: { a: 1 }, isMainOutput: true }], [])
    await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([{ id: 'e1', config: { a: 1 } }])
  })

  it('defaults config to {} when the instance has none', async () => {
    const d = doc([{ id: 'e1', type: 'echoMeta', isMainOutput: true }], [])
    await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([{ id: 'e1', config: {} }])
  })

  it('parses config through configSchema (applying defaults)', async () => {
    const d = doc([{ id: 'n1', type: 'needsNumber', config: {}, isMainOutput: true }], [])
    await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([{ id: 'n1', config: { n: 7 } }])
  })

  it('an invalid config fails the node (pre-phase fatal), run() never called', async () => {
    const d = doc(
      [{ id: 'n1', type: 'needsNumber', config: { n: 'not a number' }, isMainOutput: true }],
      []
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(seen).toEqual([])
    expect(res.ok).toBe(false)
    expect(res.error?.nodeId).toBe('n1')
    expect(res.traces.find((t) => t.nodeId === 'n1')?.status).toBe('failed')
  })
})
```

- [x] **Step 2: Run it — expect FAIL** (`npx vitest run test/workflow/engine.meta.test.ts`) —
  compile error: run's third param / `NodeMeta` / `configSchema` don't exist.

- [x] **Step 3: Implement.** In `src/main/services/nodes/types.ts` add (after `NodeResult`):

```ts
import { ZodType } from 'zod'

/** Per-instance info handed to run(): the node's id (node-state key) and its config —
 *  already parsed through the impl's configSchema when one is declared. */
export interface NodeMeta {
  id: string
  config: Record<string, unknown>
}

export type NodeRunFn = (
  ctx: RunContext,
  inputs: Record<string, unknown>,
  node: NodeMeta
) => NodeResult | Promise<NodeResult>

export interface NodeImpl extends NodeDescriptor {
  run: NodeRunFn
  /** Optional zod schema for NodeInstance.config; the engine parses config through it before
   *  run() — a parse failure follows the normal node-failure path (spec §12/§14). */
  configSchema?: ZodType
}
```

In `workflowEngine.ts` runNodes, replace the `impl.run` call inside the try:

```ts
const config = (
  impl.configSchema ? impl.configSchema.parse(node.config ?? {}) : (node.config ?? {})
) as Record<string, unknown>
const result = (await impl.run(ctx, inputs, { id, config })) ?? {}
```

- [x] **Step 4: Run tests — PASS**, then the full gate.
- [x] **Step 5: Commit** — `feat(workflow): pass node id + zod-parsed config to run()`

---

### Task 2: Engine — Signal-gating prune + `when` input on llm.sample

**Files:**
- Modify: `src/main/services/workflowEngine.ts` (runNodes prune block)
- Modify: `src/main/services/nodes/builtin/generationNodes.ts` (llmSample inputs)
- Test: `test/workflow/engine.signalGate.test.ts` (new)

**Interfaces:**
- Produces: gating semantics all control-node branches rely on; the `when: Signal` port convention.

- [x] **Step 1: Write the failing test** (`test/workflow/engine.signalGate.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'
import { llmSample } from '../../src/main/services/nodes/builtin/generationNodes'

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

// `gate` fires per config.fire; `job` has a data input AND a when Signal input.
const impls: NodeImpl[] = [
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'data' } })
  },
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [{ name: 'fire', type: 'Signal' }],
    run: (_c, _i, node) => ({ signals: node.config.fire ? ['fire'] : [] })
  },
  {
    type: 'job',
    title: 'job',
    inputs: [
      { name: 'in', type: 'Text' },
      { name: 'when', type: 'Signal' }
    ],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'ran' } })
  },
  {
    type: 'sink',
    title: 'sink',
    inputs: [{ name: 'in', type: 'Text' }],
    outputs: [],
    isMainOutputCapable: true,
    run: () => ({})
  }
]
const reg = createRegistry(impls)

const graph = (fire: boolean): WorkflowDoc =>
  doc(
    [
      { id: 's', type: 'src' },
      { id: 'g', type: 'gate', config: { fire } },
      { id: 'j', type: 'job' },
      { id: 'k', type: 'sink', isMainOutput: true }
    ],
    [
      { from: { node: 's', port: 'out' }, to: { node: 'j', port: 'in' } },
      { from: { node: 'g', port: 'fire' }, to: { node: 'j', port: 'when' } },
      { from: { node: 's', port: 'out' }, to: { node: 'k', port: 'in' } }
    ]
  )

describe('runWorkflow — Signal gating (spec §5)', () => {
  it('skips a node whose when-Signal did not fire, even with a live data edge', async () => {
    const res = await runWorkflow(graph(false), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('skipped')
  })

  it('runs the node when the gating Signal fired', async () => {
    const res = await runWorkflow(graph(true), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('ran')
    expect(res.outputs.get('j')).toEqual({ out: 'ran' })
  })
})

describe('llm.sample gating port', () => {
  it('declares an optional when: Signal input (unwired in the default graph)', () => {
    expect(llmSample.inputs).toContainEqual({ name: 'when', type: 'Signal' })
  })
})
```

- [x] **Step 2: Run — expect FAIL** (first test: `j` runs today because its data edge is live;
  llm.sample lacks the port).

- [x] **Step 3: Implement.** `workflowEngine.ts`, replace the branch-prune `if` in runNodes with:

```ts
    // Branch-prune: signal firing is only known after a node runs, so which edges are dead
    // can't be computed upfront — pruning is interleaved with execution in this single forward
    // topo pass, unlike graph.ts's prunedNodes(), which takes a static inactive-edge set.
    // Two prune rules (spec §5): every incoming edge dead (nothing can feed the node), OR the
    // node is signal-GATED — it has incoming Signal-typed edges and none of them fired.
    const allDead = ins.length > 0 && ins.every((e) => state.deadEdge.has(edgeKey(e)))
    const signalIns = ins.filter((e) => {
      const src = nodeById.get(e.from.node)
      const srcImpl = src && registry.get(src.type)
      return srcImpl?.outputs.find((p) => p.name === e.from.port)?.type === 'Signal'
    })
    const gatedOff =
      signalIns.length > 0 && signalIns.every((e) => state.deadEdge.has(edgeKey(e)))
    if (allDead || gatedOff) {
      for (const out of outs) state.deadEdge.add(edgeKey(out))
      state.traces.push({ nodeId: id, status: 'skipped', phase })
      continue
    }
```

In `generationNodes.ts` add to `llmSample.inputs` (after `params`):

```ts
    { name: 'when', type: 'Signal' }
```

(with a doc-comment line noting it's the spec §11 gating port, unwired in the default graph).

- [x] **Step 4: Run tests — PASS**, full gate (parity suites must stay green).
- [x] **Step 5: Commit** — `feat(workflow): signal-gated prune + llm.sample when-port`

---

### Task 3: nodeStateService (node_state table) + turnContext wiring

**Files:**
- Modify: `src/main/services/db.ts` (SCHEMA)
- Create: `src/main/services/nodeStateService.ts`
- Modify: `src/main/services/nodes/turnContext.ts`
- Test: `test/nodeStateService.test.ts` (new), modify `test/workflow/turnContext.test.ts`

**Interfaces:**
- Produces: `getNodeState(chatId, nodeId): unknown`, `setNodeState(chatId, nodeId, value): void`,
  pure `encodeNodeState`/`decodeNodeState`. `RunContext.getNodeState/setNodeState` become real
  (keyed by the turn's chatId) — `control.when` (Task 4) relies on this.

- [x] **Step 1: Failing tests.** `test/nodeStateService.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  encodeNodeState,
  decodeNodeState
} from '../src/main/services/nodeStateService'

// The DB layer is a no-op stub under Node (test/mocks/better-sqlite3.ts), so we test the pure
// JSON codec — the SQL wrappers are exercised at runtime (same pattern as memoryStore).
describe('node-state codec', () => {
  it('round-trips objects, arrays, and primitives', () => {
    for (const v of [{ last: '3月' }, [1, 2], 'x', 42, true, null]) {
      expect(decodeNodeState(encodeNodeState(v))).toEqual(v)
    }
  })

  it('undefined encodes to null (row cleared) and decodes back to undefined', () => {
    expect(encodeNodeState(undefined)).toBeNull()
    expect(decodeNodeState(null)).toBeUndefined()
    expect(decodeNodeState(undefined)).toBeUndefined()
  })

  it('corrupt stored JSON decodes to undefined instead of throwing', () => {
    expect(decodeNodeState('{oops')).toBeUndefined()
  })
})
```

Replace the third test in `test/workflow/turnContext.test.ts` (deliberate pinned-behavior update —
the stubs become real delegations) with:

```ts
import { getNodeState, setNodeState } from '../../src/main/services/nodeStateService'

vi.mock('../../src/main/services/nodeStateService', () => ({
  getNodeState: vi.fn(() => ({ last: 'x' })),
  setNodeState: vi.fn()
}))

  it('wires getNodeState/setNodeState to nodeStateService keyed by this chat', () => {
    const ctx = buildTurnContext({
      profileId: 'p1',
      chatId: 'c1',
      userAction: 'hello',
      signal: new AbortController().signal,
      onDelta: () => {}
    })
    expect(ctx.getNodeState('n9')).toEqual({ last: 'x' })
    expect(getNodeState).toHaveBeenCalledWith('c1', 'n9')
    ctx.setNodeState('n9', { last: 'y' })
    expect(setNodeState).toHaveBeenCalledWith('c1', 'n9', { last: 'y' })
    expect(() => ctx.emitPanel('n', 'x')).not.toThrow()
  })
```

- [x] **Step 2: Run — FAIL** (module doesn't exist).

- [x] **Step 3: Implement.** `db.ts` SCHEMA, after the `memory_entries` index:

```sql
-- Durable per-node scratchpad for workflow nodes, keyed by (chat_id, node_id) — what makes
-- "changed since last fire" (control.when) expressible. See the node-workflow spec §11.
CREATE TABLE IF NOT EXISTS node_state (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  data TEXT,
  updated_at TEXT,
  PRIMARY KEY (chat_id, node_id)
);
```

`src/main/services/nodeStateService.ts`:

```ts
import { getDb } from './db'

/** JSON-encode a node-state value for the data column. undefined → null (cleared). */
export const encodeNodeState = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

/** Decode a stored data column; null/corrupt rows read as undefined (state never throws). */
export const decodeNodeState = (data: string | null | undefined): unknown => {
  if (data == null) return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/** Read a node's durable per-chat state (workflow spec §11). */
export const getNodeState = (chatId: string, nodeId: string): unknown => {
  const row = getDb()
    .prepare('SELECT data FROM node_state WHERE chat_id = ? AND node_id = ?')
    .get(chatId, nodeId) as { data: string | null } | undefined
  return decodeNodeState(row?.data)
}

/** Write (or clear, with undefined) a node's durable per-chat state. */
export const setNodeState = (chatId: string, nodeId: string, value: unknown): void => {
  if (value === undefined) {
    getDb().prepare('DELETE FROM node_state WHERE chat_id = ? AND node_id = ?').run(chatId, nodeId)
    return
  }
  getDb()
    .prepare(
      `INSERT INTO node_state (chat_id, node_id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, node_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
    .run(chatId, nodeId, encodeNodeState(value), new Date().toISOString())
}
```

`turnContext.ts`: import the service, replace the two stubs:

```ts
import { getNodeState, setNodeState } from '../nodeStateService'
    getNodeState: (nodeId) => getNodeState(args.chatId, nodeId),
    setNodeState: (nodeId, value) => setNodeState(args.chatId, nodeId, value)
```

(and update the file doc-comment: node-state persistence is now real; panel emission remains the stub.)

- [x] **Step 4: Run tests — PASS**, full gate.
- [x] **Step 5: Commit** — `feat(workflow): durable node_state store wired into the turn context`

---

### Task 4: Control nodes — control.if / control.switch / control.when

**Files:**
- Create: `src/main/services/nodes/builtin/controlNodes.ts`
- Modify: `src/main/services/nodes/builtin/index.ts` (register)
- Test: `test/workflow/controlNodes.test.ts` (new)

**Interfaces:**
- Consumes: `NodeMeta` (Task 1), gating semantics (Task 2), `ctx.getNodeState/setNodeState` (Task 3),
  `getPath` from `src/shared/objectPath` (bracket-aware dialect — MVU stat_data paths).
- Produces: `evalPredicate(subject, op, value)`, `PREDICATE_OPS`; node types `control.if`
  (`then`/`else` Signals), `control.switch` (`case1`–`case4`/`default` Signals), `control.when`
  (`fire` Signal, ops + `changed`).

- [x] **Step 1: Failing tests** (`test/workflow/controlNodes.test.ts`): predicate table (eq/neq deep
  JSON equality, gt/lt numeric coercion, truthy/falsy, contains on string + array), `control.if`
  fires exactly one of then/else, `control.switch` fires the first matching case else default,
  `control.when` predicate ops, and the `changed` op: first sight fires + stores, same value doesn't
  fire + doesn't overwrite state, changed value fires again (ctx stubs backed by a Map).
- [x] **Step 2: Run — FAIL.**
- [x] **Step 3: Implement** `controlNodes.ts` (evalPredicate + three NodeImpls with zod config
  schemas; every node has inputs `value: Any` + `when: Signal`), register all three in
  `builtin/index.ts`.
- [x] **Step 4: Run — PASS**, full gate.
- [x] **Step 5: Commit** — `feat(nodes): control.if / control.switch / control.when`

---

### Task 5: text.template + the shared interpolate helper

**Files:**
- Create: `src/main/services/nodes/builtin/messageNodes.ts` (interpolate + textTemplate; Task 6 adds
  the two Messages nodes to the same file)
- Modify: `src/main/services/nodes/builtin/index.ts` (register)
- Test: `test/workflow/messageNodes.test.ts` (new; `vi.mock` templateService — evalTemplate needs the
  QuickJS engine at runtime)

**Interfaces:**
- Consumes: `expandMacros` (shared/macros), `evalTemplate`/`buildTemplateContext` (templateService),
  `GenContext` (generation/types).
- Produces: `interpolate(text, slots, gen?)` (macros+EJS first when gen present, `{{in1}}`–`{{in4}}`
  slots last); node `text.template` (config `{ template }`, inputs `gen`/`in1`–`in4`/`when`,
  output `text: Text`).

- [x] **Step 1: Failing tests:** slot substitution (string / object→JSON / missing→''), slots
  substituted AFTER macros+EJS (a slot value containing `{{user}}` stays literal), macros expand from
  gen (user/char/vars/globals), EJS runs only when gen wired (mock evalTemplate to a marker), no gen →
  slots only.
- [x] **Step 2: Run — FAIL.**
- [x] **Step 3: Implement** interpolate + textTemplate; register.
- [x] **Step 4: Run — PASS**, full gate.
- [x] **Step 5: Commit** — `feat(nodes): text.template + template interpolation helper`

---

### Task 6: prompt.messages + merge.messages + providerShape

**Files:**
- Create: `src/main/services/generation/providerShape.ts`
- Modify: `src/main/services/nodes/builtin/messageNodes.ts` (add both nodes)
- Modify: `src/main/services/nodes/builtin/index.ts` (register)
- Test: `test/generation/providerShape.test.ts` (new; real promptBuilder/apiService fns — both
  import fine under vitest, see test/apiService.test.ts), extend `test/workflow/messageNodes.test.ts`

**Interfaces:**
- Consumes: `systemToUser`/`mergeConsecutiveRoles` (promptBuilder), `orderForProvider`/
  `isOpenAiCompatibleProvider` (apiService), `interpolate` (Task 5).
- Produces: `providerShape(settings, messages): ChatMessage[]`; node `prompt.messages` (config
  `{ messages: [{ role, content }] }`, output `messages: Messages`, rows interpolated, shaped when
  gen wired); node `merge.messages` (inputs `a`–`d: Messages` + `gen` + `when`, concat in port order
  skipping unwired, shaped when gen wired).

- [x] **Step 1: Failing tests:** providerShape applies system→user only when
  `system_as_user && isOpenAiCompatibleProvider`, merges consecutive roles unless disabled, always
  orders for provider (trailing assistant prefill kept last — pin with an anthropic + an
  openai-compatible settings fixture); prompt.messages builds role rows + interpolates + shapes;
  merge.messages concatenates a→d skipping gaps.
- [x] **Step 2: Run — FAIL.**
- [x] **Step 3: Implement**; register both nodes.
- [x] **Step 4: Run — PASS**, full gate (parity untouched — assemble not modified).
- [x] **Step 5: Commit** — `feat(nodes): prompt.messages + merge.messages (provider-shaped)`

---

### Task 7: mvu.set + varsWrite extraction

**Files:**
- Create: `src/main/services/generation/varsWrite.ts` (move verbatim from generationService.ts:
  `writeLoopGuard`, `LOOP_MAX`, `resetWriteLoopGuard`, `registerWriteSignature`, `applyVariableOps`)
- Modify: `src/main/services/generationService.ts` (delete moved block; import + re-export from
  `./generation/varsWrite` so every existing consumer/test keeps resolving)
- Create: `src/main/services/nodes/builtin/mvuNodes.ts`
- Modify: `src/main/services/nodes/builtin/index.ts` (register)
- Test: `test/workflow/mvuNodes.test.ts` (new)

**Interfaces:**
- Consumes: `applyVariableOps(profileId, chatId, floor, ops)` (moved), `getAllFloors` (floorService),
  `toParts` (shared/objectPath), `ctx.profileId/chatId`.
- Produces: `toPointer(dotPath): string` (RFC-6901, `~`/`/` escaped); node `mvu.set` (config
  `{ path, value? }`, inputs `value: Any` — wired value wins — + `when: Signal`, writes
  `{ op: 'replace' }` to the LATEST floor via applyVariableOps).

**Import-cycle rationale:** `generationService` imports `nodes/builtin` (registry); a node importing
`generationService` back would create a cycle `check:deps`/ESM would trip on. Moving the write-back
bridge to a leaf module (established 2b-1a pattern) breaks it.

- [x] **Step 1: Failing tests:** toPointer conversions (`a.b` → `/a/b`, `a[0].b` → `/a/0/b`,
  `k~x/y` escaping); mvu.set run calls applyVariableOps with (profileId, chatId, lastFloor.floor,
  `[{ op: 'replace', path, value }]`) — vi.mock varsWrite + floorService; wired input overrides
  config value; no floors → no write.
- [x] **Step 2: Run — FAIL.**
- [x] **Step 3: Implement** (move + re-export first, typecheck, then the node); register.
- [x] **Step 4: Run — PASS**, full gate (generationService tests + parity green via re-exports).
- [x] **Step 5: Commit** — `feat(nodes): mvu.set via the varsWrite write-back bridge`

---

### Task 8: Final verification + docs

- [x] **Step 1:** Full gate: `npm run typecheck && npm run check:deps && npm run test` — all green.
- [x] **Step 2:** Re-read this plan's decisions vs. the code; fix drift. Update
  `docs/superpowers/plans/2026-07-01-node-workflow-phase2b-plan.md` 2b-2 outline status line.
- [x] **Step 3:** Commit — `docs(workflow): mark phase 2b-2 agentic nodes complete`

## Self-review notes

- Spec coverage: §5 signal prune (T2), §8 message composition + provider shaping (T5/T6), §11
  control.when + mvu.set + node_state (T3/T4/T7), §12/§14 config schemas (T1). Persistence (§12
  workflows table), D10 retry/fallback, and memory decomposition are explicitly out (decision 9).
- Type consistency: `NodeMeta` produced in T1 is what T4–T7 nodes consume; `providerShape` name is
  uniform across T6; `toPointer` only in T7.
