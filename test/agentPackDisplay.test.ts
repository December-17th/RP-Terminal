import { describe, it, expect } from 'vitest'
import {
  attachmentBadges,
  checkpointPhase,
  transformsMainReply,
  packHealth,
  latestRunForPack,
  showsForkOnCard,
  canForkNow,
  displayActiveVersion,
  installedVersions,
  hasMultipleVersions,
  versionMenuItems,
  groupPacksByLineage
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

// ── Fork affordance visibility (WP4.5) ───────────────────────────────────────────────────────────
describe('showsForkOnCard (card Fork affordance visibility)', () => {
  it('built-ins get the card Fork button', () => {
    expect(showsForkOnCard({ builtin: true, manifest: {} })).toBe(true)
  })

  it('plain (non-fork) upstream installs get the card Fork button', () => {
    expect(showsForkOnCard({ builtin: false, manifest: {} })).toBe(true)
    expect(showsForkOnCard({ builtin: false, manifest: { fork: undefined } })).toBe(true)
  })

  it('a card that is already a fork does NOT (it shows Edit/Export; forks-a-fork from the detail)', () => {
    expect(showsForkOnCard({ builtin: false, manifest: { fork: { base: 'X', n: 1 } } })).toBe(false)
  })

  it('a built-in that is somehow also a fork still shows it (built-in dominates the rule)', () => {
    // Defensive: the builtin flag alone qualifies, independent of manifest.fork.
    expect(showsForkOnCard({ builtin: true, manifest: { fork: { base: 'X', n: 1 } } })).toBe(true)
  })
})

describe('canForkNow (fork disabled without a world)', () => {
  it('false without a world (a fork repoints a world’s activation — nothing to write)', () => {
    expect(canForkNow(null)).toBe(false)
  })

  it('true with a world', () => {
    expect(canForkNow('world-1')).toBe(true)
  })
})

// ── Version coexistence (WP4.7) ────────────────────────────────────────────────────────────────────
describe('installedVersions (grouped, ascending, de-duped)', () => {
  it('returns the sorted unique version set', () => {
    expect(installedVersions({ id: 'p', version: 2, versions: [3, 1, 2] })).toEqual([1, 2, 3])
  })

  it('degrades to the row’s own version when the grouped set is absent/empty', () => {
    expect(installedVersions({ id: 'p', version: 4 })).toEqual([4])
    expect(installedVersions({ id: 'p', version: 4, versions: [] })).toEqual([4])
  })
})

describe('displayActiveVersion (pinned else highest)', () => {
  it('uses the pinned active version when present', () => {
    expect(displayActiveVersion({ id: 'p', version: 3, versions: [1, 2, 3], activeVersion: 2 })).toBe(2)
  })

  it('falls back to the HIGHEST installed version when no pin (gate closed / no world)', () => {
    expect(displayActiveVersion({ id: 'p', version: 1, versions: [1, 2, 3] })).toBe(3)
  })

  it('degrades to the row’s own version with no grouped set', () => {
    expect(displayActiveVersion({ id: 'p', version: 5 })).toBe(5)
  })
})

describe('hasMultipleVersions', () => {
  it('true only when >1 version is installed', () => {
    expect(hasMultipleVersions({ id: 'p', version: 1, versions: [1, 2] })).toBe(true)
    expect(hasMultipleVersions({ id: 'p', version: 1, versions: [1] })).toBe(false)
    expect(hasMultipleVersions({ id: 'p', version: 1 })).toBe(false)
  })
})

describe('versionMenuItems (newest-first, active marked)', () => {
  it('lists versions descending, marking the pinned active one', () => {
    expect(
      versionMenuItems({ id: 'p', version: 3, versions: [1, 2, 3], activeVersion: 2 })
    ).toEqual([
      { version: 3, active: false },
      { version: 2, active: true },
      { version: 1, active: false }
    ])
  })

  it('with no pin, the highest is marked active (the fallback that composes)', () => {
    expect(versionMenuItems({ id: 'p', version: 1, versions: [1, 2] })).toEqual([
      { version: 2, active: true },
      { version: 1, active: false }
    ])
  })
})

describe('groupPacksByLineage (one card per id)', () => {
  it('collapses per-(id,version) rows to the active-version representative per id', () => {
    const rows = [
      { id: 'a', version: 1, versions: [1, 2], activeVersion: 1, name: 'a@1' },
      { id: 'a', version: 2, versions: [1, 2], activeVersion: 1, name: 'a@2' },
      { id: 'b', version: 5, versions: [5], name: 'b@5' }
    ]
    const grouped = groupPacksByLineage(rows)
    expect(grouped.map((g) => `${g.id}@${g.version}`)).toEqual(['a@1', 'b@5'])
    // The representative for 'a' is the ACTIVE (pinned) version's row — its name follows.
    expect(grouped[0].name).toBe('a@1')
  })

  it('with no pin, the representative is the highest-version row', () => {
    const rows = [
      { id: 'a', version: 1, versions: [1, 2] },
      { id: 'a', version: 2, versions: [1, 2] }
    ]
    expect(groupPacksByLineage(rows).map((g) => g.version)).toEqual([2])
  })

  it('preserves first-seen id order', () => {
    const rows = [
      { id: 'b', version: 1, versions: [1] },
      { id: 'a', version: 1, versions: [1] }
    ]
    expect(groupPacksByLineage(rows).map((g) => g.id)).toEqual(['b', 'a'])
  })
})
