# Node Workflow Engine — Phase 4: React Flow Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A polished, token-themed React Flow canvas editor (spec §13) for authoring workflow
docs: drag-wire nodes from a palette, edit node config in an auto-rendered side panel, live
validation, save/clone-to-edit/import/export — making the agentic node set authorable without
hand-editing `.rptflow` JSON.

**Architecture:** The canvas is `@xyflow/react` (MIT — spec §19, owner-approved) used ONLY for
rendering/interaction; all graph semantics stay ours. A pure, React-free `editorModel` module maps
`WorkflowDoc` ↔ editor nodes/edges (with deterministic auto-layout for docs without positions) and
gates connections (`portCompatible` + fan-in + self-edge rules) — fully unit-tested. A Zustand
`workflowEditorStore` owns the draft doc, dirty state, and live validation (the pure shared
`validateWorkflow` run client-side against a node-type catalog served over IPC — descriptors + zod
config schemas serialized via `z.toJSONSchema`, so the config panel auto-renders from the same
single source of truth the engine validates with, spec §14). The view composes top bar + palette +
canvas + config panel; React Flow is fully re-skinned to `--rpt-*` tokens.

**Tech Stack:** `@xyflow/react` ^12 (NEW dependency — the only one), React 19, Zustand, zod v4
(`z.toJSONSchema`, verified available in 4.4.3), Vitest for the pure model/store/schema-form logic.

## Global Constraints

