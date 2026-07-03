import { describe, it, expect } from 'vitest'
import {
  addsToPrompt,
  hasTriggers,
  explainHeadline,
  triggerLine,
  setupChecklist,
  recentErrors,
  activePackRow,
  type TriggerExplain
} from '../src/renderer/src/components/workspace/agentExplain'
import type { AttachmentDecl } from '../src/shared/workflow/attachments'
import type { StoredRunRecord, WorkflowRunTrace } from '../src/shared/workflow/trace'

// Pure derivations for the Agents "Why?" popover + Overview (agent-packs plan WP3.5). No IPC, no React.

const trace = (over: Partial<WorkflowRunTrace> = {}): WorkflowRunTrace => ({
  chatId: 'c1',
  workflowId: 'headless:p1',
  startedAt: 1_000,
  durationMs: 500,
  ok: true,
  aborted: false,
  nodes: [],
  ...over
})

const rec = (
  over: Partial<StoredRunRecord> & { trace?: Partial<WorkflowRunTrace> } = {}
): StoredRunRecord => ({
  runId: over.runId ?? 'r1',
  seq: over.seq ?? 1,
  origin: over.origin ?? 'headless',
  packIds: over.packIds ?? ['p1'],
  trace: trace(over.trace)
})

const rejoin: AttachmentDecl = { kind: 'rejoin', checkpoint: 'prompt-assembly' }
const trigger: AttachmentDecl = { kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }
const inlineEntry: AttachmentDecl = { kind: 'entry', checkpoint: 'context-ready', mode: 'inline' }

describe('structural predicates', () => {
  it('addsToPrompt is true only with a rejoin', () => {
    expect(addsToPrompt([rejoin])).toBe(true)
    expect(addsToPrompt([inlineEntry, trigger])).toBe(false)
  })
  it('hasTriggers detects a trigger attachment', () => {
    expect(hasTriggers([trigger])).toBe(true)
    expect(hasTriggers([rejoin])).toBe(false)
  })
})

describe('explainHeadline priority', () => {
  const base = {
    packId: 'p1',
    attachments: [trigger] as AttachmentDecl[],
    triggerExplains: [] as TriggerExplain[]
  }

  it('gate closed → disabled (regardless of anything else)', () => {
    expect(explainHeadline({ ...base, open: false, records: [] }).kind).toBe('disabled')
  })

  it('last run failed → failed with the outcome sentence', () => {
    const records = [rec({ trace: { ok: false } })]
    const h = explainHeadline({ ...base, open: true, records })
    expect(h.kind).toBe('failed')
  })

  it('has triggers, none met → waiting', () => {
    const explains: TriggerExplain[] = [
      { description: 'x', kind: 'cadence', met: false, floorsUntilDue: 2 }
    ]
    const h = explainHeadline({ ...base, open: true, records: [], triggerExplains: explains })
    expect(h.kind).toBe('waiting')
  })

  it('ran ok → ranOk with the sentence + timestamp', () => {
    const records = [rec({ trace: { ok: true, startedAt: 42 } })]
    // No triggers so the waiting branch does not pre-empt.
    const h = explainHeadline({
      open: true,
      packId: 'p1',
      attachments: [rejoin],
      records,
      triggerExplains: []
    })
    expect(h.kind).toBe('ranOk')
    if (h.kind === 'ranOk') expect(h.ranAt).toBe(42)
  })

  it('never ran, no triggers, adds nothing → background', () => {
    const h = explainHeadline({
      open: true,
      packId: 'p1',
      attachments: [inlineEntry],
      records: [],
      triggerExplains: []
    })
    expect(h.kind).toBe('background')
  })
})

describe('triggerLine copy', () => {
  it('cadence → floors-until-due (clamped ≥ 0)', () => {
    const l = triggerLine({ description: 'x', kind: 'cadence', met: false, floorsUntilDue: 2 })
    expect(l.key).toBe('agents.why.trigger.cadence')
    expect(l.vars.n).toBe(2)
  })
  it('state point op → current + required', () => {
    const l = triggerLine({ description: 'x', kind: 'state', met: false, current: 3, required: 10 })
    expect(l.key).toBe('agents.why.trigger.state')
    expect(l.vars.current).toBe('3')
    expect(l.vars.required).toBe('10')
  })
  it('changedBy → delta / from / now', () => {
    const l = triggerLine({
      description: 'x',
      kind: 'state',
      met: false,
      baseline: 120,
      current: 135,
      required: 30
    })
    expect(l.key).toBe('agents.why.trigger.changedBy')
    expect(l.vars.delta).toBe('30')
    expect(l.vars.from).toBe('120')
    expect(l.vars.now).toBe('135')
  })
  it('met → the met template', () => {
    const l = triggerLine({ description: 'x', kind: 'cadence', met: true })
    expect(l.key).toBe('agents.why.trigger.met')
    expect(l.met).toBe(true)
  })
})

describe('setupChecklist', () => {
  it('always includes has-world + any-enabled; memory-template only when a memory pack is on', () => {
    const noMem = setupChecklist({
      hasWorld: true,
      anyEnabled: true,
      memoryPackEnabled: false,
      memoryTemplateAssigned: false
    })
    expect(noMem.map((i) => i.id)).toEqual(['has-world', 'any-enabled'])

    const withMem = setupChecklist({
      hasWorld: true,
      anyEnabled: true,
      memoryPackEnabled: true,
      memoryTemplateAssigned: false
    })
    expect(withMem.map((i) => i.id)).toEqual(['has-world', 'any-enabled', 'memory-template'])
    expect(withMem.find((i) => i.id === 'memory-template')?.done).toBe(false)
  })
})

describe('recentErrors', () => {
  it('takes the newest failed runs up to the limit, preserving order', () => {
    const records = [
      rec({ runId: 'a', trace: { ok: true } }),
      rec({ runId: 'b', trace: { ok: false } }),
      rec({ runId: 'c', trace: { ok: false } }),
      rec({ runId: 'd', trace: { ok: false } })
    ]
    const errs = recentErrors(records, 2)
    expect(errs.map((r) => r.runId)).toEqual(['b', 'c'])
  })
})

describe('activePackRow', () => {
  it('is null-sentence when the pack never ran', () => {
    expect(activePackRow([], 'p1').sentence).toBeNull()
  })
  it('carries the last run outcome sentence otherwise', () => {
    const records = [rec({ packIds: ['p1'], trace: { ok: true } })]
    expect(activePackRow(records, 'p1').sentence).not.toBeNull()
  })
})
