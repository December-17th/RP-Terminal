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
      cloneWorkflow: vi.fn().mockResolvedValue({ id: 'custom-1-clone', name: 'Custom (copy)' }),
      // Fragment session (WP4.4): the pack fragment read + write-back IPC.
      getAgentPackFragment: vi.fn(async (_profileId: string, packId: string) => {
        if (packId === 'my-fork') return fragmentDoc()
        return null
      }),
      updateAgentPackFragment: vi
        .fn()
        .mockResolvedValue({ ok: true, pack: { id: 'my-fork', builtin: false } })
    }
  }
}

/** A kind:'fragment' pack fragment doc (agent-packs plan WP4.4). Carries `attachments` (the fields the
 *  editor must round-trip) + a fragment-shaped graph (no main-output node — validate skips that rule). */
const fragmentDoc = (): WorkflowDoc => ({
  id: 'my-fork',
  name: 'My Fork',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  attachments: [{ kind: 'entry', checkpoint: 'context-ready', mode: 'branch' }],
  nodes: [
    { id: 'ctx', type: 'input.context', position: { x: 0, y: 0 } },
    { id: 'tmpl', type: 'text.template', position: { x: 260, y: 0 }, config: { text: 'hi' } }
  ],
  edges: [{ from: { node: 'ctx', port: 'gen' }, to: { node: 'tmpl', port: 'gen' } }]
})

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
    sessionType: 'workflow',
    fragmentPackId: null,
    errors: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedGroupId: null,
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

describe('workflowEditorStore: setNodeDisabled (WP6.4a)', () => {
  beforeEach(async () => {
    await useWorkflowEditorStore.getState().init(profileId)
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
  })

  it('toggles disabled on, then off (flag-free when enabled)', () => {
    useWorkflowEditorStore.getState().setNodeDisabled('ctx', true)
    expect(useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'ctx')!.disabled).toBe(true)
    expect(useWorkflowEditorStore.getState().dirty).toBe(true)

    useWorkflowEditorStore.getState().setNodeDisabled('ctx', false)
    expect(
      useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'ctx')!.disabled
    ).toBeUndefined()
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

describe('workflowEditorStore: fragment editing session (WP4.4)', () => {
  beforeEach(async () => {
    await useWorkflowEditorStore.getState().init(profileId)
  })

  it('openFragment loads the pack fragment as an EDITABLE session (nodes movable, config editable)', async () => {
    const res = await useWorkflowEditorStore.getState().openFragment(profileId, 'my-fork')
    expect(res).toEqual({ ok: true })
    const s = useWorkflowEditorStore.getState()
    expect(s.sessionType).toBe('fragment')
    expect(s.fragmentPackId).toBe('my-fork')
    expect(s.readOnly).toBe(false) // a fragment session is always editable (never the readOnly builtin)
    expect(s.doc?.kind).toBe('fragment')
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['ctx', 'tmpl'])
    // Fragment doc skips the main-output rule — a valid fragment opens with NO validation errors.
    expect(s.errors).toEqual([])

    // Nodes are movable (not locked — no Effective-mode lock in a fragment session).
    useWorkflowEditorStore.getState().moveNode('ctx', { x: 111, y: 222 })
    expect(useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'ctx')!.position).toEqual({
      x: 111,
      y: 222
    })
    // Config is editable.
    useWorkflowEditorStore.getState().setNodeConfig('tmpl', { text: 'edited' })
    expect(useWorkflowEditorStore.getState().nodes.find((n) => n.id === 'tmpl')!.config).toEqual({
      text: 'edited'
    })
  })

  it('openFragment returns { ok:false } for an uninstalled/missing pack (no session change)', async () => {
    const res = await useWorkflowEditorStore.getState().openFragment(profileId, 'nope')
    expect(res).toEqual({ ok: false })
    expect(useWorkflowEditorStore.getState().sessionType).toBe('workflow')
  })

  it('save routes to updateAgentPackFragment (NOT saveWorkflow) and round-trips attachments + kind', async () => {
    await useWorkflowEditorStore.getState().openFragment(profileId, 'my-fork')
    useWorkflowEditorStore.getState().moveNode('ctx', { x: 5, y: 5 }) // make it dirty
    expect(useWorkflowEditorStore.getState().dirty).toBe(true)

    await useWorkflowEditorStore.getState().save(profileId)

    // Dispatched to the PACK path, never the workflow-file path.
    expect(window.api.saveWorkflow).not.toHaveBeenCalled()
    expect(window.api.updateAgentPackFragment).toHaveBeenCalledTimes(1)
    const [, packId, savedDoc] = (
      window.api.updateAgentPackFragment as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, string, WorkflowDoc]
    expect(packId).toBe('my-fork')
    // The attachments-fix: editorToDoc must NOT drop the fragment's doc-level fields.
    expect(savedDoc.kind).toBe('fragment')
    expect(savedDoc.attachments).toEqual([
      { kind: 'entry', checkpoint: 'context-ready', mode: 'branch' }
    ])
    // The dragged position persisted into the saved fragment (drag now saves — the bug this WP fixes).
    expect(savedDoc.nodes.find((n) => n.id === 'ctx')!.position).toEqual({ x: 5, y: 5 })

    const s = useWorkflowEditorStore.getState()
    expect(s.dirty).toBe(false)
    expect(s.status).toBe('saved')
  })

  it('save surfaces a rejected fragment write (e.g. builtin) as status, keeps dirty', async () => {
    ;(window.api.updateAgentPackFragment as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      code: 'builtin',
      error: 'pack my-fork is builtin'
    })
    await useWorkflowEditorStore.getState().openFragment(profileId, 'my-fork')
    useWorkflowEditorStore.getState().moveNode('ctx', { x: 9, y: 9 })

    await useWorkflowEditorStore.getState().save(profileId)
    const s = useWorkflowEditorStore.getState()
    expect(s.status).toBe('pack my-fork is builtin')
    expect(s.dirty).toBe(true)
  })

  it('opening a WORKFLOW file after a fragment session resets sessionType to workflow', async () => {
    await useWorkflowEditorStore.getState().openFragment(profileId, 'my-fork')
    expect(useWorkflowEditorStore.getState().sessionType).toBe('fragment')
    await useWorkflowEditorStore.getState().open(profileId, 'custom-1')
    const s = useWorkflowEditorStore.getState()
    expect(s.sessionType).toBe('workflow')
    expect(s.fragmentPackId).toBeNull()
  })
})