- **Branch base:** stack on `claude/workflow-phase3-persistence` (PR #27) — the editor consumes
  Phase 3's workflowService IPC surface. Branch: `claude/workflow-phase4-editor`.
- **Module boundaries** (`npm run check:deps`): renderer talks ONLY through preload IPC;
  `shared/workflow` stays pure (nothing new goes there this phase — `editorModel` lives renderer-side
  but must import NOTHING from React/`@xyflow/react`, only `src/shared/workflow/*`, so it stays
  vitest-testable).
- **Verification gate per task:** `npm run typecheck && npm run check:deps && npm run test`.
- **Prettier:** no semicolons, single quotes, 2-space indent, no trailing commas.
- **i18n:** every user-facing string via `t('workflowEditor.*')`, keys added to BOTH
  `src/renderer/src/i18n/locales/en.ts` and `zh.ts` (工作流编辑器 terminology).
- **Theming (owner hard requirement):** NO default React-Flow chrome; node cards, edges, handles,
  selection/running states styled exclusively with the existing tokens
  (`--rpt-bg-primary/-secondary/-tertiary/-elevated`, `--rpt-text-primary/-secondary/-tertiary`,
  `--rpt-accent`, `--rpt-on-accent`, `--rpt-border`, `--rpt-danger`, `--rpt-success`,
  `--rpt-warning`) so all three themes (dark/carbon/light) inherit WCAG-AA contrast from the token
  system. No hardcoded colors anywhere in the new CSS/TSX (the ONLY exception: the port-type color
  map may derive hues from tokens via `color-mix()` with token bases).
- **The built-in workflow is never mutated:** opening it in the editor is read-only; the only write
  path out is Clone-to-edit (spec §12).
- **Save keeps the main-side validation gate:** the editor's live validation is advisory; `saveWorkflow`
  IPC remains the enforcement point.

## Settled decisions (grounded 2026-07-01)

1. **Node-type catalog over IPC** (`list-node-types`): main walks `builtinRegistry.descriptors()`
   and pairs each with `z.toJSONSchema(impl.configSchema)` when present. Renderer renders config
   forms from the JSON Schema — no schema duplication, no drift (single source = the registry).
2. **Pure editor model, plain types:** `editorModel.ts` defines `EditorNode`/`EditorEdge` WITHOUT
   importing React Flow; `FlowCanvas` maps them to RF `Node`/`Edge` trivially. This keeps all graph
   logic vitest-testable (established pattern: `test/regexApply.test.ts` / `test/assetStoreNav.test.ts`
   already import renderer modules).
3. **Auto-layout** for docs lacking `position`: longest-path layering (column = max depth from
   roots along edges), row = index within column; spacing 260×120, origin 40,40. Deterministic
   (stable node order), pure, tested. Docs WITH positions keep them untouched.
4. **Connection gating** at drag time: target port must exist and be type-compatible
   (`portCompatible` from shared), input ports accept AT MOST one edge (the FANIN rule), no
   self-edges. Rejected connections show the reason as a transient status line (v1; inline canvas
   hints are a polish follow-up).
5. **Explicit Save with dirty indicator, autosave DEFERRED** — deliberate deviation from spec §13's
   "debounced autosave": the save gate rejects invalid docs, and autosaving a mid-edit (invalid)
   graph would fail constantly without a draft-persistence layer. Explicit Save + an "unsaved
   changes" chip is v1; autosave revisits with the run/trace phase. Flagged for owner review.
6. **Also deferred (stated up front):** run/trace panel and per-node chat output panels (runtime
   observability — needs an engine trace IPC that doesn't exist yet), the bespoke `prompt.messages`
   role-message editor from spec §8 (the generic array-of-object rows editor covers v1), palette
   search, undo/redo, minimap.
7. **`isMainOutput`** is a config-panel checkbox shown only for `isMainOutputCapable` node types;
   checking it clears the flag on every other node (exactly-one is enforced by validation, the
   store keeps it consistent proactively).
8. **Config values are edited structurally** per JSON Schema: `string`→textarea, `number`→number
   input, `boolean`→checkbox, `enum`→select, `array` of objects→row editor (add/remove/move rows,
   fields per the item schema), anything unrepresentable→raw JSON textarea (parse-on-blur, inline
   error). Covers every current builtin config (`control.*`, `text.template`, `prompt.messages`,
   `mvu.set`).

---

## File map

| File | Change |
|---|---|
| `src/main/ipc/workflowIpc.ts` | +`list-node-types` handler |
| `src/main/services/nodes/catalog.ts` | NEW — registry → serializable catalog (descriptors + JSON-schemas) |
| `src/preload/index.ts` + `index.d.ts` | +`listNodeTypes` |
| `src/renderer/src/components/workflow/editorModel.ts` | NEW — pure doc↔editor mapping, layout, canConnect |
| `src/renderer/src/stores/workflowEditorStore.ts` | NEW — Zustand draft-doc store + live validation |
| `src/renderer/src/components/workflow/FlowCanvas.tsx` | NEW — RF wrapper + custom RptNode |
| `src/renderer/src/components/workflow/workflowEditor.css` | NEW — RF re-skin, tokens only |
| `src/renderer/src/components/workflow/NodeConfigPanel.tsx` | NEW — JSON-schema form |
| `src/renderer/src/components/workflow/schemaForm.ts` | NEW — pure JSON-schema → field-spec walker |
| `src/renderer/src/components/workflow/WorkflowEditorView.tsx` | NEW — composition (top bar/palette/canvas/panel) |
| `src/renderer/src/components/workspace/viewRegistry.tsx` | register `workflow-editor` |
| `src/renderer/src/components/workspace/Panel.tsx` | `VIEW_LABEL_KEY['workflow-editor']` |
| `src/renderer/src/i18n/locales/{en,zh}.ts` | `workflowEditor.*` keys |
| `package.json` | +`@xyflow/react` ^12 |
| Tests | `test/nodeCatalog.test.ts`, `test/workflow/editorModel.test.ts`, `test/workflowEditorStore.test.ts`, `test/workflow/schemaForm.test.ts` |

---

### Task 1: Node-type catalog — `catalog.ts` + `list-node-types` IPC

**Files:**
- Create: `src/main/services/nodes/catalog.ts`
- Modify: `src/main/ipc/workflowIpc.ts` (one handler), `src/preload/index.ts`, `src/preload/index.d.ts`
- Test: `test/nodeCatalog.test.ts` (new)

**Interfaces:**
- Consumes: `builtinRegistry` (`src/main/services/nodes/builtin`) — `NodeImpl` extends
  `NodeDescriptor { type, title, inputs: PortSpec[], outputs: PortSpec[], isMainOutputCapable? }`
  plus optional `configSchema?: ZodType`. `z.toJSONSchema` from zod 4.4.3 (verified).
- Produces (Tasks 2/3/5 rely on these exact names):

```ts
export interface NodeTypeInfo {
  type: string
  title: string
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
  isMainOutputCapable?: boolean
  /** JSON Schema (draft 2020-12) for NodeInstance.config; absent when the node has no configSchema. */
  configSchema?: Record<string, unknown>
}
export const listNodeTypes: () => NodeTypeInfo[]
```

- [x] **Step 1: Write the failing test** (`test/nodeCatalog.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { listNodeTypes } from '../src/main/services/nodes/catalog'

describe('listNodeTypes', () => {
  const catalog = listNodeTypes()
  const byType = new Map(catalog.map((n) => [n.type, n]))

  it('covers every builtin node type exactly once', () => {
    const types = catalog.map((n) => n.type)
    expect(new Set(types).size).toBe(types.length)
    for (const t of [
      'input.context',
      'memory.recall',
      'prompt.assemble',
      'llm.sample',
      'parse.response',
      'apply.state',
      'output.writeFloor',
      'memory.compact',
      'control.if',
      'control.switch',
      'control.when',
      'text.template',
      'prompt.messages',
      'merge.messages',
      'mvu.set'
    ]) {
      expect(byType.has(t)).toBe(true)
    }
  })

  it('carries ports and the main-output capability flag', () => {
    const write = byType.get('output.writeFloor')!
    expect(write.isMainOutputCapable).toBe(true)
    expect(write.inputs).toContainEqual({ name: 'variables', type: 'Vars' })
    const llm = byType.get('llm.sample')!
    expect(llm.inputs).toContainEqual({ name: 'when', type: 'Signal' })
  })

  it('serializes configSchema to JSON Schema for configured nodes, omits it otherwise', () => {
    const tpl = byType.get('text.template')!
    expect(tpl.configSchema).toBeDefined()
    const props = (tpl.configSchema as any).properties
    expect(props.template).toEqual({ type: 'string' })
    expect(byType.get('input.context')!.configSchema).toBeUndefined()
  })

  it('returns plain JSON-serializable data (survives a structured-clone round trip)', () => {
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
  })
})
```

- [x] **Step 2: Run — expect FAIL** (`npx vitest run test/nodeCatalog.test.ts`) — module not found.

- [x] **Step 3: Implement** `src/main/services/nodes/catalog.ts`:

```ts
import { z } from 'zod'
import { builtinRegistry } from './builtin'

/** Serializable node-type catalog for the editor (spec §13/§14): the registry's pure
 *  descriptors, with each node's zod configSchema converted to JSON Schema so the renderer's
 *  config panel auto-renders from the SAME source the engine validates with. */
export interface NodeTypeInfo {
  type: string
  title: string
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
  isMainOutputCapable?: boolean
  configSchema?: Record<string, unknown>
}

export const listNodeTypes = (): NodeTypeInfo[] => {
  const out: NodeTypeInfo[] = []
  for (const [type, desc] of builtinRegistry.descriptors()) {
    const impl = builtinRegistry.get(type)!
    out.push({
      type,
      title: desc.title,
      inputs: desc.inputs.map((p) => ({ name: p.name, type: p.type })),
      outputs: desc.outputs.map((p) => ({ name: p.name, type: p.type })),
      ...(desc.isMainOutputCapable ? { isMainOutputCapable: true } : {}),
      ...(impl.configSchema
        ? { configSchema: z.toJSONSchema(impl.configSchema) as Record<string, unknown> }
        : {})
    })
  }
  return out
}
```

(If `z.toJSONSchema` rejects a schema — e.g. `z.unknown()` fields — check its options; zod 4
supports `z.toJSONSchema(schema, { unrepresentable: 'any' })` to map unrepresentable types to `{}`.
Use that option if the default throws for `control.*`'s `z.unknown()` config values, and note it in
your report.)

IPC (`workflowIpc.ts`): `ipcMain.handle('list-node-types', () => listNodeTypes())` (+ import).
Preload: `listNodeTypes: () => ipcRenderer.invoke('list-node-types')`; d.ts entry
`listNodeTypes(): Promise<Array<{ type: string; title: string; inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[]; isMainOutputCapable?: boolean; configSchema?: Record<string, unknown> }>>`
(match the file's existing inline style).

- [x] **Step 4: Run — PASS**, then the full gate.
- [x] **Step 5: Commit** — `feat(workflow): serializable node-type catalog over IPC`

---

### Task 2: Pure editor model — `editorModel.ts`

**Files:**
- Create: `src/renderer/src/components/workflow/editorModel.ts` (NO React/RF imports — only
  `src/shared/workflow/*` + the `NodeTypeInfo` shape)
- Test: `test/workflow/editorModel.test.ts` (new)

**Interfaces:**
- Consumes: `WorkflowDoc`, `NodeInstance`, `Edge`, `PortType`, `portCompatible` from
  `src/shared/workflow/types`; `NodeTypeInfo` (structurally — define a local
  `EditorNodeType` alias with the same shape rather than importing from `src/main`; the renderer
  gets the real data over IPC).
- Produces (Tasks 3/4 rely on these exact names):

```ts
export interface EditorNode {
  id: string
  type: string            // registry node type
  position: { x: number; y: number }
  config?: Record<string, unknown>
  isMainOutput?: boolean
}
export interface EditorEdge {
  id: string               // edgeId(edge)
  source: string; sourcePort: string
  target: string; targetPort: string
}
export const edgeId: (e: { from: { node: string; port: string }; to: { node: string; port: string } }) => string
export const docToEditor: (doc: WorkflowDoc) => { nodes: EditorNode[]; edges: EditorEdge[] }
export const editorToDoc: (base: WorkflowDoc, nodes: EditorNode[], edges: EditorEdge[]) => WorkflowDoc
export const autoLayout: (doc: WorkflowDoc) => Map<string, { x: number; y: number }>
export type ConnectVerdict = { ok: true } | { ok: false; reason: 'incompatible' | 'occupied' | 'self' | 'missing-port' }
export const canConnect: (
  types: Map<string, EditorNodeType>,
  nodes: EditorNode[],
  edges: EditorEdge[],
  from: { node: string; port: string },
  to: { node: string; port: string }
) => ConnectVerdict
```

Key behaviors (each pinned by a test):
- `edgeId` = `` `${from.node}:${from.port}->${to.node}:${to.port}` `` (matches the engine's edgeKey
  format for trace-panel reuse later).
- `docToEditor`: nodes keep existing `position`; nodes WITHOUT one get `autoLayout` coordinates.
  `config`/`isMainOutput` pass through.
- `autoLayout`: column = longest path from any root along edges (roots = column 0), spacing
  `x = 40 + col * 260`, `y = 40 + rowWithinColumn * 120`, rows in doc order. Deterministic; a doc
  with a cycle must not hang (bound iterations by node count) — return doc-order columns as the
  fallback.
- `editorToDoc`: rebuilds `nodes`/`edges` arrays from editor state onto `base` (preserving
  `id/name/version/schemaVersion/description/meta`), writing `position` on every node, dropping
  `config` when it is `undefined` or `{}`.
- `canConnect`: `missing-port` when either end's node type or port name is unknown; `self` when
  source node === target node; `occupied` when the target input port already has an edge (FANIN);
  `incompatible` when `!portCompatible(fromType, toType)`. Checks run in that order.

- [x] **Step 1: Failing tests** — round-trip: `docToEditor(DEFAULT_GRAPH-shaped doc)` →
  `editorToDoc` reproduces the original nodes/edges (positions added); positions preserved when
  present; autoLayout columns (ctx=0, recall/assemble chain deepens, write deepest pre-node) +
  cycle fallback termination; edgeId format; canConnect verdicts — one test per reason plus an
  ok case (build a tiny two-node-type map inline).
- [x] **Step 2: Run — FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Run — PASS**, full gate.
- [x] **Step 5: Commit** — `feat(workflow-editor): pure doc<->canvas model with layout + connection gating`

---

### Task 3: `workflowEditorStore` (Zustand)

**Files:**
- Create: `src/renderer/src/stores/workflowEditorStore.ts`
- Test: `test/workflowEditorStore.test.ts` (new — mirror the window/api stubbing style of
  `test/assetStoreNav.test.ts`; read it first)

**Interfaces:**
- Consumes: `editorModel` (Task 2), `validateWorkflow` + `NodeDescriptor` from
  `src/shared/workflow/validate`/`types`, preload `api` (`listWorkflows`, `getWorkflow`,
  `saveWorkflow`, `cloneWorkflow`, `listNodeTypes`) via `window.api`.
- Produces (Tasks 4/5/6 rely on):

```ts
interface WorkflowEditorState {
  nodeTypes: NodeTypeInfo[]           // loaded once
  workflows: { id: string; name: string; builtin?: boolean }[]
  currentId: string | null
  doc: WorkflowDoc | null             // the DRAFT
  nodes: EditorNode[]
  edges: EditorEdge[]
  dirty: boolean
  readOnly: boolean                   // true when currentId === 'default'
  errors: { code: string; message: string; nodeId?: string }[]  // live validation
  selectedNodeId: string | null
  status: string | null               // transient status line (connect rejects, save results)
  init(profileId: string): Promise<void>          // loads nodeTypes + workflow list
  open(profileId: string, id: string): Promise<void>
  addNode(type: string, position: { x: number; y: number }): void
  moveNode(id: string, position: { x: number; y: number }): void
  connect(from: { node: string; port: string }, to: { node: string; port: string }): void
  removeEdge(edgeId: string): void
  removeNode(id: string): void
  setNodeConfig(id: string, config: Record<string, unknown>): void
  setMainOutput(id: string): void      // sets on id, clears on all others
  select(id: string | null): void
  save(profileId: string): Promise<void>          // no-op when readOnly; toast/status on reject
  cloneAndEdit(profileId: string): Promise<void>  // clone currentId, open the clone
}
```

Key behaviors (pinned by tests, driving the store directly with a stubbed `window.api`):
- `open` maps the doc through `docToEditor`, computes `readOnly`, runs validation, clears dirty.
- Every mutation re-runs `validateWorkflow(editorToDoc(...), descriptorMap)` and sets
  `errors`/`dirty`; mutations are IGNORED when `readOnly` (state unchanged).
- `addNode` ids: `` `${type.split('.').pop()}-${n}` `` with `n` the first integer making it unique.
- `connect` consults `canConnect`; a rejection sets `status` (reason key) and adds nothing.
- `removeNode` also drops its edges. `setMainOutput` clears the flag elsewhere.
- `save` calls `saveWorkflow(profileId, currentId, editorToDoc(...))`; `{ok:false}` sets `status`
  to the error, keeps dirty; `{ok:true}` clears dirty. `readOnly` → immediate return.
- `cloneAndEdit` → `cloneWorkflow`, reloads the workflow list, `open`s the new id.

- [x] **Step 1: Failing tests** — open builtin → readOnly, mutations ignored; open custom → addNode
  unique ids; connect ok/reject paths (status set, edge count unchanged); removeNode cascades
  edges; setMainOutput exclusivity; validation errors live-update (delete the main-output node →
  MAIN_OUTPUT error appears); save happy/reject/readOnly; cloneAndEdit opens the clone id.
- [x] **Step 2: Run — FAIL.** → **Step 3: Implement.** → **Step 4: PASS + full gate.**
- [x] **Step 5: Commit** — `feat(workflow-editor): draft-doc store with live validation`

---

### Task 4: Canvas — `@xyflow/react` + `FlowCanvas` + token re-skin

**Files:**
- Modify: `package.json` (add `"@xyflow/react": "^12"` to dependencies; run `npm install`)
- Create: `src/renderer/src/components/workflow/FlowCanvas.tsx`,
  `src/renderer/src/components/workflow/workflowEditor.css`
- Test: none (visual; gate = typecheck/check:deps/full suite + the store/model tests already pin
  the logic the canvas delegates to)

**FlowCanvas contract:** props `{ profileId: string }`; reads everything else from
`useWorkflowEditorStore`. Maps `EditorNode[]`/`EditorEdge[]` to RF `Node[]`/`Edge[]`
(`node.data = { editorNode, typeInfo }`; RF node `type: 'rpt'`). One custom node component
`RptNode`: a token-styled card — title row (node title + type id small), left column of input
handles, right column of output handles; each `<Handle id={portName}>` labeled with the port name;
handle color by port-type class; `isMainOutput` badge (★ + `--rpt-accent` border). Events wire to
store actions: `onNodesChange` (position → `moveNode`, remove → `removeNode`), `onEdgesChange`
(remove → `removeEdge`), `onConnect` → `connect`, `onNodeClick` → `select`, pane click →
`select(null)`, drop from palette (HTML5 DnD, `application/rpt-node-type` mime) → `addNode` at
`screenToFlowPosition`. `readOnly` sets RF `nodesDraggable={false} nodesConnectable={false}
elementsSelectable={true}` and suppresses delete handlers. Import RF's base css
(`@xyflow/react/dist/style.css`) ONCE here, then `workflowEditor.css` overrides.

**workflowEditor.css:** scope everything under `.rpt-workflow-editor`. Restyle: `.react-flow__node`
(background `var(--rpt-bg-elevated)`, border `var(--rpt-border)`, selected → `var(--rpt-accent)`),
edges (`.react-flow__edge-path { stroke: var(--rpt-text-tertiary) }`, selected → accent), handles
(10px, border `--rpt-bg-primary`, port-type classes: `Messages`→`--rpt-accent`,
`Text`→`--rpt-success`, `Vars`→`--rpt-warning`, `Context`→`--rpt-text-secondary`,
`Signal`→`--rpt-danger`, `Error`→`color-mix(in srgb, var(--rpt-danger) 60%, var(--rpt-bg-primary))`,
`Any`/`Floors`→`--rpt-text-tertiary`), `.react-flow__background` dots `--rpt-border`, controls
buttons (`--rpt-bg-secondary` bg, `--rpt-text-primary` fill, `--rpt-border`), attribution left
visible (MIT requires nothing, RF's attribution is removable only with a pro plan — keep it,
restyled to `--rpt-text-tertiary` on transparent). NO hardcoded colors.

- [x] **Step 1:** `npm install @xyflow/react` (pin `^12`), commit `package.json` + lockfile
  separately IF the install churns the lockfile heavily: `chore(deps): add @xyflow/react (MIT) for the workflow editor`.
- [x] **Step 2:** Implement FlowCanvas + RptNode + css per the contract above.
- [x] **Step 3:** Full gate (typecheck catches store/model contract drift).
- [x] **Step 4:** Commit — `feat(workflow-editor): token-themed React Flow canvas`

---

### Task 5: Config side panel — `schemaForm.ts` + `NodeConfigPanel.tsx`

**Files:**
- Create: `src/renderer/src/components/workflow/schemaForm.ts` (pure),
  `src/renderer/src/components/workflow/NodeConfigPanel.tsx`
- Test: `test/workflow/schemaForm.test.ts` (new — pure walker only)

**`schemaForm.ts` (pure, no React):**

```ts
export type FieldSpec =
  | { kind: 'string'; key: string; required: boolean }
  | { kind: 'number'; key: string; required: boolean }
  | { kind: 'boolean'; key: string; required: boolean }
  | { kind: 'enum'; key: string; required: boolean; options: string[] }
  | { kind: 'objectArray'; key: string; required: boolean; itemFields: FieldSpec[] }
  | { kind: 'json'; key: string; required: boolean }   // fallback for anything else
export const fieldsFromSchema: (schema: Record<string, unknown> | undefined) => FieldSpec[]
```

Walker rules (pinned by tests against the REAL catalog output — import `listNodeTypes` from
`src/main/services/nodes/catalog` in the test to walk actual schemas): object schema →
one FieldSpec per `properties` entry (required from the `required` array); `{type:'string'}`→string;
`{type:'string', enum:[...]}` (or zod-emitted `enum` shape — inspect real output for `control.if`'s
`op`)→enum; `{type:'number'}`→number; `{type:'boolean'}`→boolean; `{type:'array', items:{type:'object',...}}`
→objectArray with recursed itemFields; anything else (missing type, unions, `{}` from
`z.unknown()`)→json. Non-object top-level or undefined → `[]`.

**NodeConfigPanel:** props `{ profileId: string }`; reads `selectedNodeId`/nodes/nodeTypes/readOnly
from the store. No selection → `t('workflowEditor.noSelection')`. Renders: node title + type,
the `isMainOutput` checkbox when capable (→ `setMainOutput`), then one input per FieldSpec bound to
`node.config[key]` → `setNodeConfig` (string→`<textarea rows={3}>`, number→`<input type=number>`
(empty → key deleted), boolean→checkbox, enum→`<select>` with an empty option when not required,
objectArray→rows with per-item fields + add/remove/↑↓ buttons, json→textarea with `JSON.parse` on
blur and a `--rpt-danger` error line on parse failure, leaving the last valid value). All controls
`disabled={readOnly}`. Port list (inputs/outputs with type names) rendered read-only at the bottom
for reference.

- [x] **Step 1: Failing tests** for `fieldsFromSchema`: real `text.template` → `[{kind:'string',key:'template',required:true}]`;
  real `control.if` → op is enum with the 9 PREDICATE_OPS + value is json + path is optional string;
  real `prompt.messages` → objectArray with role enum + content string itemFields; real `mvu.set` →
  path string required + value json optional; `undefined`/`{}`/array-top-level → `[]`.
- [x] **Step 2: FAIL** → **Step 3: implement walker + panel** → **Step 4: PASS + full gate.**
- [x] **Step 5: Commit** — `feat(workflow-editor): schema-driven node config panel`

---

### Task 6: `WorkflowEditorView` — composition, palette, top bar, registry, i18n

**Files:**
- Create: `src/renderer/src/components/workflow/WorkflowEditorView.tsx`
- Modify: `src/renderer/src/components/workspace/viewRegistry.tsx` (entry `workflow-editor`,
  wrapper like the others), `src/renderer/src/components/workspace/Panel.tsx`
  (`VIEW_LABEL_KEY['workflow-editor'] = 'workflowEditor.viewTitle'`),
  `src/renderer/src/i18n/locales/en.ts` + `zh.ts`
- Test: none (composition; gate + manual script)

**Layout** (flex row, full height, class `rpt-workflow-editor`): left palette (180px, scrollable:
one draggable chip per `nodeTypes` entry — `draggable`, sets `application/rpt-node-type`), center
`FlowCanvas` (flex 1), right `NodeConfigPanel` (280px). Above them the top bar: workflow `<select>`
(from `workflows`, opens via `open`), Save button (disabled when `readOnly || !dirty`; shows
`workflowEditor.unsaved` chip when dirty), Clone-to-edit button (always enabled; primary affordance
when readOnly), Import/Export buttons (reuse `importWorkflowDialog`/`exportWorkflowDialog`, reload
list after import), and the validation status chip: `--rpt-success` `workflowEditor.valid` when no
errors, else `--rpt-danger` `workflowEditor.invalid` with count; clicking it toggles an error list
(message + nodeId, clicking an entry selects that node). A read-only banner
(`workflowEditor.readOnlyBuiltin`) when `readOnly`. `init(profileId)` on mount; a
beforeunload-style guard is NOT needed (panel switching is in-app; dirty chip is the guard — note
this in a comment).

**i18n keys** (both locales; zh values): `workflowEditor.viewTitle` (Workflow Editor / 工作流编辑器),
`.palette` (Nodes / 节点), `.save` (Save / 保存), `.unsaved` (Unsaved changes / 未保存更改),
`.cloneToEdit` (Clone to edit / 克隆以编辑), `.import` (Import / 导入), `.export` (Export / 导出),
`.valid` (Valid / 有效), `.invalid` (Invalid / 无效), `.errors` (Validation errors / 校验错误),
`.readOnlyBuiltin` (The built-in workflow is read-only — clone it to edit. / 内置工作流为只读 —
克隆后编辑。), `.noSelection` (Select a node to edit its settings. / 选择一个节点以编辑其设置。),
`.mainOutput` (Main output / 主输出), `.config` (Settings / 设置), `.ports` (Ports / 端口),
`.saved` (Saved / 已保存), `.saveFailed` (Save failed / 保存失败), `.connect.incompatible`
(Incompatible port types / 端口类型不兼容), `.connect.occupied` (Input already connected /
输入端口已占用), `.connect.self` (Cannot connect a node to itself / 不能连接到自身),
`.connect.missing-port` (Unknown port / 未知端口).

- [x] **Step 1: Implement** view + registry + Panel label + i18n (BOTH locales).
- [x] **Step 2: Full gate.** Write the owner's manual-test script into your report: open the
  workflow-editor view → builtin loads read-only → Clone to edit → drag a `control.if` from the
  palette → wire `apply.state.variables → control.if.value` (works) and `llm.sample.raw →
  control.if.value`? (Text→Any ok) → try wiring `Text → when` (rejected, status shows) → edit the
  op enum in the panel → status chip stays Valid → Save → re-open → position + config persisted →
  switch all three themes and confirm contrast.
- [x] **Step 3: Commit** — `feat(workflow-editor): editor view with palette, top bar + validation status`

---

### Task 7: Docs + final gate

- [x] **Step 1:** Full gate. Re-read plan decisions vs code; fix drift.
- [x] **Step 2:** Mark this plan's checkboxes; add the Phase 4 status line to
  `docs/superpowers/plans/2026-07-01-node-workflow-phase2b-plan.md`'s status block. No `docs/sdk/`
  impact (editor is app UI, not card-facing) — state the check in the commit message.
- [x] **Step 3:** Commit — `docs(workflow): mark phase 4 editor complete`

---

## Self-review notes

- Spec §13 coverage: canvas+wiring+type-refusal (T2/T4), palette (T6), config side panel
  auto-rendered from declared schemas (T1/T5 — D12), top bar selector/save/clone/import/export/
  validate+status (T6), re-skin/WCAG-AA via tokens (T4 css + T6), workflowStore-equivalent (T3).
  Deferred + flagged: autosave (decision 5), run/trace panel + chat per-node panels + bespoke
  message editor (decision 6).
- Type consistency: `NodeTypeInfo` (T1) consumed by T2 (structural alias), T3, T5;
  `EditorNode/EditorEdge/canConnect/edgeId` (T2) consumed by T3/T4; store action names (T3)
  consumed by T4/T5/T6.
- Placeholder scan: clean — every code-bearing step has concrete code or an exact contract; UI
  tasks carry complete behavioral contracts in prose with exact names/keys.
