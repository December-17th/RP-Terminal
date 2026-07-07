import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkflowEditorStore } from '../../src/renderer/src/stores/workflowEditorStore'
import type { WorkflowDoc } from '../../src/shared/workflow/types'
import { listNodeTypes } from '../../src/main/services/nodes/catalog'
import { docToEditor } from '../../src/renderer/src/components/workflow/editorModel'

// RF-03 — hand-rolled editor undo/redo history. Seeds the store DIRECTLY (setState) with a minimal
// doc/nodes/edges/nodeTypes; the mutating actions exercised here (addNode, connect, setNodeConfig,
// removeNode, moveNode) never touch window.api (verified in workflowEditorStore.ts — only
// init/open/openFragment/save/cloneAndEdit call window.api), so no IPC stub is needed except for the
// open()-resets-history case, which stubs getWorkflow/listWorkflows/validateWorkflow's inputs.
const NODE_TYPES = listNodeTypes()

const baseDoc = (): WorkflowDoc => ({
  id: 'custom-1',
  name: 'Custom',
  version: 1,
  schemaVersion: 1,
  nodes: [
    { id: 'ctx', type: 'input.context', position: { x: 0, y: 0 } },
    { id: 'write', type: 'output.writeFloor', position: { x: 260, y: 0 }, isMainOutput: true }
  ],
  edges: [{ from: { node: 'ctx', port: 'gen' }, to: { node: 'write', port: 'gen' } }]
})

/** Seed the store as if a doc were freshly open: nodes/edges derived from the doc, clean history. */
const seed = (): void => {
  const doc = baseDoc()
  const { nodes, edges } = docToEditor(doc)
  useWorkflowEditorStore.setState({
    nodeTypes: NODE_TYPES,
    workflows: [],
    currentId: 'custom-1',
    doc,
    nodes,
    edges,
    dirty: false,
    readOnly: false,
    sessionType: 'workflow',
    fragmentPackId: null,
    errors: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedGroupId: null,
    status: null,
    past: [],
    future: [],
    lastHistKey: null
  })
}

const s = () => useWorkflowEditorStore.getState()

beforeEach(() => {
  seed()
})

describe('RF-03 editor history', () => {
  it('1. addNode → undo restores the previous node count; redo reapplies', () => {
    const before = s().nodes.length
    s().addNode('text.template', { x: 100, y: 100 })
    expect(s().nodes.length).toBe(before + 1)

    s().undo()
    expect(s().nodes.length).toBe(before)

    s().redo()
    expect(s().nodes.length).toBe(before + 1)
  })

  it('2. consecutive setNodeConfig on the SAME node = one undo step; two different nodes = two', () => {
    // Same node twice → coalesced to one step.
    s().setNodeConfig('ctx', { a: 1 })
    s().setNodeConfig('ctx', { a: 2 })
    expect(s().past.length).toBe(1)
    s().undo()
    // One undo returns to the pre-edit config (undefined).
    expect(s().nodes.find((n) => n.id === 'ctx')?.config).toBeUndefined()

    // Fresh seed: two DIFFERENT nodes → two steps.
    seed()
    s().setNodeConfig('ctx', { a: 1 })
    s().setNodeConfig('write', { b: 1 })
    expect(s().past.length).toBe(2)
    s().undo()
    expect(s().nodes.find((n) => n.id === 'write')?.config).toBeUndefined()
    expect(s().nodes.find((n) => n.id === 'ctx')?.config).toEqual({ a: 1 })
    s().undo()
    expect(s().nodes.find((n) => n.id === 'ctx')?.config).toBeUndefined()
  })

  it('3. removeNode on a wired node → undo restores the node AND its edges', () => {
    expect(s().edges.length).toBe(1)
    s().removeNode('write')
    expect(s().nodes.some((n) => n.id === 'write')).toBe(false)
    expect(s().edges.length).toBe(0)

    s().undo()
    expect(s().nodes.some((n) => n.id === 'write')).toBe(true)
    expect(s().edges.length).toBe(1)
  })

  it('4. snapshotForDrag + moveNode×N + endDrag, twice = two undo steps', () => {
    // Drag 1: one snapshot, several mid-drag moves.
    s().snapshotForDrag()
    s().moveNode('ctx', { x: 10, y: 0 })
    s().moveNode('ctx', { x: 20, y: 0 })
    s().moveNode('ctx', { x: 30, y: 0 })
    s().endDrag()
    // A second snapshotForDrag WITHIN the same coalescing window would be skipped; endDrag reset it.
    s().snapshotForDrag()
    s().moveNode('ctx', { x: 40, y: 0 })
    s().endDrag()

    expect(s().past.length).toBe(2)
    s().undo()
    expect(s().nodes.find((n) => n.id === 'ctx')?.position.x).toBe(30)
    s().undo()
    expect(s().nodes.find((n) => n.id === 'ctx')?.position.x).toBe(0)
  })

  it('5. a new edit after undo clears future (canRedo false)', () => {
    s().addNode('text.template', { x: 100, y: 100 })
    s().undo()
    expect(s().future.length).toBe(1)

    // A fresh mutation discards the redo stack.
    s().addNode('text.template', { x: 150, y: 150 })
    expect(s().future.length).toBe(0)
  })

  it('6. history caps at 50 entries; open() resets it', async () => {
    // 60 keyless pushes (addNode never coalesces) — past caps at 50, oldest dropped.
    for (let i = 0; i < 60; i++) s().addNode('text.template', { x: i, y: 0 })
    expect(s().past.length).toBe(50)

    // open() clears history. Stub the IPC surface open() reads.
    const doc = baseDoc()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        getWorkflow: vi.fn().mockResolvedValue(doc),
        listWorkflows: vi.fn().mockResolvedValue([])
      }
    }
    await s().open('p1', 'custom-1')
    expect(s().past.length).toBe(0)
    expect(s().future.length).toBe(0)
    expect(s().lastHistKey).toBeNull()
  })
})