describe('workflowEditorStore: on-canvas groups (WP6.3)', () => {
  const store = () => useWorkflowEditorStore.getState()
  // custom-1 has ctx + write; add a third node so we can form groups of ≥2 and leave one out.
  beforeEach(async () => {
    await store().init(profileId)
    await store().open(profileId, 'custom-1')
    store().addNode('control.if', { x: 500, y: 0 }) // id if-1
  })

  const groupOf = (id: string) => (store().doc?.groups ?? []).find((g) => g.id === id)

  it('groupSelection is a no-op with <2 selected', () => {
    store().setSelectedNodeIds(['ctx'])
    store().groupSelection()
    expect(store().doc?.groups).toBeUndefined()
  })

  it('groupSelection mints a Module over ≥2 selected nodes and selects it', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    const groups = store().doc?.groups ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('group-1')
    expect(groups[0].name).toBe('Module 1')
    expect(groups[0].nodeIds).toEqual(['ctx', 'write'])
    expect(store().selectedGroupId).toBe('group-1')
    expect(store().selectedNodeId).toBeNull()
  })

  it('groupSelection is a no-op when any selected node is already grouped (overlap)', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    // Now try to group write (already in group-1) with if-1 → refused, still one group.
    store().setSelectedNodeIds(['write', 'if-1'])
    store().groupSelection()
    expect(store().doc?.groups).toHaveLength(1)
  })

  it('ungroup restores (removes the group; nodes stay)', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    store().ungroup('group-1')
    expect(store().doc?.groups).toBeUndefined()
    expect(store().nodes.map((x) => x.id).sort()).toEqual(['ctx', 'if-1', 'write'])
    expect(store().selectedGroupId).toBeNull()
  })

  it('renameGroup updates the name', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    store().renameGroup('group-1', 'Memory')
    expect(groupOf('group-1')?.name).toBe('Memory')
  })

  it('toggleGroupCollapsed flips the collapsed flag', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    expect(groupOf('group-1')?.collapsed).toBeFalsy()
    store().toggleGroupCollapsed('group-1')
    expect(groupOf('group-1')?.collapsed).toBe(true)
    store().toggleGroupCollapsed('group-1')
    expect(groupOf('group-1')?.collapsed).toBe(false)
  })

  it('moveGroup shifts every member position by the delta', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    const ctxBefore = store().nodes.find((x) => x.id === 'ctx')!.position
    const writeBefore = store().nodes.find((x) => x.id === 'write')!.position
    const ifBefore = store().nodes.find((x) => x.id === 'if-1')!.position
    store().moveGroup('group-1', { dx: 40, dy: -15 })
    expect(store().nodes.find((x) => x.id === 'ctx')!.position).toEqual({
      x: ctxBefore.x + 40,
      y: ctxBefore.y - 15
    })
    expect(store().nodes.find((x) => x.id === 'write')!.position).toEqual({
      x: writeBefore.x + 40,
      y: writeBefore.y - 15
    })
    // A non-member is untouched.
    expect(store().nodes.find((x) => x.id === 'if-1')!.position).toEqual(ifBefore)
  })

  it('exposeSetting/unexposeSetting replace-if-same node+path semantics', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    store().exposeSetting('group-1', { node: 'ctx', path: 'p', label: 'First' })
    expect(groupOf('group-1')?.exposed).toEqual([{ node: 'ctx', path: 'p', label: 'First' }])
    // Re-expose same node+path replaces (updates label), does not duplicate.
    store().exposeSetting('group-1', { node: 'ctx', path: 'p', label: 'Renamed' })
    expect(groupOf('group-1')?.exposed).toEqual([{ node: 'ctx', path: 'p', label: 'Renamed' }])
    // A different path adds a second entry.
    store().exposeSetting('group-1', { node: 'write', path: 'q', label: 'Second' })
    expect(groupOf('group-1')?.exposed).toHaveLength(2)
    // Unexpose removes just that one.
    store().unexposeSetting('group-1', 'ctx', 'p')
    expect(groupOf('group-1')?.exposed).toEqual([{ node: 'write', path: 'q', label: 'Second' }])
  })

  it('removeNode strips membership and dissolves a group that drops below 2 members', () => {
    store().setSelectedNodeIds(['ctx', 'write'])
    store().groupSelection()
    store().removeNode('write') // group-1 now has only ctx → dissolved
    expect(store().doc?.groups).toBeUndefined()
    expect(store().selectedGroupId).toBeNull()
  })

  it('removeNode strips membership but keeps a group still ≥2 members', () => {
    store().setSelectedNodeIds(['ctx', 'write', 'if-1'])
    store().groupSelection()
    store().removeNode('if-1')
    expect(groupOf('group-1')?.nodeIds).toEqual(['ctx', 'write'])
  })
})

