import { describe, it, expect } from 'vitest'
import {
  shapePreview,
  packInjections,
  rejoinTexts,
  packRejoinValue,
  type PackInjection,
  type GatedInjector
} from '../../src/main/services/generation/previewSections'
import type { CompositionMeta } from '../../src/shared/workflow/compose'
import type {
  ExecutionRecord,
  RecordContent,
  RecordEntry,
  RecordMessage,
  RecordRole,
  RecordSource
} from '../../src/shared/executionRecord'

// Pins the pure section-shaping the preview service depends on (issue 08 — preview reads the execution
// record). Everything here is import-light + side-effect-free; the SERVICE test
// (test/generation/previewService.test.ts) covers the engine run + record capture, this covers the
// record→sections decomposition + pack attribution in isolation.

const estimate = (s: string): number => s.length

// ── record builders ───────────────────────────────────────────────────────────────────────────────
const text = (s: string): RecordContent => ({ kind: 'text', text: s })
const ref = (s: string): RecordContent => ({ kind: 'ref', hash: 'h', bytes: s.length, preview: s.slice(0, 8) })
const wireMsg = (role: RecordRole, content: string): RecordMessage => ({ role, content })

const rec = (entries: Omit<RecordEntry, 'seq'>[], wire: RecordMessage[] = []): ExecutionRecord => ({
  version: 1,
  createdAt: '2020-01-01T00:00:00.000Z',
  entries: entries.map((e, i) => ({ ...e, seq: i })),
  wire,
  stats: { entries: entries.length, bytes: 0, buildMs: 0 }
})

const marker = (source: RecordSource, after: string, role: RecordRole = 'system'): Omit<RecordEntry, 'seq'> => ({
  stage: 'marker-expand',
  source,
  role,
  after: text(after)
})
const literal = (id: string, after: string): Omit<RecordEntry, 'seq'> => ({
  stage: 'macro',
  source: { kind: 'preset-block', id, label: id },
  before: text(''),
  after: text(after)
})
const safetyNet = (source: RecordSource, after: string): Omit<RecordEntry, 'seq'> => ({
  stage: 'safety-net',
  source,
  at: 0,
  role: 'system',
  after: text(after)
})
const depthInject = (source: RecordSource, after: string): Omit<RecordEntry, 'seq'> => ({
  stage: 'depth-inject',
  source,
  at: 0,
  role: 'system',
  after: text(after),
  note: 'depth 4'
})
/** The bulk chat-history span — hashed in the record, so its per-turn text lives in the wire. */
const historyEntry = (joined: string, turns: number): Omit<RecordEntry, 'seq'> => ({
  stage: 'marker-expand',
  source: { kind: 'history', id: 'chat_history' },
  after: ref(joined),
  note: `${turns} turn(s)`
})
const trimEntry = (note: string): Omit<RecordEntry, 'seq'> => ({
  stage: 'trim',
  source: { kind: 'pipeline', id: 'trim' },
  note
})

describe('rejoinTexts', () => {
  it('block lane: a plain string is one text (empty string → none)', () => {
    expect(rejoinTexts('some memory tail')).toEqual(['some memory tail'])
    expect(rejoinTexts('   ')).toEqual([])
    expect(rejoinTexts('')).toEqual([])
  })
  it('entries lane: LorebookEntry[] → each entry.content', () => {
    const entries = [{ content: 'A' }, { content: '  ' }, { content: 'B' }, { notContent: 1 }]
    expect(rejoinTexts(entries)).toEqual(['A', 'B'])
  })
  it('anything else → none', () => {
    expect(rejoinTexts(undefined)).toEqual([])
    expect(rejoinTexts(42)).toEqual([])
  })
})

