import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkflowEditorStore } from '../src/renderer/src/stores/workflowEditorStore'
import { WorkflowDoc } from '../src/shared/workflow/types'
import { DEFAULT_GRAPH } from '../src/main/services/nodes/builtin/defaultGraph'
import { listNodeTypes } from '../src/main/services/nodes/catalog'

// The real builtin catalog (src/main/services/nodes/catalog.ts) — used as-is so the
// "open the real DEFAULT_GRAPH" test validates cleanly, and it already covers every type
// the custom-doc fixture below needs (input.context, output.writeFloor, control.if,
// text.template, etc.), so one catalog serves both.
const NODE_TYPES = listNodeTypes()

const customDoc = (): WorkflowDoc => ({
  id: 'custom-1',
  name: 'Custom',
  version: 1,
  schemaVersion: 1,
  nodes: [
    { id: 'ctx', type: 'input.context', position: { x: 0, y: 0 } },
    {
      id: 'write',
      type: 'output.writeFloor',
      position: { x: 260, y: 0 },
      isMainOutput: true
    }
  ],
  edges: [{ from: { node: 'ctx', port: 'gen' }, to: { node: 'write', port: 'gen' } }]
})

const workflowsList = () => [
  { id: 'default', name: 'Default Generation', builtin: true },
  { id: 'custom-1', name: 'Custom' }
]

const setupApi = (): void => {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      listNodeTypes: vi.fn().mockResolvedValue(NODE_TYPES),
      listWorkflows: vi.fn().mockResolvedValue(workflowsList()),
      getWorkflow: vi.fn(async (_profileId: string, id: string) => {
        if (id === 'default') return DEFAULT_GRAPH
        if (id === 'custom-1') return customDoc()
        return null
      }),
      saveWorkflow: vi.fn().mockResolvedValue({ ok: true, id: 'custom-1' }),
      cloneWorkflow: vi.fn().mockResolvedValue({ id: 'custom-1-clone', name: 'Custom (copy)' })
    }
  }
}

const profileId = 'p1'

beforeEach(() => {
  setupApi()
  useWorkflowEditorStore.setState({
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
    status: null
  })
})

describe('workflowEditorStore: init + open', () => {
  it('init loads nodeTypes + workflow list', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    const s = useWorkflowEditorStore.getState()
    expect(s.nodeTypes).toEqual(NODE_TYPES)
    expect(s.workflows).toEqual(workflowsList())
  })

  it('open(default) is read-only, valid (no errors), not dirty', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'default')
    const s = useWorkflowEditorStore.getState()
    expect(s.currentId).toBe('default')
    expect(s.readOnly).toBe(true)
    expect(s.dirty).toBe(false)
    expect(s.nodes.length).toBe(DEFAULT_GRAPH.nodes.length)
    expect(s.errors).toEqual([])
  })

  it('mutations are ignored (no-op) on the read-only builtin doc', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'default')
    const before = useWorkflowEditorStore.getState()

    before.addNode('control.if', { x: 10, y: 10 })
    before.moveNode('ctx', { x: 999, y: 999 })
    before.connect({ node: 'ctx', port: 'gen' }, { node: 'write', port: 'gen' })
    before.removeEdge('ctx:gen->write:gen')
    before.removeNode('ctx')
    before.setNodeConfig('write', { foo: 1 })
    before.setMainOutput('ctx')

    const after = useWorkflowEditorStore.getState()
    expect(after.nodes).toEqual(before.nodes)
    expect(after.edges).toEqual(before.edges)
    expect(after.dirty).toBe(false)
  })

  it('open(custom-1) is not read-only', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
    const s = useWorkflowEditorStore.getState()
    expect(s.readOnly).toBe(false)
    expect(s.currentId).toBe('custom-1')
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['ctx', 'write'])
  })
})

