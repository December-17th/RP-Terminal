# RF-04 — Palette search + categories, click-to-add, minimap, center insertion

Status: ready-for-human
Priority: P1 (canvas learnability)
Depends on: RF-03 landing first (same files; see PRD sequencing)

## Problem

The node palette (`WorkflowEditorView.tsx:383-423`) is one flat list of ~45 node types with no
search and no grouping; insertion is drag-only. The canvas has `<Controls>` but no minimap
(`FlowCanvas.tsx:614-615`). Module import inserts at a fixed `{x:220,y:200}`
(`WorkflowEditorView.tsx:166`) because the editor view sits outside the ReactFlow context — a
recorded parked item (handoff 2026-07-04 §3).

## Grounding (verified 2026-07-06)

- Node types arrive as `NodeTypeInfo[]` from `listNodeTypes()` (main-side catalog:
  `src/main/services/nodes/catalog.ts`); type ids are dot-namespaced (`trigger.state`,
  `table.apply`, `subgraph.call`, …). Localized titles: `tOpt('workflowEditor.nodeTitle.' + type)`
  falling back to `nt.title` (WorkflowEditorView.tsx:384).
- `addNode(type, position, config?)` exists on the store (used by the drop handler,
  FlowCanvas.tsx:590-591).
- `useReactFlow().screenToFlowPosition` is available inside `FlowCanvasInner` only.
- The Sub-graphs and Modules palette sections (WorkflowEditorView.tsx:429-508) are separate from
  the node-type list — leave their behavior unchanged (they may move inside the new scroll region).

## Changes

### 1. Pure palette model — NEW `src/renderer/src/components/workflow/paletteModel.ts`

```ts
import type { NodeTypeInfo } from '../../stores/workflowEditorStore'

export interface PaletteGroup { prefix: string; items: NodeTypeInfo[] }

/** Preferred category order; prefixes not listed append alphabetically after these. */
export const PALETTE_ORDER: string[] = [ /* derive from the real catalog — see below */ ]

/** Filter by `query` (case-insensitive substring over the type id AND the localized title
 *  provided by `titleOf`), then group by the prefix before the first '.'; a type with no '.'
 *  groups under 'other'. Groups ordered by PALETTE_ORDER then alphabetically; items keep
 *  catalog order. Empty groups dropped. */
export function groupPalette(
  nodeTypes: NodeTypeInfo[],
  query: string,
  titleOf: (nt: NodeTypeInfo) => string
): PaletteGroup[]
```

**Derive the real prefix list first** (grep `type: '` in `src/main/services/nodes/builtin/*.ts` or
log `listNodeTypes()` in a test) and fill `PALETTE_ORDER` with every actual prefix, triggers first,
generation/prompt next, then data (vars/table/lorebook/preset), then parse/tool/subgraph/control/util.
Record the final list in the PR description.

### 2. Palette UI — `WorkflowEditorView.tsx`

- Search `<input>` pinned above the list: value in local state, placeholder
  `t('workflowEditor.paletteSearch')`, `className="rpt-wfe-palette-search"`.
- Render `groupPalette(nodeTypes, query, titleOf)`: a small header per group
  (`tOpt('workflowEditor.cat.' + prefix) || prefix`) followed by its entries (same card markup as
  today, drag behavior unchanged).
- **Click-to-add:** `onClick` on each entry → `addNode(nt.type, jitter(centerPosition()))` where
  `jitter` adds ±40px random offset so repeated clicks don't stack exactly. Only when `!readOnly`.
  (Sub-graph chips: same click-to-add with the `{ workflow_id }` config, mirroring the drop path.)

### 3. Canvas API handle — `FlowCanvas.tsx`

New prop `onReady?: (api: { centerPosition: () => { x: number; y: number } }) => void`.
In `FlowCanvasInner`, wrap the ReactFlow in the existing outer div; keep a `ref` to it; in a
mount effect call `onReady({ centerPosition })` where `centerPosition` maps the wrapper's bounding
rect center through `screenToFlowPosition`. `WorkflowEditorView` stores it in a
`useRef<{ centerPosition: ... } | null>(null)`.

### 4. Module insertion at center — `WorkflowEditorView.tsx:166`

Replace `insertModule(result.module, { x: 220, y: 200 })` with the canvas API when available:
`insertModule(result.module, canvasApi.current?.centerPosition() ?? { x: 220, y: 200 })`.
This closes the parked "module insertion at viewport center" item — say so in the PR.

### 5. MiniMap — `FlowCanvas.tsx`

