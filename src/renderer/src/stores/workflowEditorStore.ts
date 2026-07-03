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
import { NodeDescriptor, PortType, WorkflowDoc } from '../../../shared/workflow/types'
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

interface WorkflowEditorState {
  nodeTypes: NodeTypeInfo[]
  workflows: WorkflowSummary[]
  currentId: string | null
  doc: WorkflowDoc | null
  nodes: EditorNode[]
  edges: EditorEdge[]
  dirty: boolean
  readOnly: boolean
  errors: ValidationError[]
  selectedNodeId: string | null
  status: string | null
  /** Node ids the editor must NOT mutate even when the doc is otherwise editable (agent-packs plan
   *  WP3.6a; ADR 0010). Effective mode marks every PACK node id here so pack nodes are locked at the
   *  MODEL layer — every mutating action (setNodeConfig/setMainOutput/setNodePanel/removeNode/connect
   *  touching a locked node) is a no-op — not merely hidden in the UI. Empty in Normal mode, so
   *  Normal-mode editing is completely unaffected. WP3.6b replaces this lock with fork-routing. */
  lockedNodeIds: Set<string>
  setLockedNodeIds(ids: Set<string>): void
  /** WP3.6b: the pack-edit router. In Effective mode a mutation on a PACK node is no longer a no-op —
   *  it is handed to this router (projection node ids, un-remapped), which forks-on-first-edit or
   *  writes through to the fork (effectiveGraphStore.routePackEdit). Null in Normal mode / when unset,
   *  so a locked-node edit stays a no-op exactly as WP3.6a (never a stray mutation of the draft). The
   *  router owns un-prefixing + owner resolution; the store only forwards the raw editor intent. */
  packEditRouter:
    | ((edit: import('../components/workflow/packEditRouting').FragmentEdit) => void)
    | null
  setPackEditRouter(
    router:
      | ((edit: import('../components/workflow/packEditRouting').FragmentEdit) => void)
      | null
  ): void
  init(profileId: string): Promise<void>
  open(profileId: string, id: string): Promise<void>
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
  setNodePanel(id: string, panel: { show: boolean; label?: string } | undefined): void
  setMainOutput(id: string): void
  setDocName(name: string): void
  select(id: string | null): void
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

  /** Whether node `id` is locked against mutation (Effective mode's pack nodes — WP3.6a). Empty set
   *  in Normal mode, so this is always false there. Load-bearing model-layer guard: it makes a locked
   *  node's edits no-ops regardless of the UI, which the WP3.6a acceptance asserts. */
  const isLocked = (id: string): boolean => get().lockedNodeIds.has(id)

  /** Forward a locked-node edit to the pack-edit router (WP3.6b). Returns true when a router consumed
   *  it (the caller then RETURNS without mutating the draft — the router forks / writes through to the
   *  fork instead). Returns false when there is no router (Normal mode / unset), so the caller falls
   *  back to WP3.6a's no-op — a locked node is never mutated in the draft. */
  const routeLocked = (
    edit: import('../components/workflow/packEditRouting').FragmentEdit
  ): boolean => {
    const router = get().packEditRouter
    if (!router) return false
    router(edit)
    return true
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
    errors: [],
    selectedNodeId: null,
    status: null,
    lockedNodeIds: new Set<string>(),
    packEditRouter: null,

    setLockedNodeIds: (ids) => set({ lockedNodeIds: ids }),
    setPackEditRouter: (router) => set({ packEditRouter: router }),

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
        errors: result.ok ? [] : result.errors,
        selectedNodeId: null,
        status: null,
        // Opening a doc in Normal mode clears any Effective-mode pack lock (a fresh doc has no pack
        // nodes; the lock is set only while Effective mode is active).
        lockedNodeIds: new Set<string>()
      })
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
      // Pack nodes: position drags are EXEMPT from fork-on-edit (WP3.6b). A drag alone must not fork a
      // pack, and pack node positions in Effective mode are projection-programmatic (never written to
      // the fragment) — so a locked-node move stays a silent no-op, not a routed edit. Narrator nodes
      // in Effective mode are never draggable on the projection canvas anyway (EffectiveCanvas).
      if (get().readOnly || isLocked(id)) return
      set({
        nodes: get().nodes.map((n) => (n.id === id ? { ...n, position } : n))
      })
      revalidate()
    },

    connect: (from, to) => {
      if (get().readOnly) return
      // A connection touching a pack node (WP3.6b): a PACK-INTERNAL edge (both ends the same locked
      // pack) routes through the fork; a splice edge (exactly one end locked — narrator↔pack) stays
      // locked (attachment wiring is manifest surgery, out of scope this WP) → no-op.
      const fromLocked = isLocked(from.node)
      const toLocked = isLocked(to.node)
      if (fromLocked || toLocked) {
        if (fromLocked && toLocked) routeLocked({ kind: 'connect', from, to })
        return
      }
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
      if (isLocked(id)) {
        routeLocked({ kind: 'removeNode', nodeId: id })
        return
      }
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id)
      })
      revalidate()
    },

    setNodeConfig: (id, config) => {
      if (get().readOnly) return
      if (isLocked(id)) {
        routeLocked({ kind: 'config', nodeId: id, config })
        return
      }
      set({
        nodes: get().nodes.map((n) => (n.id === id ? { ...n, config } : n))
      })
      revalidate()
    },

    setNodePanel: (id, panel) => {
      if (get().readOnly) return
      if (isLocked(id)) {
        routeLocked({ kind: 'panel', nodeId: id, panel })
        return
      }
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
      if (isLocked(id)) {
        routeLocked({ kind: 'mainOutput', nodeId: id })
        return
      }
      set({
        nodes: get().nodes.map((n) => ({
          ...n,
          isMainOutput: n.id === id
        }))
      })
      revalidate()
    },

    select: (id) => set({ selectedNodeId: id }),

    save: async (profileId) => {
      const { readOnly, currentId, doc, nodes, edges } = get()
      if (readOnly || !currentId || !doc) return
      const nextDoc = editorToDoc(doc, nodes, edges)
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
