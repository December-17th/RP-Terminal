import { describe, it, expect, vi, beforeEach } from 'vitest'

// control.mode (agent-memory-ux WP-B; spec §3.1; plan §0.2 — the AUTHORITATIVE firing rule).
// Unit tests drive run() directly with an engine-shaped NodeMeta (config parsed through the
// configSchema, wiredInputs as the engine supplies it); the engine suite then pins the gating
// interplay (a mode node with wired-but-unfired slots is gatedOff before run()).

const mockLog = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../../src/main/services/logService', () => mockLog)

import { controlMode } from '../../src/main/services/nodes/builtin/controlNodes'
import { runWorkflow } from '../../src/main/services/workflowEngine'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl, RunContext } from '../../src/main/services/nodes/types'
import { WorkflowDoc, NodeInstance, Edge } from '../../src/shared/workflow/types'

beforeEach(() => {
  mockLog.log.mockReset()
})

const ctx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

/** Engine-shaped NodeMeta: config parsed through the impl's schema + wiredInputs. */
const meta = (rawConfig: Record<string, unknown>, wiredInputs: string[]) => ({
  id: 'm1',
  config: controlMode.configSchema!.parse(rawConfig) as Record<string, unknown>,
  wiredInputs
})

const threeModes = {
  options: [
    { key: 'every_turn', label: 'Every turn' },
    { key: 'async', label: 'Async backlog' },
    { key: 'off' } // label optional — key-only options are the WP-C shape
  ],
  selected: 'every_turn'
}

describe('control.mode — descriptor', () => {
  it('declares when1..when4 Signal inputs and fired/selected outputs', () => {
    expect(controlMode.inputs).toEqual([
      { name: 'when1', type: 'Signal' },
      { name: 'when2', type: 'Signal' },
      { name: 'when3', type: 'Signal' },
      { name: 'when4', type: 'Signal' }
    ])
    expect(controlMode.outputs).toEqual([
      { name: 'fired', type: 'Signal' },
      { name: 'selected', type: 'Text' }
    ])
  })

  it('stamps the WP-A dynamicEnum hint (selected ⇐ options[].key)', () => {
    expect(controlMode.dynamicEnum).toEqual({
      path: 'selected',
      optionsPath: 'options',
      keyField: 'key',
      labelField: 'label'
    })
  })

  it('config bounds: 1..4 options, nonempty keys/selected; label optional (slot bounds)', () => {
    const schema = controlMode.configSchema!
    // 4 options OK; 5 rejected; 0 rejected.
    const opt = (k: string) => ({ key: k })
    expect(() =>
      schema.parse({ options: [opt('a'), opt('b'), opt('c'), opt('d')], selected: 'a' })
    ).not.toThrow()
    expect(() =>
      schema.parse({ options: [opt('a'), opt('b'), opt('c'), opt('d'), opt('e')], selected: 'a' })
    ).toThrow()
    expect(() => schema.parse({ options: [], selected: 'a' })).toThrow()
    expect(() => schema.parse({ options: [{ key: '' }], selected: 'a' })).toThrow()
    expect(() => schema.parse({ options: [opt('a')], selected: '' })).toThrow()
  })
})

describe('control.mode — firing rule (plan §0.2)', () => {
  it('selected-slot passthrough: selected slot wired AND fired ⇒ fires', async () => {
    // Engine live-edge detection = key presence (a Signal carries undefined but creates the key).
    const r = await controlMode.run(
      ctx(),
      { when1: undefined },
      meta(threeModes, ['when1', 'when2'])
    )
    expect(r.signals).toEqual(['fired'])
    expect(r.outputs).toEqual({ selected: 'every_turn' })
  })

  it('non-selected fired slot ⇒ fired dead but the node runs (selected Text still emitted)', async () => {
    const r = await controlMode.run(
      ctx(),
      { when2: undefined }, // async's slot fired; selected = every_turn (when1)
      meta(threeModes, ['when1', 'when2'])
    )
    expect(r.signals).toEqual([])
    expect(r.outputs).toEqual({ selected: 'every_turn' })
  })

  it('selected slot wired but unfired ⇒ dead', async () => {
    // when1 wired but its edge was dead this run (key absent); when2 fired.
    const r = await controlMode.run(ctx(), { when2: undefined }, meta(threeModes, ['when1', 'when2']))
    expect(r.signals).toEqual([])
  })

  it('zero whens wired ⇒ fires unconditionally (the standalone config-driven gate)', async () => {
    const r = await controlMode.run(ctx(), {}, meta(threeModes, []))
    expect(r.signals).toEqual(['fired'])
    expect(r.outputs).toEqual({ selected: 'every_turn' })
  })

  it('unwired selected + a different wired slot fired ⇒ dead (the `off` master-switch case)', async () => {
    // `off` maps to when3, which nobody wires — a firing backlog trigger on when2 must NOT un-gate
    // the chain. This is the §0.2 refinement over the spec's literal "unwired ⇒ unconditional".
    const cfg = { ...threeModes, selected: 'off' }
    const r = await controlMode.run(ctx(), { when2: undefined }, meta(cfg, ['when1', 'when2']))
    expect(r.signals).toEqual([])
    expect(r.outputs).toEqual({ selected: 'off' })
  })

  it('missing wiredInputs (legacy direct caller) is treated as zero wired — fail-soft fires', async () => {
    const r = await controlMode.run(ctx(), {}, {
      id: 'm1',
      config: controlMode.configSchema!.parse(threeModes) as Record<string, unknown>
    })
    expect(r.signals).toEqual(['fired'])
  })

  it('selected key not in options ⇒ fail-soft to the first option, logged; firing uses the fallback slot', async () => {
    const cfg = { ...threeModes, selected: 'bogus' }
    const r = await controlMode.run(ctx(), { when1: undefined }, meta(cfg, ['when1', 'when2']))
    // Fallback = options[0] = every_turn (when1, which fired) ⇒ fires; Text carries the fallback.
    expect(r.signals).toEqual(['fired'])
    expect(r.outputs).toEqual({ selected: 'every_turn' })
    expect(mockLog.log).toHaveBeenCalledOnce()
    expect(String(mockLog.log.mock.calls[0][1])).toContain('bogus')
  })
})

