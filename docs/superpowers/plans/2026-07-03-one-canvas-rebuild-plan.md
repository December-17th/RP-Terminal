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

## WP6.4a — Editor internals: triggers live, runs replay, effective mode dies — DETAILED SPEC

Controller-grounded against WorkflowEditorView.tsx (composition root; the entire Effective block
at ~lines 78–130+: EditorMode state, EffectiveCanvas branch, effectiveGraphStore selectors,
lock/router wiring, triggerCaptions), FlowCanvas (RptNode, traceByNode gating on
`lastTrace.workflowId === currentId`), NodeConfigPanel, runTimeline.ts + previewDisplay.ts pure
helpers, StoredRunRecord/listAgentPackRuns, previewNextPrompt IPC, WP6.1's evaluateTriggerCore +
workflowTriggerStore.

### A. Retire Effective mode from the editor (usage only; file deletion is WP6.6)
WorkflowEditorView: delete the EditorMode state + toggle UI, the EffectiveCanvas import/render
branch, all effectiveGraphStore selectors and fetch/clear effects, setLockedNodeIds /
setPackEditRouter / routePackEdit wiring, triggerCaptions state. uiStore fields and the dead
modules (EffectiveCanvas, effectiveGraphStore, effectiveProjection, packEditRouting) stay
untouched-but-unreferenced until 6.4b/6.6. The editor keeps: picker/save/clone/import/export
top bar, fragment sessions, palette/canvas/config columns, the 6.3 group toolbar button.

### B. Disabled nodes (uses WP6.1's NodeInstance.disabled)
- editorModel: `EditorNode.disabled?: boolean`; docToEditor copies it; editorToDoc whitelists it
  (the trap — test).
- Store: `setNodeDisabled(id: string, disabled: boolean)` → node update through revalidate();
  readOnly/locked guards like setNodeConfig.
- FlowCanvas RptNode: `disabled` → class `rpt-node-disabled` (css: opacity .45 + dashed border,
  tokens only). Trigger nodes (renderer check: `editorNode.type.startsWith('trigger.')` — one
  comment noting isTrigger lives main-side and this string check is the pragmatic mirror) render
  an inline on/off switch in the title row (stopPropagation; aria-label; calls setNodeDisabled).
- NodeConfigPanel: an "Enabled" checkbox row at the top of every node's panel (writes disabled).

### C. Live trigger badges (one small main addition)
- main: `explainDocTriggers(profileId, chatId)` in headlessRunService → per enabled trigger node
  of the chat's RESOLVED doc: `{ nodeId, description, met, current?, required? }` — read-only
  over evaluateTriggerCore + the workflowTriggerStore accessor (NO baseline writes; mirrors the
  pack-era explainTriggers factoring). IPC `workflow-explain-doc-triggers` + preload binding.
  Test: two calls leave workflow_trigger_state untouched; met/unmet + current/required shapes.
- FlowCanvas: fetch once per (open doc, activeChatId) when `currentId` matches the chat's
  resolved doc id (reuse the trace-overlay gating idiom); render on trigger nodes a caption line:
  description + "now {current} · at {required}" + a met dot. Refresh after save and via the
  drawer's refresh. NO polling.

### D. Run drawer (new components/workflow/RunDrawer.tsx)
- Collapsible strip at the bottom of WorkflowEditorView's body (collapsed by default; header =
  last run's one-liner + count + expand chevron; ~40vh expanded, own scroll).
- Data: listAgentPackRuns(profileId, activeChatId) page-1 only + a refresh button (no infinite
  scroll here — NON-GOAL). Entry row: origin badge (turn/headless/manual), sentence via the
  IMPORTED runTimeline.ts helpers (runFacts/outcomeSentence — do not duplicate), HH:mm,
  duration. No per-pack filter chips.
- Click an entry → replay: WorkflowEditorView holds `replayTrace: WorkflowRunTrace | null`;
  FlowCanvas gains prop `traceOverride?: WorkflowRunTrace | null` — when set it REPLACES the
  live lastTrace map and skips the workflowId gate (node ids map directly; ids that don't exist
  in the open doc simply don't paint). Selected row highlighted; a "live" reset affordance
  clears replay; doc switch / chat switch clears it.
- en+zh keys (~10).

### E. Prompt preview on the assemble node
NodeConfigPanel: when the selected node's type === 'prompt.assemble' and a chat is active, a
"Preview next prompt" section: button → previewNextPrompt IPC → compact section list (label,
source chip, est. tokens, expandable text) reusing previewDisplay.ts pure helpers via import.
Loading/error inline. Hidden with no chat. (~60 lines + css.)

### NON-GOALS (6.4a)
No control-center/TopNav/launcher/uiStore changes (6.4b). No palette changes, no module palette
section, no import/export moves (6.5). No file deletions or store-field removals (6.6). No
polling, no run-history pagination, no per-node run filtering, no new dependencies.
Size expectation: ~650 prod + ~250 test lines; stop and report past that.

## WP6.4b — Surface promotion: the editor is THE surface [renderer] — DETAILED SPEC

### A. Entry points
- TopNav: the 'Agents' tab becomes the editor opener: label key nav.flow (en "Workflow", zh
  「工作流」), calls openWorkflowEditor() (no mode arg — modes are gone). The control-center
  opener is removed.
- viewRegistry launcher cards ('agents' and 'workflow' ids): both repoint their Open action to
  openWorkflowEditor(); copy updated ("Workflows and agents live in the editor now"), en+zh.
- WorkflowPanel (the legacy workspace 'workflow' view body) stays as-is if it is the launcher
  (ground: post-WP3.7 both ids render LauncherCard — then only the card copy/action changes).

### B. Retire the control center from the app
- App.tsx: remove the ControlCenterOverlay mount. uiStore: remove controlCenterOpen/
  controlCenterRail/openControlCenter/closeControlCenter + workflowEditorInitialMode machinery
  (Effective mode is gone); FIX every caller: TablesView's "Configure in Memory" button (see C),
  Overview/AgentPackDetail/AgentsView callers all die with their files' retirement mark — for
  6.4b they become unreferenced, not deleted (6.6 deletes). ControlCenterOverlay.tsx itself
  becomes unreferenced.
- Keep agentPackIpc + stores intact (module import in 6.5 rewires; runs IPC feeds the drawer).

### C. Memory configuration home
The editor top bar gains a "Memory…" button (i18n'd) opening a right-side sheet (the
AgentPackDetail side-panel css pattern) hosting the EXISTING MemoryPane component UNCHANGED
(it is self-contained: template binding, progress, backfill). TablesView's configure hint
repoints to openWorkflowEditor + a one-line note ("Memory settings live in the workflow
editor"). MemoryPane's internal jump-to-Installed strip: gate it behind a prop or leave dead
(installed rail no longer exists) — pass a flag to hide the packs strip; two-line change inside
MemoryPane guarded by the prop, nothing else inside it.

### NON-GOALS (6.4b)
No deletion of AgentsView/panes/ControlCenterOverlay files (6.6). No module palette/import
(6.5). No changes to transfer services/IPC. No editor-internal features beyond the Memory
button. Size: ~250 prod lines; stop past that.

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
