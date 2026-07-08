import { create } from 'zustand'
import {
  EditorEdge,
  EditorNode,
  EditorNodeType,
  canConnect,
  docToEditor,
  edgeId,
  editorToDoc
} from '../components/workflow/editorModel'
import {
  DynamicEnumHint,
  Edge,
  ExposedGroupSetting,
  GroupDecl,
  NodeDescriptor,
  NodeInstance,
  PortType,
  WorkflowDoc
} from '../../../shared/workflow/types'
import { nextGroupId } from '../components/workflow/groupModel'
import {
  agentTriggers,
  downstreamClosure,
  isAgentGroup,
  ungroupedTriggerChains
} from '../components/workflow/agentModel'
import { ValidationError, validateWorkflow } from '../../../shared/workflow/validate'

/** Structurally identical to main's `NodeTypeInfo` (src/main/services/nodes/catalog.ts) —
 *  redeclared locally since the renderer only sees this over IPC (renderer boundary). */
export interface NodeTypeInfo {
  type: string
  title: string
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
  isMainOutputCapable?: boolean
  configSchema?: Record<string, unknown>
  /** Agent & memory UX (WP-A): catalog hints surfaced through `list-node-types`. `isTrigger` drives the
   *  canvas's agent detection + on/off switch; `promptFields` routes prompt config to the Prompt editor;
   *  `dynamicEnum` describes an enum field whose options live in a sibling config array. */
  isTrigger?: boolean
  promptFields?: string[]
  dynamicEnum?: DynamicEnumHint
}

export interface WorkflowSummary {
  id: string
  name: string
  builtin?: boolean
  /** Absent = 'turn'. See workflowService.ts's WorkflowSummary — this is one of three
   *  independently-declared copies of this shape (sub-graph nodes v1 plan §5). */
  kind?: 'turn' | 'subgraph'
  /** On-disk doc fails validation — resolution would skip it (see workflowService). */
  invalid?: boolean
}

const BUILTIN_WORKFLOW_ID = 'default'

/** What kind of artifact the editor session is editing (agent-packs plan WP4.4). `'workflow'` is the
 *  Normal-mode default: `currentId` is a workflow file id, save routes to `saveWorkflow`. `'fragment'`
 *  is a pack-fragment session: `currentId`/`fragmentPackId` is a pack id, the doc is that pack's stored
 *  `kind:'fragment'` fragment, and save routes to `updateAgentPackFragment` (NOT the workflow file
 *  store — a fragment is never a workflow file; agentPackStore keeps it out of the workflow dir). */
export type EditorSessionType = 'workflow' | 'fragment'

/** The module payload the import IPC hands back (moduleTransferService.ModulePayload mirror) — the
 *  members + internal edges + exposed refs `insertModule` splices into the doc. Ids are as-authored;
 *  insertModule remints them. */
export interface ImportedModule {
  name: string
  description?: string
  creator?: string
  nodes: NodeInstance[]
  edges: Edge[]
  exposed?: ExposedGroupSetting[]
  /** Agent & memory UX (WP-A/WP-G): the group's author setup guidance — carried into GroupDecl.note
   *  at insert so an imported/palette agent keeps its note (previously silently dropped here). */
  note?: string
}