describe('workflowEditorStore: insertModule (WP6.5)', () => {
  const store = () => useWorkflowEditorStore.getState()
  beforeEach(async () => {
    await store().init(profileId)
    await store().open(profileId, 'custom-1') // has ctx (input.context) + write (output.writeFloor)
  })

  // A module whose authored node ids COLLIDE with the doc's existing ids (ctx), so reminting must
  // avoid the collision. Two internal edges + one exposed ref to test remap.
  const module = () => ({
    name: 'Imported Mem',
    nodes: [
      { id: 'ctx', type: 'input.context', position: { x: 0, y: 0 } },
      { id: 'if', type: 'control.if', position: { x: 200, y: 40 }, config: { path: 'x' } }
    ],
    edges: [{ from: { node: 'ctx', port: 'gen' }, to: { node: 'if', port: 'gen' } }],
    exposed: [{ node: 'if', path: 'path', label: 'Path' }]
  })

  it('remints colliding ids, remaps edges + exposed, creates a collapsed group, marks dirty', () => {
    const before = store().nodes.map((n) => n.id)
    const groupId = store().insertModule(module(), { x: 300, y: 300 })
    expect(groupId).toBeTruthy()

    const s = store()
    // The doc already had a `ctx`; the imported input.context must NOT reuse it (collision-safe).
    const newIds = s.nodes.map((n) => n.id).filter((id) => !before.includes(id))
    expect(newIds).toHaveLength(2)
    expect(newIds).not.toContain('ctx')
    expect(s.dirty).toBe(true)

    // The group was created collapsed over exactly the new ids, and selected.
    const group = (s.doc?.groups ?? []).find((g) => g.id === groupId)
    expect(group?.collapsed).toBe(true)
    expect(group?.nodeIds.sort()).toEqual([...newIds].sort())
    expect(s.selectedGroupId).toBe(groupId)

    // The internal edge was remapped to the new ids (both ends are new nodes).
    const importedEdge = s.edges.find((e) => newIds.includes(e.source) && newIds.includes(e.target))
    expect(importedEdge).toBeTruthy()

    // The exposed ref was remapped to the new `if` node id (not the authored one).
    const exposed = group?.exposed ?? []
    expect(exposed).toHaveLength(1)
    expect(newIds).toContain(exposed[0].node)
    expect(exposed[0].path).toBe('path')
  })

  it('returns null on the read-only builtin doc (no insertion)', async () => {
    await store().open(profileId, 'default')
    const before = store().nodes.length
    expect(store().insertModule(module(), { x: 0, y: 0 })).toBeNull()
    expect(store().nodes).toHaveLength(before)
  })

  // Agent & memory UX WP-G: the module's author `note` rides into GroupDecl.note (it was silently
  // dropped before), and `origin: 'import'` is stamped ONLY for the file-import path (opts) — a
  // palette template insert is not "imported".
  it('carries module.note into the group; origin stamped only with opts.origin', () => {
    const withNote = { ...module(), note: 'bind a table template first' }

    const paletteGroupId = store().insertModule(withNote, { x: 300, y: 300 })
    const paletteGroup = (store().doc?.groups ?? []).find((g) => g.id === paletteGroupId)
    expect(paletteGroup?.note).toBe('bind a table template first')
    expect(paletteGroup?.origin).toBeUndefined()

    const importGroupId = store().insertModule(withNote, { x: 600, y: 600 }, { origin: 'import' })
    const importGroup = (store().doc?.groups ?? []).find((g) => g.id === importGroupId)
    expect(importGroup?.origin).toBe('import')
    expect(importGroup?.note).toBe('bind a table template first')
  })
})
