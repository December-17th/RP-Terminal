# One-Canvas Rebuild Plan (post-ADR 0011)

Date: 2026-07-03
Status: planned; supersedes the remaining phases of `2026-07-03-agent-packs-master-plan.md`
(phases 1–5 of that plan are BUILT and their engine/services layer is the substrate here; its
Amendments log remains the execution record of that era)
Spec: `docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-4.md`
Executor profile: Opus 4.8 agents at medium effort; every WP name states model+effort; every UI
WP walks the primary user journey end-to-end (standing rule).

The same discipline as the master plan applies (read-first lists, one layer per WP, the full
gate, characterization rules, i18n en+zh, deliberate-assertion lists for expected fallout).
Deletion is a feature: each WP lists what it RETIRES.

## WP6.1 — Trigger nodes + node-disable in the engine [shared+main]

New `trigger.state` / `trigger.cadence` / `trigger.manual` node types (config mirrors the WP2.1
trigger grammar — reuse its validation). Engine: chains reachable ONLY from trigger nodes are
excluded from turn runs; a `disabled` node flag (any node) marks the node + exclusive downstream
skipped with dead-edge semantics; a disabled trigger never fires. headlessRunService pivots from
pack attachments to scanning the ACTIVE workflow doc for trigger nodes (evaluation semantics —
commit boundaries, baselines, cadence floors, OR-dedupe per chain, depth cap — unchanged; the
trigger-state table re-keys from pack ids to (doc id, trigger node id): migration). Retires: the
pack-attachment trigger path. Characterization: turn behavior of docs without triggers unchanged.

## WP6.2 — Consolidated agent nodes + rebuilt memory workflows [main]

New nodes: `history input` (last N floors, role filter AI-reply+player-action), `agent`
(role-alternating prompt template + api preset — one LLM call), `parser` (reply → SQL v0),
reusing `table.apply` for SQL ops. The two memory experiences re-shipped as five-node chains in
example/default docs (cadence trigger = every-turn variant; state trigger on backlog = async
variant, with the trim + export wires into the narrator as visible canvas wiring). Retires: the
builtin packs (seed list) once the chains ship. Legacy node types stay registered.

## WP6.3 — Grouping: modules on the canvas [shared+renderer] — DETAILED SPEC

Controller-grounded 2026-07-03 against: editorModel.ts (pure doc↔editor mapping; editorToDoc is a
field whitelist — groups must be added to it), workflowEditorStore.ts (single `revalidate`
chokepoint; single `selectedNodeId`; mutations are plain actions), FlowCanvas.tsx (store-driven
controlled React Flow; custom node type 'rpt'; NodeChange handler), NodeConfigPanel + schemaForm
(config fields rendered from configSchema), docSchema.ts/validate.ts idioms. Groups are DOC
METADATA over in-place nodes — nothing moves, no subgraph extraction, no new doc kinds.

### A. Shared model (types.ts, docSchema.ts, validate.ts + tests)
```ts
// types.ts — WorkflowDoc gains: groups?: GroupDecl[]
export interface ExposedGroupSetting { node: string; path: string; label: string }
export interface GroupDecl {
  id: string                 // 'group-<n>', minted like addNode ids
  name: string
  nodeIds: string[]          // ≥2; a node belongs to at most ONE group; groups contain nodes only
  collapsed?: boolean        // persisted presentation state
  exposed?: ExposedGroupSetting[]
}
```
- docSchema: zod for the above (id/name nonempty; nodeIds min 2; exposed entries {node,path,label}
  all nonempty strings). Round-trip test.