interface WorkflowEditorState {
  nodeTypes: NodeTypeInfo[]
  workflows: WorkflowSummary[]
  currentId: string | null
  doc: WorkflowDoc | null
  nodes: EditorNode[]
  edges: EditorEdge[]
  dirty: boolean
  readOnly: boolean
  /** The session kind (WP4.4). Governs the save dispatch + the editor UI's kind-specific gating (a
   *  fragment session hides the main-output affordance — a fragment is never run alone, so it carries
   *  no main output; validate.ts skips the exactly-one-main-output rule for kind:'fragment'). */
  sessionType: EditorSessionType
  /** The pack id whose fragment this session edits, or null in a workflow session. Save writes back
   *  to THIS pack via updateAgentPackFragment (builtins are refused main-side — the entry points only
   *  offer fragment editing on non-builtin forks, so a builtin never reaches this path). */
  fragmentPackId: string | null
  errors: ValidationError[]
  selectedNodeId: string | null
  /** One-canvas rebuild (WP6.3): the multi-selection RF maintains from 'select' changes. The
   *  existing `selectedNodeId` is kept as the LAST of this list so single-selection consumers are
   *  unaffected. */
  selectedNodeIds: string[]
  /** One-canvas rebuild (WP6.3): the selected group (module), mutually exclusive with node
   *  selection — selecting a group clears node selection and vice versa. */
  selectedGroupId: string | null
  /** Agent & memory UX (WP-F; spec §5): the Agents ▾ "locate" request — the FlowCanvas watches the
   *  token and pans/zooms to `groupId`. Null until the first locate. Bumping the token re-triggers
   *  even for the same group. */
  panRequest: { groupId: string; token: number } | null
  status: string | null
  init(profileId: string): Promise<void>
  open(profileId: string, id: string): Promise<void>
  /** Open a pack's fragment as an EDITABLE fragment session (agent-packs plan WP4.4). Loads the
   *  fragment via getAgentPackFragment into the SAME editor store the Normal-mode canvas drives — so
   *  drag / connect / add-node / config all work as normal — but marks the session `'fragment'` so
   *  save routes to updateAgentPackFragment. Returns { ok } so the caller can toast a load failure
   *  (an uninstalled pack / a builtin the entry points shouldn't have offered). */
  openFragment(profileId: string, packId: string): Promise<{ ok: boolean }>
  addNode(
    type: string,
    position: { x: number; y: number },
    config?: Record<string, unknown>
  ): void
  moveNode(id: string, position: { x: number; y: number }): void
  connect(from: { node: string; port: string }, to: { node: string; port: string }): void
  removeEdge(edgeId: string): void
  removeNode(id: string): void
  setNodeConfig(id: string, config: Record<string, unknown>): void
  /** One-canvas rebuild (WP6.4a): toggle a node's `disabled` flag (the engine skips a disabled node +
   *  its exclusive downstream; a disabled trigger never fires). readOnly/locked guards like setNodeConfig. */
  setNodeDisabled(id: string, disabled: boolean): void
  setNodePanel(id: string, panel: { show: boolean; label?: string } | undefined): void
  setMainOutput(id: string): void
  setDocName(name: string): void
  select(id: string | null): void
  /** One-canvas rebuild (WP6.3): sync the multi-selection from RF 'select' changes. Clears any
   *  group selection; `selectedNodeId` becomes the last id (or null). */
  setSelectedNodeIds(ids: string[]): void
  /** WP6.3: mint a GroupDecl over `selectedNodeIds`. No-op unless ≥2 are selected, none is already
   *  grouped, and none is locked. Selects the new group. */
  groupSelection(): void
  ungroup(groupId: string): void
  renameGroup(groupId: string, name: string): void
  toggleGroupCollapsed(groupId: string): void
  /** WP-F: request the canvas pan/zoom to a group + select it (the Agents ▾ locate button). */
  requestPanToGroup(groupId: string): void
  /** Agent & memory UX (WP-D; spec §4): one-click grouping — mint a collapsed GroupDecl over the
   *  trigger's downstream closure (agentModel.downstreamClosure: narrator-shared nodes excluded,
   *  sibling triggers absorbed). No-op unless the closure has ≥2 ungrouped members. Returns the new
   *  group id (null when refused). */
  collapseChainIntoModule(triggerId: string): string | null
  /** WP-D: collapse every AGENT group (trigger-rooted); non-agent groups are left alone. */
  collapseAllAgents(): void
  /** WP-D: expand every group. */
  expandAllGroups(): void
  /** WP-D: the agent card's on/off proxy — write `disabled` on ALL of the group's member triggers
   *  (mixed state always resolves by writing every member). */
  setGroupTriggersDisabled(groupId: string, disabled: boolean): void
  /** WP-D: group every UNGROUPED trigger chain (the .rptflow import auto-group pass — no review
   *  sheet exists for .rptflow, so this runs right after import-open, leaving the doc dirty for the
   *  user to save). Returns how many groups were created. */
  autoGroupTriggerChains(): number
  /** WP6.3: shift every member's position by `delta` (the collapsed-module drag). */
  moveGroup(groupId: string, delta: { dx: number; dy: number }): void
  /** WP6.3: promote a member setting onto the module panel (replace-if-same node+path). */
  exposeSetting(groupId: string, entry: ExposedGroupSetting): void
  unexposeSetting(groupId: string, node: string, path: string): void
  /** WP6.3: select a group (module) or clear group selection. Mutually exclusive with node select. */
  selectGroup(id: string | null): void
  /** WP6.5: insert an imported module into the current doc. Remints EVERY node id (collision-safe,
   *  the addNode idiom), remaps internal edges + exposed refs to the new ids, lands the members around
   *  `position`, creates a collapsed GroupDecl over them (carrying the module's `note`), selects the
   *  group, marks dirty. Returns the new group id (or null when there is no doc / the module is empty).
   *  Insertion is an EDIT — the user saves the doc themselves; this never writes.
   *  WP-G: `opts.origin: 'import'` stamps GroupDecl.origin (the Agents ▾ `imported` chip) — passed by
   *  the `.rptmodule` file-import path, NOT by a palette template insert (a built-in isn't "imported"). */
  insertModule(
    module: ImportedModule,
    position: { x: number; y: number },
    opts?: { origin?: 'import' }
  ): string | null
  save(profileId: string): Promise<void>
  cloneAndEdit(profileId: string): Promise<void>
}