describe('packRejoinValue / packInjections', () => {
  const composition: CompositionMeta = {
    packs: {
      'pack.a': {
        nodeIds: ['pack:pack.a:export'],
        entries: [],
        nodeModes: {},
        rejoinEdges: [
          {
            from: { node: 'pack:pack.a:export', port: 'entries' },
            to: { node: 'assemble', port: 'entries' },
            checkpoint: 'prompt-assembly'
          }
        ]
      }
    }
  }

  it('reads the producing node+port value from the outputs map', () => {
    const outputs = new Map<string, Record<string, unknown>>([
      ['pack:pack.a:export', { entries: [{ content: 'MEM' }] }]
    ])
    expect(packRejoinValue(outputs, { node: 'pack:pack.a:export', port: 'entries' })).toEqual([
      { content: 'MEM' }
    ])
  })

  it('produces one PackInjection per prompt-assembly rejoin, carrying the target LANE + texts', () => {
    const outputs = new Map<string, Record<string, unknown>>([
      ['pack:pack.a:export', { entries: [{ content: 'MEM' }] }]
    ])
    const injs = packInjections(composition, outputs, { 'pack.a': 'Pack A' })
    expect(injs).toHaveLength(1)
    expect(injs[0].packId).toBe('pack.a')
    expect(injs[0].name).toBe('Pack A')
    expect(injs[0].to.port).toBe('entries')
    expect(injs[0].texts).toEqual(['MEM'])
  })

  it('ignores rejoins on other checkpoints', () => {
    const comp: CompositionMeta = {
      packs: {
        'pack.b': {
          nodeIds: [],
          entries: [],
          nodeModes: {},
          rejoinEdges: [
            {
              from: { node: 'pack:pack.b:x', port: 'y' },
              to: { node: 'parse', port: 'z' },
              checkpoint: 'reply-parsed'
            }
          ]
        }
      }
    }
    expect(packInjections(comp, new Map(), {})).toEqual([])
  })
})

describe('shapePreview — decomposes the record by real source', () => {
  it('each controlled-transform entry becomes a section attributed to its OWN source', () => {
    const record = rec(
      [
        literal('main', 'You are an expert game master.'),
        marker({ kind: 'card-field', id: 'char_description' }, 'Name: Char\nDescription: a guide'),
        marker({ kind: 'marker', id: 'world_info' }, 'World Info:\nThe kingdom of X'),
        marker({ kind: 'persona', id: 'persona_description' }, 'A curious traveller'),
        historyEntry('U0\nA0', 3),
        safetyNet({ kind: 'memory', id: 'memory-tail' }, 'Recent summary of events.')
      ],
      [wireMsg('user', 'USER_0'), wireMsg('assistant', 'ASSISTANT_0'), wireMsg('user', 'the pending action')]
    )

    const { sections } = shapePreview({ record, injections: [], gatedInjectors: [], estimate })
    // main→system, char→card, world_info→worldInfo, persona→persona, history turns, memory tail, then
    // the action closes the prompt (deferred to last so the memory tail precedes it — wire order).
    expect(sections.map((s) => s.id)).toEqual([
      'system',
      'card',
      'worldInfo',
      'persona',
      'history',
      'history',
      'memory',
      'action'
    ])
    // Attribution is by source identity — no content sniffing. Every non-pack section is narrator.
    expect(sections.every((s) => s.source.kind === 'narrator')).toBe(true)
    // The action is the LAST user turn, from the wire.
    expect(sections.find((s) => s.id === 'action')!.text).toBe('the pending action')
    // History turns carry the wire text (the record hashed the span).
    const hist = sections.filter((s) => s.id === 'history').map((s) => s.text)
    expect(hist).toEqual(['USER_0', 'ASSISTANT_0'])
    // Tokens are estimated per section.
    expect(sections.every((s) => s.estimated)).toBe(true)
    expect(sections[0].tokens).toBe('You are an expert game master.'.length)
  })

  it('a header-less persona marker is persona by SOURCE, not a content/regex guess', () => {
    // The raw description carries no `[Name's Persona]` header — the old shaper needed a regex + a
    // personaText hint to guess it; here the record's `persona` source names it directly.
    const record = rec(
      [
        marker({ kind: 'persona', id: 'persona_description' }, 'A curious traveller'),
        historyEntry('U0', 1)
      ],
      [wireMsg('user', 'the pending action')]
    )
    const { sections } = shapePreview({ record, injections: [], gatedInjectors: [], estimate })
    expect(sections.map((s) => s.id)).toEqual(['persona', 'action'])
    expect(sections[0].source.kind).toBe('narrator')
    expect(sections[0].text).toBe('A curious traveller')
  })

  it('skips an empty literal, and does not double-count a depth-placed literal', () => {
    const record = rec([
      literal('empty_block', ''), // evaluated to nothing → no section
      literal('depth_block', 'A depth-injected instruction.'), // macro entry (raw→rendered) …
      depthInject({ kind: 'preset-block', id: 'depth_block', label: 'depth_block' }, 'A depth-injected instruction.') // … placed here
    ])
    const { sections } = shapePreview({ record, injections: [], gatedInjectors: [], estimate })
    // One section (the depth-inject placement), NOT two, and nothing for the empty block. A depth-placed
    // preset block is a system instruction (world-info depth lore would carry a `lorebook-entry` source).
    expect(sections).toHaveLength(1)
    expect(sections[0].text).toBe('A depth-injected instruction.')
    expect(sections[0].id).toBe('system')
  })

  it('a trim entry is reported as omitted-budget', () => {
    const record = rec(
      [historyEntry('U0', 1), trimEntry('budget 100 tok — dropped 2 oldest turn(s)')],
      [wireMsg('user', 'go')]
    )
    const { omitted } = shapePreview({ record, injections: [], gatedInjectors: [], estimate })
    expect(omitted).toHaveLength(1)
    expect(omitted[0].reason).toBe('budget')
    expect(omitted[0].label).toContain('dropped 2 oldest')
  })
})