- validate.ts, three new error codes, fragment/turn/subgraph-agnostic:
  `GROUP_MEMBER_MISSING` (a nodeIds entry not in doc.nodes), `GROUP_OVERLAP` (a node in two
  groups), `GROUP_EXPOSED_NOT_MEMBER` (exposed.node ∉ nodeIds). Path VALIDITY of exposed.path is
  NOT validated (config shape is schema-loose; a stale path renders as empty in the panel — same
  stance as materializeFragment's skip-with-log).
- editorModel.ts editorToDoc: add `...(base.groups !== undefined ? { groups: base.groups } : {})`
  to the whitelist (the known dropped-field trap — test it).

### B. New pure module: src/renderer/src/components/workflow/groupModel.ts (+ tests)
Exactly these functions, no more:
```ts
nextGroupId(groups: GroupDecl[]): string
groupBounds(nodes: EditorNode[], memberIds: Set<string>, pad?: number):
  { x: number; y: number; w: number; h: number }        // NODE_W=220/NODE_H=90 constants for extent
memberSetsByGroup(groups: GroupDecl[]): Map<string, Set<string>>
groupOfNode(groups: GroupDecl[], nodeId: string): GroupDecl | undefined
collapsedView(nodes: EditorNode[], edges: EditorEdge[], groups: GroupDecl[]): {
  visibleNodes: EditorNode[]                             // members of collapsed groups filtered out
  moduleNodes: Array<{ group: GroupDecl; position: {x,y}; memberCount: number }>  // pos = bounds top-left
  syntheticEdges: Array<{ id: string; source: string; sourcePort: string; target: string;
    targetPort: string; groupEdge: true }>               // boundary-crossing edges re-pointed to
}                                                        //   the module id; internal edges dropped;
                                                         //   id = 'grp:' + original edge id (dedupe repeats)
```
Boundary edge mapping: source∈group xor target∈group → replace the in-group end with the group id
and port name 'module' (one generic handle each side on the module node). Duplicate synthetic ids
collapse to one edge.

### C. Store (workflowEditorStore.ts) — additive state + actions
- State: `selectedNodeIds: string[]` (multi-select; maintained from RF 'select' changes — keep
  `selectedNodeId` = last of it for existing consumers), `selectedGroupId: string | null`
  (mutually exclusive with node selection: selecting either clears the other).
- Groups live on `doc.groups`; every mutation below goes through the existing `revalidate()`.
- Actions (guards: readOnly no-op; all are plain doc updates):
  `groupSelection(): void` — requires ≥2 selected, none already grouped → mint GroupDecl
  (name = 'Module <n>'), select the group.
  `ungroup(groupId)`, `renameGroup(groupId, name)`, `toggleGroupCollapsed(groupId)`,
  `moveGroup(groupId, delta: {dx,dy})` — shifts every member position by delta (collapsed drag),
  `exposeSetting(groupId, entry: ExposedGroupSetting)` (replace-if-same node+path),
  `unexposeSetting(groupId, node, path)`, `selectGroup(id | null)`.
- `removeNode` additionally strips the id from any group; a group dropping below 2 members is
  deleted (its exposure gone — acceptable, tested).
- Locked-node interactions (packEditRouter/lockedNodeIds): grouping actions are NO-OPS when any
  member is locked (one guard line; Effective mode dies in WP6.4 anyway).

### D. Canvas (FlowCanvas.tsx + workflowEditor.css)
- Compute `collapsedView(...)` in a memo; render `visibleNodes` as today.
- Two new RF node types:
  `rptModule` (collapsed group): card with name, member count, exposed count; ONE target handle
  'module' left + ONE source handle 'module' right (class rpt-port-any); click → selectGroup;
  a small expand button (calls toggleGroupCollapsed); draggable — position changes route to
  `moveGroup` with the delta (track drag start pos in the handler).
  `rptGroupFrame` (expanded group): a background rect at groupBounds with a header band (name +
  collapse button); `selectable: false; draggable: false; zIndex: -1` (RF supports zIndex on
  nodes); pointer-events only on the header buttons; click on header → selectGroup.
- Synthetic edges render `deletable: false`, dashed (reuse the existing dashed splice style from
  effectiveMode.css if trivially reusable, else a 3-line css class).
- Multi-select: enable RF's built-in (selectionOnDrag or shift-click — use RF defaults:
  `selectionKeyCode` default + `onSelectionChange` → store.selectedNodeIds). A "Group selection"
  button appears in the existing editor toolbar area when ≥2 unlocked, ungrouped nodes are
  selected (ground the toolbar's exact location in WorkflowEditorView and put one button there).
- deleteKeyCode on a selected module/frame: must NOT delete member nodes — RF remove changes for
  the module/frame ids are ignored in handleNodesChange (explicit guard).

### E. Settings panel (NodeConfigPanel.tsx)
- `selectedGroupId` set → render the MODULE panel instead of a node panel: editable name field,
  collapse/expand toggle, Ungroup button, and the exposed-settings list — each row: inline-
  editable label + the live control for the member's config at that path (read via the shared
  objectPath get; write = setNodeConfig on the member with the path set — reuse schemaForm's
  field renderer for the row's control if the path resolves to a schema field, else a plain text
  input) + a remove (unexpose) icon-button. Empty state: one line 'Select a node inside and
  expose its settings.'