describe('workflowEditorStore: addNode', () => {
  beforeEach(async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
  })

  it('assigns the first free integer suffix off the type’s last segment', () => {
    useWorkflowEditorStore.getState().addNode('control.if', { x: 100, y: 100 })
    let ids = useWorkflowEditorStore.getState().nodes.map((n) => n.id)
    expect(ids).toContain('if-1')

    useWorkflowEditorStore.getState().addNode('control.if', { x: 100, y: 200 })
    ids = useWorkflowEditorStore.getState().nodes.map((n) => n.id)
    expect(ids).toContain('if-2')
  })

  it('new node has no config until the panel writes one', () => {
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })
    const node = useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'if-1')!
    expect(node.config).toBeUndefined()
  })

  it('marks dirty and re-runs validation', () => {
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })
    const s = useWorkflowEditorStore.getState()
    expect(s.dirty).toBe(true)
  })

  it('addNode(type, position, config) presets the new node’s config', () => {
    useWorkflowEditorStore
      .getState()
      .addNode('subgraph.call', { x: 0, y: 0 }, { workflow_id: 'sub-1' })
    const node = useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'call-1')!
    expect(node.config).toEqual({ workflow_id: 'sub-1' })
  })

  it('existing 2-arg addNode calls are unaffected (no config key at all)', () => {
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })
    const node = useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'if-1')!
    expect(node.config).toBeUndefined()
  })
})

describe('workflowEditorStore: connect', () => {
  beforeEach(async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })
    useWorkflowEditorStore.getState().addNode('text.template', { x: 0, y: 100 })
  })

  it('accepts a compatible, unoccupied, cross-node connection', () => {
    const before = useWorkflowEditorStore.getState().edges.length
    useWorkflowEditorStore
      .getState()
      .connect({ node: 'ctx', port: 'gen' }, { node: 'template-1', port: 'gen' })
    const s = useWorkflowEditorStore.getState()
    expect(s.edges.length).toBe(before + 1)
    expect(s.dirty).toBe(true)
  })

  it('rejects self-connection: sets status, edges unchanged', () => {
    const before = useWorkflowEditorStore.getState().edges
    useWorkflowEditorStore
      .getState()
      .connect({ node: 'template-1', port: 'text' }, { node: 'template-1', port: 'gen' })
    const s = useWorkflowEditorStore.getState()
    expect(s.edges).toEqual(before)
    expect(s.status).toBe('connect.self')
  })

  it('rejects an occupied target input port (FANIN): sets status, edges unchanged', () => {
    // write:gen is already occupied by ctx:gen->write:gen in the fixture doc.
    const before = useWorkflowEditorStore.getState().edges
    useWorkflowEditorStore
      .getState()
      .connect({ node: 'ctx', port: 'gen' }, { node: 'write', port: 'gen' })
    const s = useWorkflowEditorStore.getState()
    expect(s.edges).toEqual(before)
    expect(s.status).toBe('connect.occupied')
  })

  it('rejects incompatible port types: sets status, edges unchanged', () => {
    const before = useWorkflowEditorStore.getState().edges
    useWorkflowEditorStore
      .getState()
      .connect({ node: 'template-1', port: 'text' }, { node: 'write', port: 'variables' })
    const s = useWorkflowEditorStore.getState()
    expect(s.edges).toEqual(before)
    expect(s.status).toBe('connect.incompatible')
  })

  it('rejects a missing port (unknown node/port): sets status, edges unchanged', () => {
    const before = useWorkflowEditorStore.getState().edges
    useWorkflowEditorStore
      .getState()
      .connect({ node: 'ctx', port: 'gen' }, { node: 'does-not-exist', port: 'gen' })
    const s = useWorkflowEditorStore.getState()
    expect(s.edges).toEqual(before)
    expect(s.status).toBe('connect.missing-port')
  })
})

