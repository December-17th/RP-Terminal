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

## WP6.5 — Module files: import/export [shared+main+renderer] — DETAILED SPEC

Controller-grounded against: GroupDecl/ExposedGroupSetting (WP6.3), docSchema node/edge zod,
packEnvelope/packPayload idioms (byte-stable serialize, structured parse errors, unknown-key
warnings, size cap), deriveCapabilityReport, the transfer dialog idiom (agentPackTransferService:
dialog-free core + dialogs in IPC), saveTableTemplate (uuid-minting, never overwrites), the
WP6.3 module panel + WP6.4 editor top bar/palette locations, addNode's id-minting idiom.

### A. Shared: src/shared/workflow/moduleEnvelope.ts (+ tests)
```ts
{ formatVersion: 1, kind: 'rptmodule',
  module: { name: string; description?: string; creator?: string;
            nodes: NodeInstance[];            // the group's members, ids as-authored
            edges: Edge[];                    // INTERNAL edges only (both ends in nodes)
            exposed: ExposedGroupSetting[] }, // refs into nodes
  bundledTemplates?: BundledTemplate[] }      // reuse packPayload's schema
```
serializeModuleEnvelope / parseModuleEnvelope with the packEnvelope guarantees: byte-stable
2-space output (fixed key order), 8 MiB cap, structured errors ('too-large' | 'invalid-json' |
'unsupported-version' | 'invalid-envelope' | 'external-edge' (an edge end not in nodes) |
'exposed-not-member' | 'empty-module' (<2 nodes)), unknown-key warnings (reuse the collector
pattern). Nodes validated with the existing NodeInstance zod (disabled included); NO doc-level
fields (a module is not a doc).

### B. Main: moduleTransferService.ts + IPC (mirror the pack transfer shape, smaller)
- `buildModuleEnvelope(doc: WorkflowDoc, groupId, opts { includeTemplate?: TableTemplate })` —
  pure: members + internal edges (drop boundary edges) + exposed + name; opts.includeTemplate →
  bundledTemplates=[template].
- `exportModuleDialog(profileId, payload)` — save dialog (`<name>.rptmodule`), write UTF-8.
- `inspectModuleFile(path)` → { meta {name, nodeCount, description?, creator?},
  capabilityReport (deriveCapabilityReport over a synthetic doc of module.nodes/edges vs the
  real registry — unknown types are a BLOCKER), templatePlans (will-install/will-duplicate —
  saveTableTemplate semantics), warnings, token } — same 5-min single-use token map pattern
  (separate map; do NOT unify with the pack/recipe maps).
- `confirmModuleImport(token)` → { module payload } returned to the RENDERER (templates are
  installed main-side here; the graph insertion is a renderer/store concern — the doc being
  edited lives in the editor store, unsaved; main must not write the doc).
- `cancelModuleImport(token)`. IPC channels module-preview-export/module-export-dialog/
  module-import-dialog/module-confirm-import/module-cancel-import + preload types.
- Tests (dialog-free core): build drops boundary edges; external-edge/exposed-not-member/empty
  rejections; capability blocker on a fake type; template plan duplicate case; token single-use.

### C. Renderer: export from the module panel, import from the palette
- Module panel (NodeConfigPanel's ModulePanel): an "Export module…" button → optional "include
  table schema" checkbox (only when the chat has a template — getChatTableTemplate; the WHOLE
  active template is the v0 unit) → previewless direct save via the IPC (the module panel IS the
  review; no wizard). Toast with path.
- Palette: a "Modules" section at the bottom of the left column with one "Import module…"
  button. Flow: dialog → inspect result rendered in a compact centered sheet (name, node count,
  capability chips reusing the workflowEditor chip css or 6 new lines, unknown-type blocker
  list, template plans, warnings) → Install → store action `insertModule(module, position)`:
  remints EVERY node id via the addNode idiom (collision-safe), remaps internal edges + exposed
  refs, creates the GroupDecl (collapsed: true) at a viewport-center position, selects the
  group, marks dirty (the user saves the doc themselves — insertion is an EDIT, not a write).
  Cancel/dismiss → cancelModuleImport.
- en+zh (~14 keys). Tests: insertModule reminting/remap/group-creation as store tests; pure
  sheet view-model if extracted.

### NON-GOALS (6.5)
No pack-store/IPC deletion (6.6 decides data retention; the pack tables stay). No recipe surface
changes. No migration machinery for installed pack rows (owner-accepted: nothing silently
deleted, nothing auto-converted). No boundary-edge carrying or "dangling port hints" — an
imported module lands unwired and the user connects it (one toast line says so). No module
versioning/upgrade story. No registry of imported modules (the doc IS the storage). Size:
~600 prod + ~250 test lines; stop past that.

## WP6.6 — Deletion pass + journey walks [renderer] — DETAILED SPEC

Controller-grounded 2026-07-04 by mapping the import graph. The dead cluster is rooted at
ControlCenterOverlay (zero importers). KEEP-ALIVE list — these look pack-era but are load-bearing
for the editor; touching them is out of scope: runTimeline.ts (RunDrawer), previewDisplay.ts
(NodeConfigPanel preview), MemoryPane.tsx + memoryPaneModel.ts (the Memory sheet),
LauncherCard/viewRegistry + `.rpt-cc-launch*` css, `.rpt-agents-chip` css (ModuleImportSheet
reuses it), `.rpt-agentdetail*` css (Memory sheet), the runs IPC/bindings (drawer), runs.* i18n.

