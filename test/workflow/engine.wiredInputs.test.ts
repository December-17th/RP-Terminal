import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, NodeMeta, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'
import { controlIf } from '../../src/main/services/nodes/builtin/controlNodes'

// Engine `wiredInputs` (agent-memory-ux WP-B; plan §0.2): the third run() argument carries the
// input-port names that have ≥1 incoming edge in the doc — live OR dead — so a node can tell
// "wired but not fired" from "not wired at all". Pins: (1) the engine supplies exactly the wired
// port names, (2) a dead edge still counts as wired, (3) a legacy node that ignores the field
// behaves exactly as before (characterization spot check).

const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

describe('runWorkflow — NodeMeta.wiredInputs (WP-B)', () => {
  it('supplies exactly the wired input-port names, excluding unwired ports', async () => {
    const seen: NodeMeta[] = []
    const impls: NodeImpl[] = [
      {
        type: 'src',
        title: 'src',
        inputs: [],
        outputs: [{ name: 'out', type: 'Text' }],
        run: () => ({ outputs: { out: 'data' } })
      },
      {
        type: 'firingGate',
        title: 'firingGate',
        inputs: [],
        outputs: [{ name: 'fire', type: 'Signal' }],
        run: () => ({ signals: ['fire'] })
      },
      {
        type: 'probe',
        title: 'probe',
        inputs: [
          { name: 'a', type: 'Text' },
          { name: 'b', type: 'Text' },
          { name: 'opt', type: 'Signal' }
        ],
        outputs: [{ name: 'out', type: 'Text' }],
        run: (_c, _i, node) => {
          seen.push(node)
          return { outputs: { out: 'ok' } }
        }
      },
      {
        type: 'sink',
        title: 'sink',
        inputs: [{ name: 'in', type: 'Text' }],
        outputs: [],
        isMainOutputCapable: true,
        run: () => ({})
      }
    ]
    const reg = createRegistry(impls)
    // probe: `a` wired live, `opt` wired via a live Signal edge, `b` left unwired.
    const d = doc(
      [
        { id: 's', type: 'src' },
        { id: 'g', type: 'firingGate' },
        { id: 'p', type: 'probe' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 's', port: 'out' }, to: { node: 'p', port: 'a' } },
        { from: { node: 'g', port: 'fire' }, to: { node: 'p', port: 'opt' } },
        { from: { node: 'p', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    await runWorkflow(d, reg, ctx())
    expect(seen).toHaveLength(1)
    expect([...seen[0].wiredInputs!].sort()).toEqual(['a', 'opt'])
    expect(seen[0].wiredInputs).not.toContain('b')
  })

  it('a dead (upstream-killed) data edge still counts as wired', async () => {
    const seen: NodeMeta[] = []
    const impls: NodeImpl[] = [
      {
        type: 'src',
        title: 'src',
        inputs: [],
        outputs: [{ name: 'out', type: 'Text' }],
        run: () => ({ outputs: { out: 'data' } })
      },
      {
        // A gate that does NOT fire — the branch node behind it is pruned, so its output edge
        // into probe.b is dead. probe.b is still WIRED.
        type: 'quietGate',
        title: 'quietGate',
        inputs: [],
        outputs: [{ name: 'fire', type: 'Signal' }],
        run: () => ({ signals: [] })
      },
      {
        type: 'branch',
        title: 'branch',
        inputs: [{ name: 'when', type: 'Signal' }],
        outputs: [{ name: 'out', type: 'Text' }],
        run: () => ({ outputs: { out: 'branch-data' } })
      },
      {
        type: 'probe',
        title: 'probe',
        inputs: [
          { name: 'a', type: 'Text' },
          { name: 'b', type: 'Text' }
        ],
        outputs: [{ name: 'out', type: 'Text' }],
        run: (_c, inputs, node) => {
          seen.push(node)
          // The dead edge contributes NO input key — only the wiredInputs name.
          expect(Object.prototype.hasOwnProperty.call(inputs, 'b')).toBe(false)
          return { outputs: { out: 'ok' } }
        }
      },
      {
        type: 'sink',
        title: 'sink',
        inputs: [{ name: 'in', type: 'Text' }],
        outputs: [],
        isMainOutputCapable: true,
        run: () => ({})
      }
    ]
    const reg = createRegistry(impls)
    const d = doc(
      [
        { id: 's', type: 'src' },
        { id: 'g', type: 'quietGate' },
        { id: 'br', type: 'branch' },
        { id: 'p', type: 'probe' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'g', port: 'fire' }, to: { node: 'br', port: 'when' } },
        { from: { node: 's', port: 'out' }, to: { node: 'p', port: 'a' } },
        { from: { node: 'br', port: 'out' }, to: { node: 'p', port: 'b' } },
        { from: { node: 'p', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'br')?.status).toBe('skipped')
    expect(seen).toHaveLength(1)
    expect([...seen[0].wiredInputs!].sort()).toEqual(['a', 'b'])
  })

  it('legacy node spot check: control.if through the engine is unaffected by wiredInputs', async () => {
    // Characterization: control.if predates wiredInputs and ignores it — same then/else firing.
    const collect: string[] = []
    const impls: NodeImpl[] = [
      controlIf,
      {
        type: 'src',
        title: 'src',
        inputs: [],
        outputs: [{ name: 'out', type: 'Text' }],
        run: () => ({ outputs: { out: 'hello' } })
      },
      {
        type: 'listener',
        title: 'listener',
        inputs: [{ name: 'when', type: 'Signal' }],
        outputs: [],
        isMainOutputCapable: true,
        run: (_c, _i, node) => {
          collect.push(node.id)
          return {}
        }
      }
    ]
    const reg = createRegistry(impls)
    const d = doc(
      [
        { id: 's', type: 'src' },
        { id: 'if', type: 'control.if', config: { op: 'eq', value: 'hello' } },
        { id: 'yes', type: 'listener', isMainOutput: true },
        { id: 'no', type: 'listener' }
      ],
      [
        { from: { node: 's', port: 'out' }, to: { node: 'if', port: 'value' } },
        { from: { node: 'if', port: 'then' }, to: { node: 'yes', port: 'when' } },
        { from: { node: 'if', port: 'else' }, to: { node: 'no', port: 'when' } }
      ]
    )
    const res = await runWorkflow(d, reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'if')?.status).toBe('ran')
    expect(collect).toEqual(['yes'])
    expect(res.traces.find((t) => t.nodeId === 'no')?.status).toBe('skipped')
  })
})
