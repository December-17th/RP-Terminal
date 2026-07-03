import { describe, it, expect } from 'vitest'
import {
  attachmentBadges,
  checkpointPhase,
  transformsMainReply,
  packHealth,
  latestRunForPack
} from '../src/renderer/src/components/workspace/agentPackDisplay'
import { AttachmentDecl } from '../src/shared/workflow/attachments'
import { StoredRunRecord, WorkflowRunTrace } from '../src/shared/workflow/trace'

// Pins the pure display derivations the Agents pack card renders (agent-packs plan WP3.1). The
// codebase has no renderer-component (jsdom) test harness — vitest runs under Node — so per the WP
// the display LOGIC is extracted into agentPackDisplay.ts and covered here directly.

describe('checkpointPhase', () => {
  it('context-ready + prompt-assembly are "before"; reply-parsed + turn-committed are "after"', () => {
    expect(checkpointPhase('context-ready')).toBe('before')
    expect(checkpointPhase('prompt-assembly')).toBe('before')
    expect(checkpointPhase('reply-parsed')).toBe('after')
    expect(checkpointPhase('turn-committed')).toBe('after')
  })
})

describe('attachmentBadges', () => {
  it('maps entries/rejoins to a phase badge and triggers to a headless badge with a caption', () => {
    const atts: AttachmentDecl[] = [
      { kind: 'entry', checkpoint: 'context-ready', mode: 'inline', entryPort: { node: 't', port: 'gen' }, outPort: { node: 't', port: 'gen' } },
      { kind: 'entry', checkpoint: 'turn-committed', mode: 'branch', entryPort: { node: 'g', port: 'floor' } },
      { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'e', port: 'entries' } },
      { kind: 'trigger', trigger: 'state', source: { scope: 'table', table: 'summary', stat: 'unprocessed' }, op: 'gte', value: 6 }
    ]
    expect(attachmentBadges(atts)).toEqual([
      { phase: 'before', kind: 'entry', mode: 'inline' },
      { phase: 'after', kind: 'entry', mode: 'branch' },
      { phase: 'before', kind: 'rejoin' },
      { phase: 'headless', kind: 'trigger', detail: 'state: table summary.unprocessed gte 6' }
    ])
  })

  it('cadence + manual triggers carry describeTrigger captions', () => {
    expect(
      attachmentBadges([{ kind: 'trigger', trigger: 'cadence', everyNFloors: 3 }])[0].detail
    ).toBe('cadence: every 3 floors')
    expect(
      attachmentBadges([{ kind: 'trigger', trigger: 'manual' }])[0].detail
    ).toBe('manual')
  })
})

describe('transformsMainReply (cascade detection, ADR 0002)', () => {
  it('true iff any attachment is an INLINE entry', () => {
    expect(
      transformsMainReply([
        { kind: 'entry', checkpoint: 'context-ready', mode: 'inline', entryPort: { node: 't', port: 'gen' }, outPort: { node: 't', port: 'gen' } }
      ])
    ).toBe(true)
  })

  it('false for branch entries + rejoins + triggers (no main-flow rewrite)', () => {
    expect(
      transformsMainReply([
        { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'x', port: 'gen' } },
        { kind: 'rejoin', checkpoint: 'prompt-assembly', rejoinPort: { node: 'e', port: 'entries' } },
        { kind: 'trigger', trigger: 'manual' }
      ])
    ).toBe(false)
  })
})

// ── Health dot from run records ────────────────────────────────────────────────────────────────────
const traceOf = (ok: boolean): WorkflowRunTrace => ({
  chatId: 'c1',
  workflowId: 'w1',
  startedAt: 0,
  durationMs: 100,
  ok,
  aborted: false,
  nodes: []
})

const record = (seq: number, packIds: string[], ok: boolean): StoredRunRecord => ({
  runId: `r${seq}`,
  seq,
  origin: 'turn',
  packIds,
  trace: traceOf(ok)
})

describe('packHealth + latestRunForPack (newest-first records)', () => {
  it('never ran → "never" when no record is attributed to the pack', () => {
    expect(packHealth([record(3, ['other'], true)], 'pack.a')).toBe('never')
    expect(packHealth([], 'pack.a')).toBe('never')
  })

  it('uses the FIRST attributed record (newest-first) as the last run', () => {
    // records newest-first: seq 3 (ok) is the latest run for pack.a
    const recs = [record(3, ['pack.a'], true), record(2, ['pack.a'], false)]
    expect(latestRunForPack(recs, 'pack.a')?.seq).toBe(3)
    expect(packHealth(recs, 'pack.a')).toBe('ok')
  })

  it('failed last run → "failed"', () => {
    const recs = [record(4, ['pack.a'], false), record(1, ['pack.a'], true)]
    expect(packHealth(recs, 'pack.a')).toBe('failed')
  })
})
