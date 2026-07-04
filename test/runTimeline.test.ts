import { describe, it, expect } from 'vitest'
import {
  isHeadlessSeedNode,
  unprefixNode,
  detailGroups,
  runFacts,
  outcomeSentence,
  packsWithRuns,
  filterRuns,
  nextBeforeSeq,
  HEADLESS_SEED_PREFIX,
  TABLE_WRITE_TYPE,
  FLOOR_WRITE_TYPE,
  LLM_CALL_TYPE
} from '../src/renderer/src/components/workspace/runTimeline'
import { translate } from '../src/renderer/src/i18n'
import type { StoredRunRecord, TraceNode, WorkflowRunTrace } from '../src/shared/workflow/trace'

// Pins the pure Runs-timeline derivations the Agents view renders (agent-packs plan WP3.3). The
// codebase has no jsdom renderer harness (vitest runs under Node), so per WP convention the display
// LOGIC is extracted into runTimeline.ts and covered here; the view adds only labels + DOM.

const node = (
  nodeId: string,
  nodeType: string,
  status: TraceNode['status'],
  extra: Partial<TraceNode> = {}
): TraceNode => ({ nodeId, nodeType, status, phase: 'post', ...extra })

const trace = (nodes: TraceNode[], over: Partial<WorkflowRunTrace> = {}): WorkflowRunTrace => ({
  chatId: 'c1',
  workflowId: 'w1',
  startedAt: 0,
  durationMs: 1200,
  ok: true,
  aborted: false,
  nodes,
  ...over
})

const record = (over: Partial<StoredRunRecord>): StoredRunRecord => ({
  runId: 'r1',
  seq: 1,
  origin: 'turn',
  packIds: [],
  trace: trace([]),
  ...over
})

// Render an OutcomeSentence the way the view does: resolve failedNodeType to a localized title, pass
// it as `node`, then translate. Verifies the pure key/vars actually produce a sensible sentence.
const renderOutcome = (
  locale: string,
  facts: ReturnType<typeof runFacts>
): string => {
  const s = outcomeSentence(facts)
  const vars = { ...s.vars }
  if (s.failedNodeType) {
    vars.node =
      translate(locale, `workflowEditor.nodeTitle.${s.failedNodeType}`) === `workflowEditor.nodeTitle.${s.failedNodeType}`
        ? s.failedNodeType
        : translate(locale, `workflowEditor.nodeTitle.${s.failedNodeType}`)
  }
  return translate(locale, s.key, vars)
}

describe('isHeadlessSeedNode / unprefixNode', () => {
  it('flags the synthetic headless-seed nodes', () => {
    expect(isHeadlessSeedNode({ nodeId: `${HEADLESS_SEED_PREFIX}ctx` })).toBe(true)
    expect(isHeadlessSeedNode({ nodeId: 'pack:mem:read' })).toBe(false)
  })

  it('splits a pack-prefixed id into packId + un-prefixed nodeId; narrator ids return null', () => {
    expect(unprefixNode('pack:builtin.async-memory:tableapply')).toEqual({
      packId: 'builtin.async-memory',
      nodeId: 'tableapply'
    })
    expect(unprefixNode('llm')).toBeNull()
    // Node id that itself contains colons: only the FIRST colon after the prefix delimits the packId.
    expect(unprefixNode('pack:p1:a:b')).toEqual({ packId: 'p1', nodeId: 'a:b' })
  })
})

describe('detailGroups', () => {
  it('drops seed nodes, un-prefixes pack ids, and buckets narrator + per-pack in first-appearance order', () => {
    const t = trace([
      node(`${HEADLESS_SEED_PREFIX}ctx`, 'subgraph.input', 'ran'),
      node('narrate', 'llm.sample', 'ran', { ms: 900 }),
      node('pack:mem:read', 'table.read', 'ran', { ms: 20 }),
      node('pack:mem:apply', 'table.apply', 'failed', { error: { message: 'bad sql' } }),
      node('pack:plot:think', 'llm.sample', 'ran')
    ])
    const groups = detailGroups(t)
    expect(groups.map((g) => g.packId)).toEqual([null, 'mem', 'plot'])
    // seed node gone
    expect(groups.flatMap((g) => g.nodes.map((n) => n.nodeId))).not.toContain(`${HEADLESS_SEED_PREFIX}ctx`)
    // narrator group holds the raw id; pack groups hold the un-prefixed id
    expect(groups[0].nodes[0].nodeId).toBe('narrate')
    expect(groups[1].nodes.map((n) => n.nodeId)).toEqual(['read', 'apply'])
    expect(groups[1].nodes[1].error?.message).toBe('bad sql')
    expect(groups[1].nodes[0].ms).toBe(20)
  })
})