describe('shapePreview — pack attribution by construction (lane, not content)', () => {
  const entriesPack = (texts: string[]): PackInjection => ({
    packId: 'pack.mem',
    name: 'Memory',
    checkpoint: 'prompt-assembly',
    from: { node: 'pack:pack.mem:export', port: 'entries' },
    to: { node: 'assemble', port: 'entries' },
    texts
  })

  it('an entries-lane pack re-attributes the top-level World Info section to the pack', () => {
    const record = rec(
      [marker({ kind: 'marker', id: 'world_info' }, 'World Info:\nMEMORY_EXPORT[a;b]')],
      [wireMsg('user', 'go')]
    )
    const { sections, omitted } = shapePreview({
      record,
      injections: [entriesPack(['MEMORY_EXPORT[a;b]'])],
      gatedInjectors: [],
      estimate
    })
    const packSection = sections.find((s) => s.source.kind === 'pack')
    expect(packSection).toBeDefined()
    expect(packSection!.id).toBe('packInject')
    expect(packSection!.source.packId).toBe('pack.mem')
    expect(packSection!.source.name).toBe('Memory')
    expect(packSection!.text).toContain('MEMORY_EXPORT')
    // Attributed (not omitted) — its lane surfaced a section.
    expect(omitted).toEqual([])
  })

  it('a block-lane pack re-attributes the memory-tail section to the pack', () => {
    const record = rec([safetyNet({ kind: 'memory', id: 'memory-tail' }, 'PACK_BLOCK_TAIL')])
    const blockPack: PackInjection = {
      packId: 'pack.blk',
      name: 'Block Pack',
      checkpoint: 'prompt-assembly',
      from: { node: 'pack:pack.blk:x', port: 'block' },
      to: { node: 'assemble', port: 'block' },
      texts: ['PACK_BLOCK_TAIL']
    }
    const { sections } = shapePreview({ record, injections: [blockPack], gatedInjectors: [], estimate })
    const packSection = sections.find((s) => s.source.kind === 'pack')
    expect(packSection).toBeDefined()
    expect(packSection!.source.packId).toBe('pack.blk')
    expect(packSection!.text).toBe('PACK_BLOCK_TAIL')
  })

  it('a pack that produced text but whose lane surfaced no section → omitted-empty', () => {
    // No world_info entry in the record (its block rendered empty), yet the pack claims entries text.
    const record = rec([], [wireMsg('user', 'go')])
    const { sections, omitted } = shapePreview({
      record,
      injections: [entriesPack(['UNPLACED'])],
      gatedInjectors: [],
      estimate
    })
    expect(sections.some((s) => s.source.kind === 'pack')).toBe(false)
    expect(omitted.some((o) => o.reason === 'empty' && o.source?.packId === 'pack.mem')).toBe(true)
  })

  it('a pack whose branch produced NO text → omitted-empty', () => {
    const record = rec([], [wireMsg('user', 'go')])
    const { omitted } = shapePreview({
      record,
      injections: [entriesPack([])],
      gatedInjectors: [],
      estimate
    })
    expect(omitted).toHaveLength(1)
    expect(omitted[0].reason).toBe('empty')
    expect(omitted[0].source?.packId).toBe('pack.mem')
  })

  it('a gate-closed injector → omitted-gate', () => {
    const gatedInjectors: GatedInjector[] = [{ packId: 'pack.off', name: 'Disabled Pack' }]
    const record = rec([], [wireMsg('user', 'go')])
    const { omitted } = shapePreview({ record, injections: [], gatedInjectors, estimate })
    expect(omitted).toHaveLength(1)
    expect(omitted[0].reason).toBe('gate')
    expect(omitted[0].label).toBe('Disabled Pack')
    expect(omitted[0].source?.packId).toBe('pack.off')
  })
})
