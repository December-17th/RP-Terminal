import { describe, it, expect, beforeAll } from 'vitest'
import { buildPrompt } from '../../src/main/services/promptBuilder'
import { createRecordBuilder } from '../../src/main/services/generation/executionRecord'
import { EXECUTION_RECORD_VERSION } from '../../src/shared/executionRecord'
import { RPTerminalCardSchema, LorebookSchema } from '../../src/main/types/character'
import { initTemplates } from '../../src/main/services/templateService'

// --- tiny factories (mirror promptBuilder.test.ts) ------------------------
const card = (data: any = {}): any =>
  RPTerminalCardSchema.parse({ data: { name: 'Aria', ...data } })
const book = (entries: any[]): any => LorebookSchema.parse({ name: 'B', entries })
const blk = (marker: string, content = '', role = 'system'): any => ({
  identifier: marker || 'lit',
  name: marker || 'lit',
  role,
  content,
  enabled: true,
  marker: marker || 'none'
})
const preset = (prompts: any[]): any => ({
  name: 'P',
  parameters: { temperature: 0.9, max_tokens: 100 },
  prompts
})
const floor = (n: number, user: string, resp: string): any => ({
  floor: n,
  chat_id: 'c',
  timestamp: 't',
  user_message: { content: user, timestamp: 't' },
  response: { content: resp, model: '', provider: '' },
  events: [],
  variables: {}
})

/** A rich args bundle that exercises many journal stages: markers, a literal block, top + depth
 *  lore, an @INJECT marker entry, persona safety-net, mode addendum, and a memory tail. */
const richArgs = (journal?: any): any => ({
  card: card({ description: 'A knight.', mes_example: 'ex' }),
  preset: preset([
    blk('char_description'),
    blk('mes_example'),
    blk('world_info'),
    blk('none', 'Literal {{user}} block'),
    blk('chat_history')
  ]),
  lorebooks: [
    book([
      { keys: ['dragon'], content: 'Dragons breathe fire' },
      { keys: ['dragon'], content: 'DEPTH LORE', insertion_depth: 1 },
      { comment: '@INJECT pos=0,role=user', content: 'INJECTED', constant: true }
    ])
  ],
  floors: [floor(0, '', 'greet'), floor(1, 'u1', 'a1')],
  userAction: 'I see a dragon',
  userName: 'Lyra',
  persona: { description: 'a wanderer', inject: true },
  modeAddendum: 'Be terse.',
  memoryBlock: '[Earlier]\n- stuff',
  journal
})

describe('ExecutionRecord — behavior neutrality (the journal never changes the wire)', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('buildPrompt returns byte-identical messages with vs without a journal', () => {
    const baseline = buildPrompt(richArgs())
    const withJournal = buildPrompt(richArgs(createRecordBuilder()))
    // The whole point of issue 07: journaling is additive. Serialize both to prove the wire is
    // identical down to the byte (non-enumerable HISTORY_TAG is skipped by JSON, as intended).
    expect(JSON.stringify(withJournal)).toBe(JSON.stringify(baseline))
  })

  it('a prompt-regex pass is journaled only when it actually changes a turn', () => {
    const rule = {
      id: 'r',
      scriptName: 's',
      source: 'FOO',
      flags: 'g',
      replace: 'BAR',
      placement: [1] as number[],
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      trimStrings: [] as string[]
    }
    const withRegex = buildPrompt({
      card: card(),
      preset: preset([blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, 'I say FOO', 'ok')],
      userAction: 'and FOO again',
      promptRegex: [rule as any]
    })
    const b = createRecordBuilder()
    const withRegexJournaled = buildPrompt({
      card: card(),
      preset: preset([blk('chat_history')]),
      lorebooks: [],
      floors: [floor(0, 'I say FOO', 'ok')],
      userAction: 'and FOO again',
      promptRegex: [rule as any],
      journal: b
    })
    expect(JSON.stringify(withRegexJournaled)).toBe(JSON.stringify(withRegex))
    const rec = b.finish(withRegexJournaled, 0)
    // Two user turns contained FOO (the older turn + the action) → two regex entries.
    const regexEntries = rec.entries.filter((e) => e.stage === 'regex')
    expect(regexEntries.length).toBe(2)
    expect(regexEntries.every((e) => e.before?.kind === 'text' && e.after?.kind === 'text')).toBe(
      true
    )
  })
})

describe('ExecutionRecord — captured stages + shape', () => {
  beforeAll(async () => {
    await initTemplates()
  })

  it('emits ordered entries for the controlled transforms it drove', () => {
    const b = createRecordBuilder()
    const messages = buildPrompt(richArgs(b))
    const rec = b.finish(messages, 3)

    expect(rec.version).toBe(EXECUTION_RECORD_VERSION)
    expect(rec.stats.buildMs).toBe(3)
    expect(rec.stats.entries).toBe(rec.entries.length)
    expect(rec.stats.bytes).toBeGreaterThan(0)
    // seq is a dense 0..n-1 order.
    expect(rec.entries.map((e) => e.seq)).toEqual(rec.entries.map((_, i) => i))
    // The wire mirror is the exact messages.
    expect(rec.wire).toEqual(messages.map((m) => ({ role: m.role, content: m.content })))

    const stages = new Set(rec.entries.map((e) => e.stage))
    // char_description / mes_example / world_info markers.
    expect(stages.has('marker-expand')).toBe(true)
    // the literal `{{user}} block`.
    expect(stages.has('macro')).toBe(true)
    // the depth-1 lore entry.
    expect(stages.has('depth-inject')).toBe(true)
    // the @INJECT marker entry.
    expect(stages.has('marker-inject')).toBe(true)
    // persona net + mode addendum + memory tail.
    expect(stages.has('safety-net')).toBe(true)

    // The literal macro pass expanded {{user}} → Lyra (span lineage kept inline for small text).
    const lit = rec.entries.find((e) => e.stage === 'macro' && e.source.kind === 'preset-block')
    expect(lit?.before).toEqual({ kind: 'text', text: 'Literal {{user}} block' })
    expect(lit?.after).toEqual({ kind: 'text', text: 'Literal Lyra block' })
  })

  it('references bulk content by hash, not by copy (perf)', () => {
    const big = 'X'.repeat(5000)
    const b = createRecordBuilder()
    const messages = buildPrompt({
      card: card(),
      preset: preset([blk('world_info'), blk('chat_history')]),
      lorebooks: [book([{ content: big, constant: true }])],
      floors: [],
      userAction: 'go',
      journal: b
    })
    const rec = b.finish(messages, 0)
    const wi = rec.entries.find((e) => e.stage === 'marker-expand' && e.source.id === 'world_info')
    expect(wi?.after?.kind).toBe('ref')
    if (wi?.after?.kind === 'ref') {
      expect(wi.after.bytes).toBeGreaterThan(5000)
      expect(wi.after.hash).toMatch(/^[0-9a-f]{64}$/) // sha-256 hex
      expect(wi.after).not.toHaveProperty('text') // the 5KB body is NOT copied in
    }
  })
})