// ── engine interplay ──────────────────────────────────────────────────────────────────────────────

const doc = (nodes: NodeInstance[], edges: Edge[]): WorkflowDoc => ({
  id: 'w',
  name: 'w',
  version: 1,
  schemaVersion: 1,
  nodes,
  edges
})

// `gate` stands in for a trigger's fired output; `job` is the downstream chain head; `src`/`sink`
// keep a live main-output path so the run completes regardless of the mode branch.
const impls: NodeImpl[] = [
  controlMode,
  {
    type: 'gate',
    title: 'gate',
    inputs: [],
    outputs: [{ name: 'fire', type: 'Signal' }],
    run: (_c, _i, node) => ({ signals: node.config.fire ? ['fire'] : [] })
  },
  {
    type: 'job',
    title: 'job',
    inputs: [{ name: 'when', type: 'Signal' }],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'ran' } })
  },
  {
    type: 'src',
    title: 'src',
    inputs: [],
    outputs: [{ name: 'out', type: 'Text' }],
    run: () => ({ outputs: { out: 'data' } })
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

/** g1→when1, g2→when2 (when3 deliberately unwired = the `off` slot), m.fired→job.when. */
const modeGraph = (selected: string, g1Fires: boolean, g2Fires: boolean): WorkflowDoc =>
  doc(
    [
      { id: 'g1', type: 'gate', config: { fire: g1Fires } },
      { id: 'g2', type: 'gate', config: { fire: g2Fires } },
      { id: 'm', type: 'control.mode', config: { ...threeModes, selected } },
      { id: 'j', type: 'job' },
      { id: 's', type: 'src' },
      { id: 'k', type: 'sink', isMainOutput: true }
    ],
    [
      { from: { node: 'g1', port: 'fire' }, to: { node: 'm', port: 'when1' } },
      { from: { node: 'g2', port: 'fire' }, to: { node: 'm', port: 'when2' } },
      { from: { node: 'm', port: 'fired' }, to: { node: 'j', port: 'when' } },
      { from: { node: 's', port: 'out' }, to: { node: 'k', port: 'in' } }
    ]
  )

describe('control.mode — engine interplay', () => {
  it('selected slot fires ⇒ node runs, downstream job runs, selected Text emitted', async () => {
    const res = await runWorkflow(modeGraph('every_turn', true, false), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('ran')
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('ran')
    expect(res.outputs.get('m')).toEqual({ selected: 'every_turn' })
  })

  it('non-selected slot fires ⇒ node runs but downstream job is pruned', async () => {
    const res = await runWorkflow(modeGraph('every_turn', false, true), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('ran')
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('skipped')
    // selected Text is still data on a live edge (emitted even though fired is dead).
    expect(res.outputs.get('m')).toEqual({ selected: 'every_turn' })
  })

  it('`off` selected (unwired slot) + backlog slot fires ⇒ downstream pruned (master off-switch)', async () => {
    const res = await runWorkflow(modeGraph('off', false, true), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('ran')
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('skipped')
    expect(res.outputs.get('m')).toEqual({ selected: 'off' })
  })

  it('no slot fires ⇒ the engine gates the node off entirely (turn-run pruning, plan §0.2)', async () => {
    const res = await runWorkflow(modeGraph('every_turn', false, false), reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('skipped')
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('skipped')
  })

  it('zero when edges in the doc ⇒ standalone gate: runs and fires', async () => {
    const standalone = doc(
      [
        { id: 'm', type: 'control.mode', config: threeModes },
        { id: 'j', type: 'job' },
        { id: 's', type: 'src' },
        { id: 'k', type: 'sink', isMainOutput: true }
      ],
      [
        { from: { node: 'm', port: 'fired' }, to: { node: 'j', port: 'when' } },
        { from: { node: 's', port: 'out' }, to: { node: 'k', port: 'in' } }
      ]
    )
    const res = await runWorkflow(standalone, reg, ctx())
    expect(res.traces.find((t) => t.nodeId === 'm')?.status).toBe('ran')
    expect(res.traces.find((t) => t.nodeId === 'j')?.status).toBe('ran')
  })
})