Import `MiniMap` from `@xyflow/react`; render `<MiniMap pannable zoomable className="rpt-wfe-minimap" />`
next to `<Controls>`. Theme it in `workflowEditor.css` (token-driven, all three themes must stay
legible):

```css
.rpt-workflow-editor .react-flow__minimap { background: var(--rpt-bg-secondary); border: 1px solid var(--rpt-border); }
.rpt-workflow-editor .react-flow__minimap-node { fill: var(--rpt-bg-tertiary); }
.rpt-workflow-editor .react-flow__minimap-mask { fill: rgb(0 0 0 / 0.35); }
```

### 6. i18n — BOTH locale files

`workflowEditor.paletteSearch`: en `Search nodes…` / zh `搜索节点…`.
One `workflowEditor.cat.<prefix>` key per REAL prefix found in step 1. Known translations to use
(fill the rest to match; keep ST terms): trigger `Triggers`/`触发器`, context `Context`/`上下文`,
vars `Variables`/`变量`, table `Tables`/`表格`, lorebook `Lorebook`/`世界书`, preset `Preset`/`预设`,
parse `Parsing`/`解析`, tool `Tools`/`工具`, subgraph `Sub-graphs`/`子图`, control `Control`/`流程控制`,
util `Utility`/`实用`, agent `Agent`/`代理`, prompt `Prompt`/`提示词`, message `Messages`/`消息`,
history `History`/`历史`, mvu `MVU`/`MVU`.

## Tests (named) — `test/workflow/paletteModel.test.ts` (pure)

1. Grouping: mixed types produce groups keyed by prefix, PALETTE_ORDER first, unknowns alphabetical.
2. Filtering matches type id substring case-insensitively.
3. Filtering matches the LOCALIZED title via `titleOf`.
4. Empty groups are dropped; empty query returns everything.
5. A type without '.' lands in `other`.

## User journey (PR description, for the owner pass)

Open editor → type "table" in the search → only table nodes remain, under their header → click one
→ it appears near the viewport center → drag still works → minimap reflects the graph and pans →
import a `.rptmodule` → it lands near center, not the top-left corner.

## NON-GOALS

- No collapsible/persisted category state; headers are static.
- No fuzzy search; substring only.
- No changes to node CARD rendering or the config panel.
- No palette favorites/recents.

## Size budget

≤ 320 lines diff (excl. tests).

## Comments

Implemented on branch `claude/nifty-mcclintock-6e6a1b`. All six sections done. Gate green:
`npm run typecheck` ✔, `npm run check:deps` ✔ (389 modules), `npm run test` ✔ (2036 tests, all
pass incl. paletteModel.test.ts 5/5 and i18nParity 4/4). Src diff ≈ 267 net-added lines excl.
tests (well under 320).

**Final REAL prefix list** — derived from the built-in registry
(`src/main/services/nodes/builtin/index.ts`, 45 registered `NodeImpl`s; verified each `type:` string).
21 distinct prefixes, in the PALETTE_ORDER I set:

`trigger, input, context, prompt, llm, parse, apply, output, agent, history, vars, table, lorebook,
mvu, text, messages, merge, tool, subgraph, control, util`

Deviations from the spec's suggested translation table (the spec said "one key per REAL prefix";
this is that reality, not a redesign):
- No `preset` prefix — the preset node is `prompt.preset`, so it falls under **prompt**.
- The spec wrote `message`; the real prefix is **messages** (`messages.trim`). Separately there are
  **text** (`text.template`) and **merge** (`merge.messages`).
- Extra prefixes not in the spec's table: **input** (`input.context`), **llm** (`llm.sample`),
  **apply** (`apply.state`), **output** (`output.writeFloor`).
Each got a `workflowEditor.cat.<prefix>` key in BOTH en.ts and zh.ts (ST terms kept: 世界书/预设/工具/
子图/触发器/变量/表格).

**Files:** NEW `paletteModel.ts` (pure), `WorkflowEditorView.tsx` (search input + grouped render +
click-to-add for node cards AND sub-graph chips + canvasApi ref + center module insertion),
`FlowCanvas.tsx` (`onReady` prop exposing `centerPosition` via screenToFlowPosition over the wrapper
rect; `<MiniMap pannable zoomable>`), `workflowEditor.css` (search-input + category-header + minimap
node/mask rules), `en.ts`/`zh.ts`. Closed the parked "module insertion at viewport center" item
(handoff 2026-07-04 §3) — module import now lands at the canvas center.