### A. Delete these files + their test files (the deliberate-deletion list)
src/renderer/src/components/workspace/: ControlCenterOverlay.tsx, AgentsView.tsx,
AgentPackDetail.tsx, AgentPackExportWizard.tsx, AgentPackImportInspector.tsx,
RecipeExportWizard.tsx, RecipeImportInspector.tsx, agentPackTransferDisplay.ts,
recipeTransferDisplay.ts, agentPackSettingsDisplay.ts, agentExplain.ts, agentPackDisplay.ts,
controlCenterRail.ts.
src/renderer/src/components/workflow/: EffectiveCanvas.tsx, effectiveProjection.ts,
packEditRouting.ts, effectiveMode.css (and its import site).
src/renderer/src/stores/: effectiveGraphStore.ts.
Tests deleted WITH their subjects (each is a pure-helper suite of a deleted module — list them in
the commit body): agentPackDisplay, agentExplain, agentPackSettingsDisplay,
agentPackTransferDisplay, recipeTransferDisplay, controlCenterRail, effectiveProjection,
packEditRouting test files. memoryPane.test stays (subject kept).

### B. Surgical trims in live files
- NodeConfigPanel.tsx: remove the effectiveGraphStore/effectiveProjection imports and every
  branch they fed (the WP3.6-era pack-node read-only/fork affordances — dead since 6.4a because
  lockedNodeIds is always empty; the ModulePanel/expose/preview features stay).
- workflowEditorStore.ts: remove lockedNodeIds/setLockedNodeIds/packEditRouter/setPackEditRouter
  + the isLocked/routeLocked helpers and their call sites (mutations lose the locked branches);
  delete the corresponding describe blocks in workflowEditorStore.test.ts (deliberate — the
  Effective mode they pinned is gone; every other store test stays).
- uiStore.ts: remove the ControlCenterRail type (last importers die in A).
- index.css: delete selector blocks with ZERO remaining references — candidates: .rpt-agents-*
  (EXCEPT .rpt-agents-chip and anything the grep proves live), .rpt-overview-* only if unused
  (MemoryPane uses several — verify per selector), .rpt-preview-*/.rpt-runs-* (previewDisplay/
  runTimeline consumers moved to workflowEditor.css? ground: RunDrawer/NodeConfigPanel preview
  use workflowEditor.css classes — then .rpt-preview-*/.rpt-runs-* blocks are AgentsView-only →
  delete; verify each by grep before deleting). Mechanism: for each candidate block, grep the
  class name across src/; delete only zero-hit blocks.
- i18n en.ts + zh.ts: delete keys with zero remaining t()/tOpt() references — prefixes to sweep:
  agents.* (KEEP agents.cap.* — ModuleImportSheet), recipe.*, controlCenter.* (KEEP
  controlCenter.launch.editorBody — LauncherCard), workflowEffective.*, nav.controlCenter*.
  Mechanism: grep per key; parity between locales after.

### C. Docs + status
- Plan status header of THIS file: mark WP6.1–6.6 built. Master plan
  (2026-07-03-agent-packs-master-plan.md) status header: note the ADR 0011 pivot superseded its
  UI phases and point here (2 lines, don't rewrite history).
- CONTEXT.md needs no change (already post-pivot).

### D. Journey walks (manual narrative in the report — the acceptance)
1. From an empty doc: drag trigger/history/agent/parser/SQL-ops from the palette, wire them,
   group into a module, expose the trigger threshold + the agent preset, toggle the trigger off
   and on from the node card.
2. Export that module to a file; import it back; confirm it lands collapsed, reminted, unwired,
   with exposed settings intact.
3. Open memory-fill-async in a chat: read the whole setup at a glance — narrator chain, agent
   chain, live trigger caption, disabled dimming when toggled, a run replayed from the drawer.
Walk these against the real UI code paths (not the app — cite the code path each step exercises
and any step that CANNOT work as described is a stop-and-report finding).

### DEFERRED (tier-2 cleanup, deliberately NOT this WP — record, don't do)
Main-side pack machinery stays dormant and tested: agentPackService/Store/Ipc (the module/runs/
doc-trigger channels live in agentPackIpc.ts), headlessRunService's pack path,
compose/checkpoints/attachments' pack surface, transfer services (pack+recipe), fragment-session
machinery (openFragment/updatePackFragment + uiStore field), pack DB tables (data retention:
nothing deleted). Removing them is real surgery with large deliberate test deletions — schedule
only if the dormant code starts costing (a one-line note in the plan suffices today).

### NON-GOALS
No main-process changes. No renames (listAgentPackRuns keeps its name). No fragment-session
removal. No new features. No touching the KEEP-ALIVE list. Size: net-NEGATIVE diff expected
(thousands deleted, tens added); additions beyond wiring removals are a red flag.

## Sequencing notes

6.1 → 6.2 → 6.3 → 6.4 → 6.5 → 6.6 strictly (each consumes the previous). The engine substrate of
phases 1–2 (headless evaluator, locks, run history, envelopes, materialization) is load-bearing
throughout — repurposed, not rewritten.