- Node panel, when the node ∈ a group: each config field row rendered by schemaForm gains a small
  'expose' toggle (aria-labelled); on = exposeSetting(group, {node, path: fieldKey, label:
  fieldKey}); off = unexposeSetting. Nested paths beyond top-level schema fields are NOT
  exposable in v1.
- i18n: ~12 new keys (group/module panel labels, toolbar button, expose toggle), en+zh.

### F. Tests (named)
- shared: groups round-trip (docSchema); the three validate codes; editorToDoc preserves groups.
- groupModel: bounds; collapsedView visible/module/synthetic sets incl. xor-mapping + internal-
  edge dropping + duplicate-id collapse; nextGroupId.
- store: groupSelection guards (1 node = no-op; overlapping member = no-op); ungroup restores;
  rename; collapse toggle; moveGroup shifts members; expose/unexpose replace semantics;
  removeNode strips membership + dissolves <2-member groups; group actions no-op on locked.
- No characterization test touched.

### NON-GOALS (do not build)
No module import/export (WP6.5). No run-status aggregation on module nodes, no trigger-state
badges, no palette section, no drawer (WP6.4). No nested groups. No subgraph extraction or
subgraph.call involvement. No undo/redo machinery. No label auto-derivation beyond fieldKey. No
new dependencies. No changes to workflowEngine, main services, compose, or the pack system.
Size expectation: ~9 files touched, roughly +700 lines including tests. If the diff wants to
grow past that, stop and report instead.

## WP6.4 — The one canvas as THE surface [renderer]

Editor becomes the primary surface: palette left (nodes + agent modules section + import/export +
memory template binding), settings right (selection-driven), run-status overlay on nodes, live
trigger state on trigger nodes, disabled dimming, bottom run-history drawer replaying statuses
onto the canvas, prompt preview attached to the narrator's prompt node. Retires: the Agents
control center (six rails), Effective mode, launcher cards (workspace 'workflow'/'agents' ids
point at the editor). The wizard/inspector sheets survive with module framing.

## WP6.5 — Module files: import/export [main+renderer]

Module export (sub-graph + exposed settings + bundled schema/templates) and inspected import
(dedupe is per-doc now — importing twice = two module instances; capabilities re-derived locally;
unknown-node blockers). Reuses packPayload/envelope machinery with a module envelope kind.
Retires: the pack store/library/activation UI + IPC (data migration: installed non-builtin packs
offered as module files on first run, or exported to a folder — decide with the code; nothing
silently deleted). Recipes: the .rptrecipe surfaces are parked (formats/services kept, entries
removed) pending a doc-sharing rethink.

## WP6.6 — Deletion + consistency pass [renderer+main]

Remove retired code paths (control center, pack cards/detail, effective projection stores,
fork routing, scope switchers), prune i18n, update docs/agents-era SDK references, final polish
+ journey walks: (1) build the memory agent from palette nodes, group it, expose two settings,
toggle its trigger; (2) import a module file and see it run; (3) read a whole setup at a glance
on one canvas.

## Sequencing notes

6.1 → 6.2 → 6.3 → 6.4 → 6.5 → 6.6 strictly (each consumes the previous). The engine substrate of
phases 1–2 (headless evaluator, locks, run history, envelopes, materialization) is load-bearing
throughout — repurposed, not rewritten.