const descriptorMap = (nodeTypes: NodeTypeInfo[]): Map<string, NodeDescriptor> =>
  new Map(
    nodeTypes.map((t) => [
      t.type,
      {
        type: t.type,
        title: t.title,
        inputs: t.inputs.map((p) => ({ name: p.name, type: p.type as PortType })),
        outputs: t.outputs.map((p) => ({ name: p.name, type: p.type as PortType })),
        ...(t.isMainOutputCapable ? { isMainOutputCapable: true } : {})
      }
    ])
  )

const editorNodeTypeMap = (nodeTypes: NodeTypeInfo[]): Map<string, EditorNodeType> =>
  new Map(nodeTypes.map((t) => [t.type, t]))

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => {
  /** Recompute `errors` from the current draft doc + set `dirty: true`. The one place every
   *  mutation routes through, so validation and dirty-tracking can never drift apart. */
  const revalidate = (): void => {
    const { doc, nodes, edges, nodeTypes } = get()
    if (!doc) return
    const nextDoc = editorToDoc(doc, nodes, edges)
    const result = validateWorkflow(nextDoc, descriptorMap(nodeTypes))
    set({
      errors: result.ok ? [] : result.errors,
      dirty: true
    })
  }

  /** WP6.3: the doc's current groups (empty when the doc has none / no doc). */
  const currentGroups = (): GroupDecl[] => get().doc?.groups ?? []

  /** WP6.3: write `groups` onto the draft doc and revalidate. Empties drop the `groups` key so a
   *  doc with no modules round-trips group-free (matches the optional-field convention elsewhere). */
  const setGroups = (groups: GroupDecl[]): void => {
    const { doc } = get()
    if (!doc) return
    const next = { ...doc }
    if (groups.length > 0) next.groups = groups
    else delete next.groups
    set({ doc: next })
    revalidate()
  }

  return {
    nodeTypes: [],
    workflows: [],
    currentId: null,
    doc: null,
    nodes: [],
    edges: [],
    dirty: false,
    readOnly: false,
    sessionType: 'workflow',
    fragmentPackId: null,
    errors: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedGroupId: null,
    panRequest: null,
    status: null,

    init: async (profileId) => {
      const [nodeTypes, workflows] = await Promise.all([
        window.api.listNodeTypes(),
        window.api.listWorkflows(profileId)
      ])
      set({ nodeTypes, workflows })
    },

    open: async (profileId, id) => {
      const doc = (await window.api.getWorkflow(profileId, id)) as WorkflowDoc
      const { nodes, edges } = docToEditor(doc)
      const readOnly = id === BUILTIN_WORKFLOW_ID
      const result = validateWorkflow(doc, descriptorMap(get().nodeTypes))
      set({
        currentId: id,
        doc,
        nodes,
        edges,
        readOnly,
        dirty: false,
        // Opening a WORKFLOW file always returns the session to the workflow kind — a prior fragment
        // session must not leak its save routing onto a workflow doc.
        sessionType: 'workflow',
        fragmentPackId: null,
        errors: result.ok ? [] : result.errors,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedGroupId: null,
        status: null
      })
    },

    openFragment: async (profileId, packId) => {
      const doc = (await window.api.getAgentPackFragment(profileId, packId)) as WorkflowDoc | null
      if (!doc) return { ok: false }
      const { nodes, edges } = docToEditor(doc)
      const result = validateWorkflow(doc, descriptorMap(get().nodeTypes))
      set({
        // The pack id is the session's identity for save routing; it doubles as `currentId` so the
        // existing UI (which reads currentId for the picker) has a stable non-null id, but the workflow
        // PICKER is disabled in a fragment session (see WorkflowEditorView) so this never selects a file.
        currentId: packId,
        doc,
        nodes,
        edges,
        // A fragment session is always editable — the entry points only offer it on NON-builtin forks
        // (updatePackFragment refuses builtins main-side regardless, so this is defense in depth). It is
        // never the readOnly builtin narrator.
        readOnly: false,
        sessionType: 'fragment',
        fragmentPackId: packId,
        dirty: false,
        errors: result.ok ? [] : result.errors,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedGroupId: null,
        status: null
      })
      return { ok: true }
    },

    addNode: (type, position, config) => {
      if (get().readOnly) return
      const { nodes } = get()
      const base = type.split('.').pop() || type
      const existingIds = new Set(nodes.map((n) => n.id))
      let n = 1
      while (existingIds.has(`${base}-${n}`)) n++
      const id = `${base}-${n}`
      const node: EditorNode = { id, type, position, ...(config ? { config } : {}) }
      set({ nodes: [...nodes, node] })
      revalidate()
    },

    moveNode: (id, position) => {
      if (get().readOnly) return
      set({
        nodes: get().nodes.map((n) => (n.id === id ? { ...n, position } : n))
      })
      revalidate()
    },

    connect: (from, to) => {
      if (get().readOnly) return
      const { nodes, edges, nodeTypes } = get()
      const verdict = canConnect(editorNodeTypeMap(nodeTypes), nodes, edges, from, to)
      if (!verdict.ok) {
        set({ status: `connect.${verdict.reason}` })
        return
      }
      const newEdge: EditorEdge = {
        id: edgeId({ from, to }),
        source: from.node,
        sourcePort: from.port,
        target: to.node,
        targetPort: to.port
      }
      set({ edges: [...edges, newEdge] })
      revalidate()
    },

    removeEdge: (edgeIdToRemove) => {
      if (get().readOnly) return
      set({ edges: get().edges.filter((e) => e.id !== edgeIdToRemove) })
      revalidate()
    },

    removeNode: (id) => {
      if (get().readOnly) return
      // WP6.3: strip the id from any group, then dissolve a group that drops below 2 members (its
      // exposures go with it — acceptable). Groups live on doc.groups; rebuild it here.
      const groups = currentGroups()
      const nextGroups = groups
        .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((nid) => nid !== id) }))
        .filter((g) => g.nodeIds.length >= 2)
      const nextDoc = get().doc
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
        ...(nextDoc
          ? {
              doc:
                nextGroups.length > 0
                  ? { ...nextDoc, groups: nextGroups }
                  : (() => {
                      const d = { ...nextDoc }
                      delete d.groups
                      return d
                    })()
            }
          : {}),
        // A dissolved / no-longer-existent group must not stay selected.
        ...(get().selectedGroupId && !nextGroups.some((g) => g.id === get().selectedGroupId)
          ? { selectedGroupId: null }
          : {})
      })
      revalidate()
    },

    setNodeConfig: (id, config) => {
      if (get().readOnly) return
      set({
        nodes: get().nodes.map((n) => (n.id === id ? { ...n, config } : n))
      })
      revalidate()
    },

    setNodeDisabled: (id, disabled) => {
      if (get().readOnly) return
      set({
        nodes: get().nodes.map((n) => {
          if (n.id !== id) return n
          // Absence = enabled; write the flag only when disabling so an enabled node stays flag-free
          // (matches the optional-field convention docToEditor/editorToDoc round-trip).
          if (disabled) return { ...n, disabled: true }
          const { disabled: _drop, ...rest } = n
          return rest
        })
      })
      revalidate()
    },

    setNodePanel: (id, panel) => {
      if (get().readOnly) return
      set({
        nodes: get().nodes.map((n) => {
          if (n.id !== id) return n
          if (!panel) {
            const { panel: _dropped, ...rest } = n
            return rest
          }
          return { ...n, panel }
        })
      })
      revalidate()
    },

    setDocName: (name) => {
      const { readOnly, doc } = get()
      if (readOnly || !doc) return
      // Name is doc metadata, not graph structure — no revalidation needed, just dirty.
      set({ doc: { ...doc, name }, dirty: true })
    },

    setMainOutput: (id) => {
      if (get().readOnly) return
      set({
        nodes: get().nodes.map((n) => ({
          ...n,
          isMainOutput: n.id === id
        }))
      })
      revalidate()
    },

    // Selecting a node clears any group selection (mutually exclusive) and keeps the multi-select in
    // sync (a single-node select is a 1-element list, or empty when clearing).
    select: (id) =>
      set({
        selectedNodeId: id,
        selectedNodeIds: id ? [id] : [],
        selectedGroupId: null
      }),

    setSelectedNodeIds: (ids) =>
      set({
        selectedNodeIds: ids,
        selectedNodeId: ids.length > 0 ? ids[ids.length - 1] : null,
        selectedGroupId: null
      }),

    selectGroup: (id) =>
      set({ selectedGroupId: id, selectedNodeId: null, selectedNodeIds: [] }),

    insertModule: (module, position, opts) => {
      if (get().readOnly) return null
      const { doc, nodes, edges } = get()
      if (!doc || module.nodes.length === 0) return null

      // Remint EVERY node id (the addNode idiom: base = type tail, next free `base-n`), tracking the
      // ids minted so far so two members of the same type can't collide. `used` seeds with the doc's
      // existing ids so the module can drop into a doc that already uses the authored ids.
      const used = new Set(nodes.map((n) => n.id))
      const idMap = new Map<string, string>()
      for (const src of module.nodes) {
        const base = src.type.split('.').pop() || src.type
        let n = 1
        while (used.has(`${base}-${n}`)) n++
        const id = `${base}-${n}`
        used.add(id)
        idMap.set(src.id, id)
      }

      // Land the members around `position`, preserving their relative layout. Anchor on the module's
      // top-left member so the whole slab shifts to where the user dropped it (a module authored far
      // from origin doesn't fly off-canvas).
      const positions = module.nodes.map((s) => s.position ?? { x: 0, y: 0 })
      const anchorX = Math.min(...positions.map((p) => p.x))
      const anchorY = Math.min(...positions.map((p) => p.y))
      const newNodes: EditorNode[] = module.nodes.map((src) => {
        const pos = src.position ?? { x: 0, y: 0 }
        return {
          id: idMap.get(src.id)!,
          type: src.type,
          position: { x: position.x + (pos.x - anchorX), y: position.y + (pos.y - anchorY) },
          ...(src.config !== undefined ? { config: src.config } : {}),
          ...(src.panel !== undefined ? { panel: src.panel } : {}),
          // isMainOutput is a TURN-doc concept scoped to the whole doc; a module never carries it in
          // (a spliced-in slab must not steal main-output). disabled rides along as-authored.
          ...(src.disabled !== undefined ? { disabled: src.disabled } : {})
        }
      })

      // Remap internal edges (every end is a member — the envelope guaranteed it) to the new ids.
      const newEdges: EditorEdge[] = module.edges.map((e) => {
        const from = { node: idMap.get(e.from.node)!, port: e.from.port }
        const to = { node: idMap.get(e.to.node)!, port: e.to.port }
        return {
          id: edgeId({ from, to }),
          source: from.node,
          sourcePort: from.port,
          target: to.node,
          targetPort: to.port
        }
      })

      // Remap exposed refs to the new ids (drop any whose node didn't remap — defensive).
      const newExposed: ExposedGroupSetting[] = (module.exposed ?? [])
        .filter((x) => idMap.has(x.node))
        .map((x) => ({ ...x, node: idMap.get(x.node)! }))

      const groups = currentGroups()
      const groupId = nextGroupId(groups)
      const group: GroupDecl = {
        id: groupId,
        name: module.name,
        nodeIds: newNodes.map((n) => n.id),
        collapsed: true,
        // Agent & memory UX (WP-F/WP-G): provenance only for a FILE import (the Agents ▾ `imported`
        // chip); a palette template insert is not "imported". The module's author note rides into the
        // group so the agent panel shows its setup guidance.
        ...(opts?.origin === 'import' ? { origin: 'import' as const } : {}),
        ...(module.note ? { note: module.note } : {}),
        ...(newExposed.length > 0 ? { exposed: newExposed } : {})
      }
      const nextDoc = { ...doc, groups: [...groups, group] }
      set({
        nodes: [...nodes, ...newNodes],
        edges: [...edges, ...newEdges],
        doc: nextDoc,
        selectedGroupId: groupId,
        selectedNodeId: null,
        selectedNodeIds: []
      })
      revalidate()
      return groupId
    },

    groupSelection: () => {
      if (get().readOnly) return
      const { selectedNodeIds } = get()
      if (selectedNodeIds.length < 2) return
      const groups = currentGroups()
      const grouped = new Set(groups.flatMap((g) => g.nodeIds))
      // Every selected node must be ungrouped (already-grouped nodes refuse the whole selection so a
      // partial group can't form).
      if (selectedNodeIds.some((id) => grouped.has(id))) return
      const id = nextGroupId(groups)
      const name = `Module ${groups.length + 1}`
      const group: GroupDecl = { id, name, nodeIds: [...selectedNodeIds] }
      setGroups([...groups, group])
      set({ selectedGroupId: id, selectedNodeId: null, selectedNodeIds: [] })
    },

    ungroup: (groupId) => {
      if (get().readOnly) return
      setGroups(currentGroups().filter((g) => g.id !== groupId))
      if (get().selectedGroupId === groupId) set({ selectedGroupId: null })
    },

    renameGroup: (groupId, name) => {
      if (get().readOnly) return
      setGroups(currentGroups().map((g) => (g.id === groupId ? { ...g, name } : g)))
    },

    toggleGroupCollapsed: (groupId) => {
      if (get().readOnly) return
      setGroups(
        currentGroups().map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
      )
    },

    requestPanToGroup: (groupId) => {
      // Select the group (highlights it + opens its panel) and bump the pan token the canvas watches.
      set((s) => ({
        selectedGroupId: groupId,
        selectedNodeId: null,
        selectedNodeIds: [],
        panRequest: { groupId, token: (s.panRequest?.token ?? 0) + 1 }
      }))
    },

    collapseChainIntoModule: (triggerId) => {
      if (get().readOnly) return null
      const { nodes, edges, nodeTypes } = get()
      const groups = currentGroups()
      const grouped = new Set(groups.flatMap((g) => g.nodeIds))
      if (grouped.has(triggerId)) return null
      const closure = downstreamClosure(nodes, edges, triggerId, editorNodeTypeMap(nodeTypes))
      // Only ungrouped members join (a node belongs to at most ONE group); need ≥2 to form a group.
      const memberIds = [...closure].filter((id) => !grouped.has(id))
      if (memberIds.length < 2) return null
      const id = nextGroupId(groups)
      const group: GroupDecl = {
        id,
        name: `Agent ${groups.length + 1}`,
        nodeIds: memberIds,
        collapsed: true
      }
      setGroups([...groups, group])
      set({ selectedGroupId: id, selectedNodeId: null, selectedNodeIds: [] })
      return id
    },

    collapseAllAgents: () => {
      if (get().readOnly) return
      const { nodes, nodeTypes } = get()
      const types = editorNodeTypeMap(nodeTypes)
      setGroups(
        currentGroups().map((g) =>
          isAgentGroup(nodes, g, types) && !g.collapsed ? { ...g, collapsed: true } : g
        )
      )
    },

    expandAllGroups: () => {
      if (get().readOnly) return
      setGroups(currentGroups().map((g) => (g.collapsed ? { ...g, collapsed: false } : g)))
    },

    setGroupTriggersDisabled: (groupId, disabled) => {
      if (get().readOnly) return
      const { nodes, nodeTypes } = get()
      const group = currentGroups().find((g) => g.id === groupId)
      if (!group) return
      const triggerIds = new Set(
        agentTriggers(nodes, group, editorNodeTypeMap(nodeTypes)).map((n) => n.id)
      )
      if (triggerIds.size === 0) return
      set({
        nodes: nodes.map((n) => {
          if (!triggerIds.has(n.id)) return n
          if (disabled) return { ...n, disabled: true }
          const { disabled: _drop, ...rest } = n
          return rest
        })
      })
      revalidate()
    },

    autoGroupTriggerChains: () => {
      if (get().readOnly) return 0
      const { nodes, edges, nodeTypes } = get()
      const groups = currentGroups()
      const chains = ungroupedTriggerChains(nodes, edges, groups, editorNodeTypeMap(nodeTypes))
      if (chains.length === 0) return 0
      const nextGroups = [...groups]
      for (const chain of chains) {
        nextGroups.push({
          id: nextGroupId(nextGroups),
          name: `Agent ${nextGroups.length + 1}`,
          nodeIds: [...chain],
          collapsed: true
        })
      }
      setGroups(nextGroups)
      return chains.length
    },

    moveGroup: (groupId, delta) => {
      if (get().readOnly) return
      const group = currentGroups().find((g) => g.id === groupId)
      if (!group) return
      // A collapsed-module drag shifts every member's position by the delta (the members are hidden;
      // their real positions still anchor the module + its expanded bounds).
      const members = new Set(group.nodeIds)
      set({
        nodes: get().nodes.map((n) =>
          members.has(n.id)
            ? { ...n, position: { x: n.position.x + delta.dx, y: n.position.y + delta.dy } }
            : n
        )
      })
      revalidate()
    },

    exposeSetting: (groupId, entry) => {
      if (get().readOnly) return
      setGroups(
        currentGroups().map((g) => {
          if (g.id !== groupId) return g
          // Replace-if-same node+path (re-exposing updates the label rather than duplicating).
          const exposed = (g.exposed ?? []).filter(
            (e) => !(e.node === entry.node && e.path === entry.path)
          )
          return { ...g, exposed: [...exposed, entry] }
        })
      )
    },

    unexposeSetting: (groupId, node, path) => {
      if (get().readOnly) return
      setGroups(
        currentGroups().map((g) => {
          if (g.id !== groupId) return g
          const exposed = (g.exposed ?? []).filter((e) => !(e.node === node && e.path === path))
          return exposed.length > 0 ? { ...g, exposed } : (() => {
            const { exposed: _drop, ...rest } = g
            return rest
          })()
        })
      )
    },

    save: async (profileId) => {
      const { readOnly, currentId, doc, nodes, edges, sessionType, fragmentPackId } = get()
      if (readOnly || !currentId || !doc) return
      const nextDoc = editorToDoc(doc, nodes, edges)

      // Fragment session (WP4.4): save routes to the PACK store, not the workflow file store. The
      // fragment doc round-trips its `kind:'fragment'` + `attachments` (editorToDoc preserves both),
      // so updatePackFragment's fragment-kind validation (≥1 attachment) passes. A builtin is refused
      // main-side (code:'builtin'); the entry points don't offer this on builtins, so it's a guard.
      if (sessionType === 'fragment' && fragmentPackId) {
        const res = await window.api.updateAgentPackFragment(profileId, fragmentPackId, nextDoc)
        if (!res?.ok) {
          set({ status: res?.error ?? 'saveFailed' })
          return
        }
        set({ doc: nextDoc, dirty: false, status: 'saved' })
        return
      }

      const result = await window.api.saveWorkflow(profileId, currentId, nextDoc)
      if (!result.ok) {
        set({ status: result.error })
        return
      }
      // Refresh the summaries so a rename shows up in the picker immediately.
      const workflows = await window.api.listWorkflows(profileId)
      set({ doc: nextDoc, dirty: false, status: 'saved', workflows })
    },

    cloneAndEdit: async (profileId) => {
      const { currentId } = get()
      if (!currentId) return
      const clone = await window.api.cloneWorkflow(profileId, currentId)
      if (!clone) return
      const workflows = await window.api.listWorkflows(profileId)
      set({ workflows })
      await get().open(profileId, clone.id)
    }
  }
})