describe('runFacts', () => {
  it('tallies ran/failed/skipped and the concrete effects, ignoring seed nodes', () => {
    const t = trace([
      node(`${HEADLESS_SEED_PREFIX}ctx`, 'subgraph.input', 'ran'), // ignored
      node('a', LLM_CALL_TYPE, 'ran'),
      node('b', TABLE_WRITE_TYPE, 'ran'),
      node('c', TABLE_WRITE_TYPE, 'ran'),
      node('d', FLOOR_WRITE_TYPE, 'ran'),
      node('e', 'control.if', 'skipped')
    ])
    const f = runFacts(t)
    expect(f).toMatchObject({
      ran: 4,
      failed: 0,
      skipped: 1,
      tableWrites: 2,
      floorWrites: 1,
      llmCalls: 1,
      runFailed: false,
      branchFailedInOkRun: false
    })
  })

  it('marks branchFailedInOkRun when the run is ok but a node failed, naming the first failed type', () => {
    const t = trace(
      [
        node('a', LLM_CALL_TYPE, 'ran'),
        node('pack:plot:think', 'llm.sample', 'failed', { error: { message: 'timeout' } })
      ],
      { ok: true }
    )
    const f = runFacts(t)
    expect(f.branchFailedInOkRun).toBe(true)
    expect(f.runFailed).toBe(false)
    expect(f.failedNodeType).toBe('llm.sample')
  })

  it('marks runFailed from trace.ok === false', () => {
    const t = trace([node('a', 'table.apply', 'failed', { error: { message: 'bad sql' } })], {
      ok: false
    })
    const f = runFacts(t)
    expect(f.runFailed).toBe(true)
    expect(f.failedNodeType).toBe('table.apply')
  })
})

describe('outcomeSentence — priority + interpolation', () => {
  it('failed run names the failed node (en + zh)', () => {
    const f = runFacts(
      trace([node('a', 'table.apply', 'failed', { error: { message: 'x' } })], { ok: false })
    )
    const s = outcomeSentence(f)
    expect(s.key).toBe('runs.outcome.failed')
    expect(s.failedNodeType).toBe('table.apply')
    expect(renderOutcome('en', f)).toBe('Failed at Apply Table SQL.')
    expect(renderOutcome('zh', f)).toBe('在「应用表格 SQL」处失败。')
  })

  it('failed-branch-inside-ok-turn → "the reply was not affected" (en + zh)', () => {
    const f = runFacts(
      trace(
        [
          node('narrate', 'llm.sample', 'ran'),
          node('pack:plot:think', 'llm.sample', 'failed', { error: { message: 'timeout' } })
        ],
        { ok: true }
      )
    )
    const s = outcomeSentence(f)
    expect(s.key).toBe('runs.outcome.branchFailed')
    expect(renderOutcome('en', f)).toBe('Sample Model failed — the reply was not affected.')
    expect(renderOutcome('zh', f)).toBe('「模型调用」失败——未影响回复。')
  })

  it('table write is the headline effect (en + zh)', () => {
    const f = runFacts(
      trace([node('a', TABLE_WRITE_TYPE, 'ran'), node('b', TABLE_WRITE_TYPE, 'ran')])
    )
    const s = outcomeSentence(f)
    expect(s).toEqual({ key: 'runs.outcome.updatedTables', vars: { n: 2 } })
    expect(renderOutcome('en', f)).toBe('Updated 2 table(s).')
    expect(renderOutcome('zh', f)).toBe('更新了 2 张表。')
  })

  it('a second effect folds into the "…More" key (table headline + llm second)', () => {
    const f = runFacts(
      trace([node('a', TABLE_WRITE_TYPE, 'ran'), node('b', LLM_CALL_TYPE, 'ran')])
    )
    const s = outcomeSentence(f)
    expect(s.key).toBe('runs.outcome.updatedTablesMore')
    expect(renderOutcome('en', f)).toBe('Updated 1 table(s), and did more.')
  })

  it('llm-only call reports the model call count', () => {
    const f = runFacts(trace([node('a', LLM_CALL_TYPE, 'ran')]))
    expect(renderOutcome('en', f)).toBe('Called the model 1 time(s).')
  })

  it('all skipped → "nothing to do"; some steps but no named effect → step count', () => {
    expect(renderOutcome('en', runFacts(trace([node('a', 'control.if', 'skipped')])))).toBe(
      'Nothing to do this time.'
    )
    expect(
      renderOutcome('en', runFacts(trace([node('a', 'context.history', 'ran'), node('b', 'text.template', 'ran')])))
    ).toBe('Ran 2 step(s).')
  })

  it('failed run with no identifiable failed node falls back to the generic sentence', () => {
    const f = runFacts(trace([node('a', 'control.if', 'skipped')], { ok: false }))
    expect(outcomeSentence(f).key).toBe('runs.outcome.failedGeneric')
    expect(renderOutcome('en', f)).toBe('Something went wrong.')
  })
})

describe('packsWithRuns / filterRuns', () => {
  const records = [
    record({ runId: 'a', seq: 3, packIds: ['mem'] }),
    record({ runId: 'b', seq: 2, packIds: [] }), // narrator turn — contributes no chip
    record({ runId: 'c', seq: 1, packIds: ['mem', 'plot'] })
  ]

  it('lists distinct contributing packs, sorted; narrator-only runs add none', () => {
    expect(packsWithRuns(records)).toEqual(['mem', 'plot'])
  })

  it('filters to a pack (null = All), preserving newest-first order', () => {
    expect(filterRuns(records, null).map((r) => r.runId)).toEqual(['a', 'b', 'c'])
    expect(filterRuns(records, 'plot').map((r) => r.runId)).toEqual(['c'])
    expect(filterRuns(records, 'mem').map((r) => r.runId)).toEqual(['a', 'c'])
  })
})

describe('nextBeforeSeq', () => {
  it('returns the smallest seq in a page; undefined for an empty page', () => {
    expect(nextBeforeSeq([record({ seq: 5 }), record({ seq: 3 }), record({ seq: 4 })])).toBe(3)
    expect(nextBeforeSeq([])).toBeUndefined()
  })
})
