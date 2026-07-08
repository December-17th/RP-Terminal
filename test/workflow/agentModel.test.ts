import { describe, it, expect } from 'vitest'
import {
  agentEnabledState,
  agentStatusSentence,
  agentTriggers,
  downstreamClosure,
  isAgentGroup,
  isTriggerType,
  modeGatedTriggerIds,
  newestRunForGroup,
  promptExcerpt,
  promptTextOfNode,
  relativeAgo,
  ungroupedTriggerChains
} from '../../src/renderer/src/components/workflow/agentModel'
import type {
  EditorNode,
  EditorEdge,
  EditorNodeType
} from '../../src/renderer/src/components/workflow/editorModel'
import type { GroupDecl } from '../../src/shared/workflow/types'
import type { StoredRunRecord } from '../../src/shared/workflow/trace'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const node = (id: string, type: string, extra: Partial<EditorNode> = {}): EditorNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  ...extra
})
const edge = (source: string, target: string, sourcePort = 'out', targetPort = 'in'): EditorEdge => ({
  id: `${source}:${sourcePort}->${target}:${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort
})
const nt = (type: string, extra: Partial<EditorNodeType> = {}): EditorNodeType => ({
  type,
  title: type,
  inputs: [],
  outputs: [],
  ...extra
})
// Catalog: cadence/state are triggers; agent.llm/text.template carry prompts.
const types = new Map<string, EditorNodeType>([
  ['trigger.cadence', nt('trigger.cadence', { isTrigger: true })],
  ['trigger.state', nt('trigger.state', { isTrigger: true })],
  ['control.mode', nt('control.mode')],
  ['history.recent', nt('history.recent')],
  ['agent.llm', nt('agent.llm', { promptFields: ['messages'] })],
  ['text.template', nt('text.template', { promptFields: ['template'] })],
  ['parse.extract', nt('parse.extract')],
  ['table.apply', nt('table.apply')],
  ['input.context', nt('input.context')],
  ['prompt.assemble', nt('prompt.assemble')],
  ['output.writeFloor', nt('output.writeFloor')]
])
const group = (nodeIds: string[]): GroupDecl => ({ id: 'g1', name: 'Agent', nodeIds })

describe('isTriggerType', () => {
  it('uses the catalog isTrigger hint', () => {
    expect(isTriggerType('trigger.cadence', types)).toBe(true)
    expect(isTriggerType('agent.llm', types)).toBe(false)
  })
  it('falls back to the trigger.* prefix for an absent catalog entry', () => {
    expect(isTriggerType('trigger.unknown', new Map())).toBe(true)
    expect(isTriggerType('other.node', new Map())).toBe(false)
  })
})

describe('isAgentGroup / agentTriggers', () => {
  const nodes = [node('t', 'trigger.cadence'), node('h', 'history.recent'), node('llm', 'agent.llm')]
  it('is an agent when a member is a trigger', () => {
    expect(isAgentGroup(nodes, group(['t', 'h', 'llm']), types)).toBe(true)
    expect(agentTriggers(nodes, group(['t', 'h', 'llm']), types).map((n) => n.id)).toEqual(['t'])
  })
  it('is not an agent without a member trigger', () => {
    expect(isAgentGroup(nodes, group(['h', 'llm']), types)).toBe(false)
  })
})

describe('agentEnabledState', () => {
  const base = [node('h', 'history.recent')]
  it('on when every trigger is enabled', () => {
    const nodes = [...base, node('t1', 'trigger.cadence'), node('t2', 'trigger.state')]
    expect(agentEnabledState(nodes, group(['t1', 't2', 'h']), types)).toBe('on')
  })
  it('off when every trigger is disabled', () => {
    const nodes = [
      ...base,
      node('t1', 'trigger.cadence', { disabled: true }),
      node('t2', 'trigger.state', { disabled: true })
    ]
    expect(agentEnabledState(nodes, group(['t1', 't2', 'h']), types)).toBe('off')
  })
  it('mixed when some are disabled', () => {
    const nodes = [
      ...base,
      node('t1', 'trigger.cadence'),
      node('t2', 'trigger.state', { disabled: true })
    ]
    expect(agentEnabledState(nodes, group(['t1', 't2', 'h']), types)).toBe('mixed')
  })
})

describe('downstreamClosure', () => {
  // Narrator spine: input.context → assemble → output(main). Headless agent: trigger → mode → llm →
  // parse → apply (apply is a DB side-effect leaf — the WP-C headless chain does NOT edge into out).
  const nodes = [
    node('ctx', 'input.context'),
    node('asm', 'prompt.assemble'),
    node('out', 'output.writeFloor', { isMainOutput: true }),
    node('trig', 'trigger.cadence'),
    node('mode', 'control.mode'),
    node('llm', 'agent.llm'),
    node('parse', 'parse.extract'),
    node('apply', 'table.apply'),
    node('trig2', 'trigger.state')
  ]
  const edges = [
    edge('ctx', 'asm'),
    edge('asm', 'out'),
    edge('trig', 'mode'),
    edge('trig2', 'mode'),
    edge('mode', 'llm'),
    edge('llm', 'parse'),
    edge('parse', 'apply')
  ]
  it('walks the whole downstream chain (headless side-effect leaf included)', () => {
    const closure = downstreamClosure(nodes, edges, 'trig', types)
    expect(closure.has('trig')).toBe(true)
    expect(closure.has('mode')).toBe(true)
    expect(closure.has('llm')).toBe(true)
    expect(closure.has('parse')).toBe(true)
    expect(closure.has('apply')).toBe(true)
    // The narrator spine is upstream / unrelated — never reached by the forward walk.
    expect(closure.has('out')).toBe(false)
    expect(closure.has('asm')).toBe(false)
    expect(closure.has('ctx')).toBe(false)
  })
  it('absorbs a sibling trigger whose every out-edge lands in the closure', () => {
    const closure = downstreamClosure(nodes, edges, 'trig', types)
    expect(closure.has('trig2')).toBe(true)
  })
  it('excludes a downstream node that is also a main-output ancestor (narrator splice stays out)', () => {
    // trig → shared → out(main): `shared` feeds the reply-producing spine, so it (and out) stay out.
    const spliceNodes = [
      node('trig', 'trigger.cadence'),
      node('shared', 'prompt.assemble'),
      node('out', 'output.writeFloor', { isMainOutput: true })
    ]
    const spliceEdges = [edge('trig', 'shared'), edge('shared', 'out')]
    const closure = downstreamClosure(spliceNodes, spliceEdges, 'trig', types)
    expect(closure.has('trig')).toBe(true)
    expect(closure.has('shared')).toBe(false)
    expect(closure.has('out')).toBe(false)
  })
})

describe('ungroupedTriggerChains', () => {
  const nodes = [
    node('trig', 'trigger.cadence'),
    node('mode', 'control.mode'),
    node('llm', 'agent.llm'),
    node('trig2', 'trigger.state')
  ]
  const edges = [edge('trig', 'mode'), edge('trig2', 'mode'), edge('mode', 'llm')]
  it('emits one deduped closure per ungrouped chain with ≥2 members', () => {
    const chains = ungroupedTriggerChains(nodes, edges, [], types)
    expect(chains).toHaveLength(1)
    expect(chains[0].has('trig')).toBe(true)
    expect(chains[0].has('trig2')).toBe(true)
    expect(chains[0].has('mode')).toBe(true)
    expect(chains[0].has('llm')).toBe(true)
  })
  it('skips already-grouped members', () => {
    const chains = ungroupedTriggerChains(nodes, edges, [group(['trig', 'mode', 'llm', 'trig2'])], types)
    expect(chains).toHaveLength(0)
  })
})

describe('relativeAgo', () => {
  const now = 10_000_000_000
  it('buckets by minute/hour/day', () => {
    expect(relativeAgo(now, now)).toEqual({ key: 'workflowEditor.agent.ago.justNow' })
    expect(relativeAgo(now - 5 * 60_000, now)).toEqual({
      key: 'workflowEditor.agent.ago.minutes',
      params: { n: 5 }
    })
    expect(relativeAgo(now - 3 * 3_600_000, now)).toEqual({
      key: 'workflowEditor.agent.ago.hours',
      params: { n: 3 }
    })
    expect(relativeAgo(now - 2 * 86_400_000, now)).toEqual({
      key: 'workflowEditor.agent.ago.days',
      params: { n: 2 }
    })
  })
})

describe('agentStatusSentence', () => {
  const now = 10_000_000_000
  it('off → the off pattern (no recency)', () => {
    const s = agentStatusSentence({ descriptions: ['every 3 floors'], state: 'off', now })
    expect(s.key).toBe('workflowEditor.agent.sentence.off')
    expect(s.desc).toBe('every 3 floors')
    expect(s.ago).toBeUndefined()
  })
  it('mixed → the mixed pattern', () => {
    const s = agentStatusSentence({ descriptions: ['a', 'b'], state: 'mixed', now })
    expect(s.key).toBe('workflowEditor.agent.sentence.mixed')
    expect(s.desc).toBe('a | b')
  })
  it('on + a run → onRan with recency', () => {
    const s = agentStatusSentence({
      descriptions: ['every 3 floors'],
      state: 'on',
      lastRunAt: now - 60_000,
      now
    })
    expect(s.key).toBe('workflowEditor.agent.sentence.onRan')
    expect(s.ago).toEqual({ key: 'workflowEditor.agent.ago.minutes', params: { n: 1 } })
  })
  it('on + never run → onNever', () => {
    const s = agentStatusSentence({ descriptions: ['x'], state: 'on', now })
    expect(s.key).toBe('workflowEditor.agent.sentence.onNever')
    expect(s.ago).toBeUndefined()
  })
  it('on + everything mode-gated → the mode-gated pattern (beats recency; distinct from user-off)', () => {
    const s = agentStatusSentence({
      descriptions: ['every 3 floors', 'state: table summary.unprocessed gte 6'],
      state: 'on',
      allModeGated: true,
      lastRunAt: now - 60_000,
      now
    })
    expect(s.key).toBe('workflowEditor.agent.sentence.modeGated')
    expect(s.desc).toBe('every 3 floors | state: table summary.unprocessed gte 6')
    expect(s.ago).toBeUndefined()
    // user-off keeps its own key — the two states must never read the same.
    expect(
      agentStatusSentence({ descriptions: ['x'], state: 'off', allModeGated: true, now }).key
    ).toBe('workflowEditor.agent.sentence.off')
  })
})

// ── mode gating (owner manual-pass fix: mode changes must be visible on the graph) ────────────────
describe('modeGatedTriggerIds', () => {
  // The seeded-doc shape: cadence → when1, backlog → when2; options every_turn/async/off; 'off' has
  // no wired slot. A third trigger keeps a NON-mode downstream edge (escapes gating).
  const modeNode = (selected: string): EditorNode =>
    node('mode', 'control.mode', {
      config: {
        options: [{ key: 'every_turn' }, { key: 'async' }, { key: 'off' }],
        selected
      }
    })
  const base = (selected: string): { nodes: EditorNode[]; edges: EditorEdge[] } => ({
    nodes: [
      node('cad', 'trigger.cadence'),
      node('bak', 'trigger.state'),
      node('esc', 'trigger.cadence'),
      modeNode(selected),
      node('log', 'history.recent')
    ],
    edges: [
      edge('cad', 'mode', 'fired', 'when1'),
      edge('bak', 'mode', 'fired', 'when2'),
      // 'esc' feeds the mode AND a non-mode node — any escaping edge means NOT gated.
      edge('esc', 'mode', 'fired', 'when2'),
      edge('esc', 'log', 'fired', 'when')
    ]
  })

  it('gates triggers wired only to non-selected slots; the selected slot is not gated', () => {
    const { nodes: ns, edges: es } = base('every_turn')
    const gated = modeGatedTriggerIds(ns, es, types)
    expect(gated.has('cad')).toBe(false) // when1 = every_turn = selected
    expect(gated.has('bak')).toBe(true) // when2 = async ≠ selected
  })

  it("mode 'off' (a selected key with no wired slot) gates every when-wired trigger", () => {
    const { nodes: ns, edges: es } = base('off')
    const gated = modeGatedTriggerIds(ns, es, types)
    expect(gated.has('cad')).toBe(true)
    expect(gated.has('bak')).toBe(true)
  })

  it('a trigger with a non-mode downstream edge is NOT gated (an edge escapes)', () => {
    const { nodes: ns, edges: es } = base('off')
    expect(modeGatedTriggerIds(ns, es, types).has('esc')).toBe(false)
  })

  it('an edgeless trigger is not gated; gating is independent of disabled', () => {
    const ns = [node('lone', 'trigger.cadence', { disabled: true }), modeNode('off')]
    expect(modeGatedTriggerIds(ns, [], types).size).toBe(0)
    // disabled does not exempt a wired trigger from gating (the two states are orthogonal).
    const { nodes: base2, edges: es } = base('off')
    const withDisabled = base2.map((n) => (n.id === 'cad' ? { ...n, disabled: true } : n))
    expect(modeGatedTriggerIds(withDisabled, es, types).has('cad')).toBe(true)
  })

  it('fail-soft: a malformed mode config (no options) never gates', () => {
    const ns = [
      node('cad', 'trigger.cadence'),
      node('mode', 'control.mode', { config: { selected: 'x' } })
    ]
    const es = [edge('cad', 'mode', 'fired', 'when1')]
    expect(modeGatedTriggerIds(ns, es, types).size).toBe(0)
  })

  it('an unknown selected key fail-softs to options[0], mirroring the node run()', () => {
    const ns = [
      node('cad', 'trigger.cadence'),
      node('bak', 'trigger.state'),
      node('mode', 'control.mode', {
        config: { options: [{ key: 'a' }, { key: 'b' }], selected: 'ghost' }
      })
    ]
    const es = [edge('cad', 'mode', 'fired', 'when1'), edge('bak', 'mode', 'fired', 'when2')]
    const gated = modeGatedTriggerIds(ns, es, types)
    expect(gated.has('cad')).toBe(false) // slot 'a' = effective selection (fallback)
    expect(gated.has('bak')).toBe(true)
  })
})

describe('promptTextOfNode / promptExcerpt', () => {
  it('reads a string prompt field', () => {
    const n = node('tpl', 'text.template', { config: { template: '  Hello world  ' } })
    expect(promptTextOfNode(n, types)).toBe('Hello world')
  })
  it('reads the first SYSTEM row of a role-message array', () => {
    const n = node('llm', 'agent.llm', {
      config: { messages: [{ role: 'user', content: 'u' }, { role: 'system', content: 'sys prompt' }] }
    })
    expect(promptTextOfNode(n, types)).toBe('sys prompt')
  })
  it('falls back to the first row when no system row exists', () => {
    const n = node('llm', 'agent.llm', {
      config: { messages: [{ role: 'user', content: 'first' }] }
    })
    expect(promptTextOfNode(n, types)).toBe('first')
  })
  it('returns null for a non-prompt node', () => {
    expect(promptTextOfNode(node('h', 'history.recent'), types)).toBeNull()
  })
  it('excerpt picks the first prompt-bearing member in nodeIds order', () => {
    const nodes = [
      node('h', 'history.recent'),
      node('llm', 'agent.llm', { config: { messages: [{ role: 'system', content: 'the prompt' }] } })
    ]
    expect(promptExcerpt(nodes, group(['h', 'llm']), types)).toBe('the prompt')
  })
})

describe('newestRunForGroup', () => {
  const run = (id: string, startedAt: number, triggerNodeIds?: string[]): StoredRunRecord =>
    ({
      runId: id,
      origin: 'headless',
      packIds: [],
      ...(triggerNodeIds ? { triggerNodeIds } : {}),
      trace: { startedAt, ok: true }
    }) as unknown as StoredRunRecord
  it('picks the newest run whose triggerNodeIds intersect membership', () => {
    const records = [
      run('r1', 100, ['trig']),
      run('r2', 300, ['trig']),
      run('r3', 500, ['other'])
    ]
    const newest = newestRunForGroup(records, new Set(['trig', 'llm']))
    expect(newest?.runId).toBe('r2')
  })
  it('ignores records without triggerNodeIds (pre-WP-D, fail-soft)', () => {
    const records = [run('r1', 100), run('r2', 200, ['trig'])]
    expect(newestRunForGroup(records, new Set(['trig']))?.runId).toBe('r2')
    expect(newestRunForGroup(records, new Set(['nope']))).toBeNull()
  })
})