describe('workflowEditorStore: removeNode / removeEdge / setMainOutput', () => {
  beforeEach(async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
  })

  it('removeNode cascades edges touching it', () => {
    useWorkflowEditorStore.getState().removeNode('ctx')
    const s = useWorkflowEditorStore.getState()
    expect(s.nodes.find((n) => n.id === 'ctx')).toBeUndefined()
    expect(s.edges).toEqual([])
    expect(s.dirty).toBe(true)
  })

  it('removeEdge removes only the targeted edge', () => {
    const id = useWorkflowEditorStore.getState().edges[0].id
    useWorkflowEditorStore.getState().removeEdge(id)
    const s = useWorkflowEditorStore.getState()
    expect(s.edges.find((e) => e.id === id)).toBeUndefined()
  })

  it('setMainOutput exclusivity: sets on target, clears elsewhere', () => {
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })
    useWorkflowEditorStore.getState().setMainOutput('if-1')
    const s = useWorkflowEditorStore.getState()
    const write = s.nodes.find((n) => n.id === 'write')!
    const ifNode = s.nodes.find((n) => n.id === 'if-1')!
    expect(write.isMainOutput).toBeFalsy()
    expect(ifNode.isMainOutput).toBe(true)
  })
})

describe('workflowEditorStore: live validation', () => {
  it('deleting the main-output node produces a MAIN_OUTPUT error', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
    expect(useWorkflowEditorStore.getState().errors).toEqual([])

    useWorkflowEditorStore.getState().removeNode('write')
    const s = useWorkflowEditorStore.getState()
    expect(s.errors.some((e) => e.code === 'MAIN_OUTPUT')).toBe(true)
  })
})

describe('workflowEditorStore: save', () => {
  it('readOnly (builtin) -> save returns immediately, does not call saveWorkflow', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'default')
    await useWorkflowEditorStore.getState().save(profileId)
    expect(window.api.saveWorkflow).not.toHaveBeenCalled()
  })

  it('happy path: clears dirty, sets status to saved', async () => {
    ;(window.api.saveWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      id: 'custom-1'
    })
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })
    expect(useWorkflowEditorStore.getState().dirty).toBe(true)

    await useWorkflowEditorStore.getState().save(profileId)
    const s = useWorkflowEditorStore.getState()
    expect(s.dirty).toBe(false)
    expect(s.status).toBe('saved')
  })

  it('reject path: sets status to the error, keeps dirty true', async () => {
    ;(window.api.saveWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'bad graph'
    })
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
    useWorkflowEditorStore.getState().addNode('control.if', { x: 0, y: 0 })

    await useWorkflowEditorStore.getState().save(profileId)
    const s = useWorkflowEditorStore.getState()
    expect(s.dirty).toBe(true)
    expect(s.status).toBe('bad graph')
  })
})

describe('workflowEditorStore: cloneAndEdit', () => {
  it('clones currentId, refreshes the workflow list, opens the clone', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'default')
    ;(window.api.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...workflowsList(),
      { id: 'custom-1-clone', name: 'Custom (copy)' }
    ])
    ;(window.api.getWorkflow as ReturnType<typeof vi.fn>).mockImplementation(
      async (_profileId: string, id: string) => {
        if (id === 'default') return DEFAULT_GRAPH
        if (id === 'custom-1') return customDoc()
        if (id === 'custom-1-clone') return { ...customDoc(), id: 'custom-1-clone' }
        return null
      }
    )

    await useWorkflowEditorStore.getState().cloneAndEdit(profileId)
    const s = useWorkflowEditorStore.getState()
    expect(s.currentId).toBe('custom-1-clone')
    expect(s.readOnly).toBe(false)
    expect(s.workflows.some((w) => w.id === 'custom-1-clone')).toBe(true)
  })

  it('does nothing when cloneWorkflow returns null', async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'default')
    ;(window.api.cloneWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    await useWorkflowEditorStore.getState().cloneAndEdit(profileId)
    const s = useWorkflowEditorStore.getState()
    expect(s.currentId).toBe('default')
  })
})
