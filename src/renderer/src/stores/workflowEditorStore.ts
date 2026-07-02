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
        status: null
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
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id)
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
