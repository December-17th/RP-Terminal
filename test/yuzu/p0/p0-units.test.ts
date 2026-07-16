import { describe, it, expect } from 'vitest'
import { extractJson, sliceOutermostObject } from '../../../src/shared/yuzu/p0/extractJson'
import {
  FailureShape,
  mapExtractReason,
  observationsFromApplied,
  validateScene
} from '../../../src/shared/yuzu/p0/validate'
import { buildSceneMessages } from '../../../src/shared/yuzu/p0/schemaPrompt'
import { buildRepairMessages } from '../../../src/shared/yuzu/p0/repair'
import { toProseFallbackScene } from '../../../src/shared/yuzu/p0/proseFallback'
import { summarize, formatReadout, type RunRecord } from '../../../src/shared/yuzu/p0/metrics'
import { fixtureContext } from '../../../src/shared/yuzu/p0/fixtureContext'
import { runP0Batch, type CallProvider } from '../../../src/shared/yuzu/p0/runP0Batch'

const ctx = fixtureContext

const validScene = (): Record<string, unknown> => ({
  scene_id: 's1',
  header: { location: 'classroom', present: ['yuzu', 'kaede'] },
  beats: [
    {
      bg: 'classroom',
      sprites: [{ actor: 'kaede', expression: 'smile' }],
      audio: { music: 'bgm_main' },
      speaker: 'yuzu',
      line: 'Hey.',
      effects: [{ type: 'flag_set', args: { flag: 'talked' } }]
    }
  ],
  next: { kind: 'choice', choices: [{ text: 'Smile back', intent: 'warm' }] }
})

describe('extractJson', () => {
  it('parses clean JSON with no transforms', () => {
    const r = extractJson('{"a":1}')
    expect(r).toEqual({ ok: true, value: { a: 1 }, applied: [] })
  })

  it('strips <think> and unwraps a ```json fence, tracking both', () => {
    const r = extractJson('<think>hmm</think>\n```json\n{"a":1}\n```')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.applied).toEqual(['think', 'fence'])
  })

  it('slices an object out of surrounding prose (EXTRA_PROSE)', () => {
    const r = extractJson('Sure! Here you go: {"a":[1,2]} — enjoy.')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ a: [1, 2] })
      expect(r.applied).toContain('slice')
    }
  })

  it('reports EMPTY / NO_JSON / TRUNCATED / PARSE_ERROR reasons, never throwing', () => {
    expect(extractJson('   ')).toMatchObject({ ok: false, reason: 'EMPTY' })
    expect(extractJson('no braces at all')).toMatchObject({ ok: false, reason: 'NO_JSON' })
    expect(extractJson('{"a": 1, "b":')).toMatchObject({ ok: false, reason: 'TRUNCATED' })
    expect(extractJson('prefix {a: 1,,} suffix')).toMatchObject({
      ok: false,
      reason: 'PARSE_ERROR'
    })
  })

  it('sliceOutermostObject honors string literals with braces', () => {
    expect(sliceOutermostObject('x {"s":"}"} y')).toBe('{"s":"}"}')
    expect(sliceOutermostObject('no object')).toBeNull()
    expect(sliceOutermostObject('{ unterminated')).toBeNull()
  })
})

describe('validate — each failure shape', () => {
  it('accepts a well-formed, in-vocabulary scene', () => {
    const r = validateScene(validScene(), ctx)
    expect(r.ok).toBe(true)
  })

  it('SCHEMA_MISSING_FIELD when a required field is absent', () => {
    const bad = validScene()
    delete bad.header
    const r = validateScene(bad, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.SCHEMA_MISSING_FIELD)
  })

  it('SCHEMA_MISSING_FIELD when beats is empty (too_small)', () => {
    const bad = validScene()
    bad.beats = []
    const r = validateScene(bad, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.SCHEMA_MISSING_FIELD)
  })

  it('SCHEMA_WRONG_TYPE when a field has the wrong type', () => {
    const bad = validScene()
    ;(bad.header as Record<string, unknown>).location = 123
    const r = validateScene(bad, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.SCHEMA_WRONG_TYPE)
  })

  it('UNKNOWN_ASSET_ID for an id outside the vocabulary', () => {
    const bad = validScene()
    ;(bad.header as Record<string, unknown>).location = 'library'
    const r = validateScene(bad, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.UNKNOWN_ASSET_ID)
  })

  it('DISALLOWED_EFFECT for an effect type outside the allow-list', () => {
    const bad = validScene()
    ;(bad.beats as Array<Record<string, unknown>>)[0].effects = [{ type: 'teleport' }]
    const r = validateScene(bad, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.DISALLOWED_EFFECT)
  })

  it('BAD_CHOICE_SHAPE when a choice carries mechanics beyond {text,intent}', () => {
    const bad = validScene()
    ;(bad.next as { choices: Array<Record<string, unknown>> }).choices = [
      { text: 'Confess', intent: 'love', affinity: 5 }
    ]
    const r = validateScene(bad, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.BAD_CHOICE_SHAPE)
  })

  it('maps extract reasons and applied observations to failure shapes', () => {
    expect(mapExtractReason('EMPTY')).toBe(FailureShape.EMPTY_OUTPUT)
    expect(mapExtractReason('NO_JSON')).toBe(FailureShape.NO_JSON_FOUND)
    expect(mapExtractReason('TRUNCATED')).toBe(FailureShape.TRUNCATED)
    expect(mapExtractReason('PARSE_ERROR')).toBe(FailureShape.JSON_PARSE_ERROR)
    expect(observationsFromApplied(['think', 'fence', 'slice'])).toEqual([
      FailureShape.THINK_WRAPPED,
      FailureShape.FENCED,
      FailureShape.EXTRA_PROSE
    ])
  })
})

describe('schemaPrompt.buildSceneMessages', () => {
  it('renders vocabulary, allow-list and a strict no-prose instruction', () => {
    const [system, user] = buildSceneMessages(ctx)
    expect(system.role).toBe('system')
    expect(system.content).toContain('yuzu')
    expect(system.content).toContain('classroom')
    expect(system.content).toContain('affinity_change') // effect allow-list
    expect(system.content).toMatch(/ONE JSON object/i)
    expect(system.content).toMatch(/no <think>/i)
    expect(user.role).toBe('user')
    expect(user.content).toContain(ctx.seedAction)
  })
})

describe('repair.buildRepairMessages', () => {
  it('echoes the failed reply and quotes the failure shapes', () => {
    const base = buildSceneMessages(ctx)
    const msgs = buildRepairMessages(
      ctx,
      '{bad}',
      [FailureShape.UNKNOWN_ASSET_ID],
      'unknown location id "library"'
    )
    expect(msgs).toHaveLength(base.length + 2)
    expect(msgs[msgs.length - 2]).toEqual({ role: 'assistant', content: '{bad}' })
    const corrective = msgs[msgs.length - 1]
    expect(corrective.role).toBe('user')
    expect(corrective.content).toContain('UNKNOWN_ASSET_ID')
    expect(corrective.content).toContain('library')
    expect(corrective.content).toMatch(/ONE JSON object/i)
  })
})

describe('proseFallback.toProseFallbackScene', () => {
  it('wraps raw text as a schema-valid narration-only scene', () => {
    const scene = toProseFallbackScene('She said nothing.', ctx)
    expect(scene.beats[0].speaker).toBe('narration')
    expect(scene.beats[0].line).toBe('She said nothing.')
    expect(scene.next).toEqual({ kind: 'continue' })
    // The escape hatch must itself validate cleanly.
    expect(validateScene(scene, ctx).ok).toBe(true)
  })
})

describe('metrics.summarize', () => {
  const att = (ok: boolean, failures: string[], latencyMs: number): RunRecord['attempt1'] => ({
    raw: '',
    latencyMs,
    applied: [],
    ok,
    failures: failures as RunRecord['attempt1']['failures']
  })

  it('counts outcomes, builds the failure histogram across attempts, and computes latency', () => {
    const records: RunRecord[] = [
      {
        ts: 't',
        providerName: 'A',
        model: 'm',
        attempt1: att(true, ['FENCED'], 100),
        outcome: 'valid'
      },
      {
        ts: 't',
        providerName: 'A',
        model: 'm',
        attempt1: att(false, ['UNKNOWN_ASSET_ID'], 200),
        repair: att(true, [], 300),
        outcome: 'repaired'
      },
      {
        ts: 't',
        providerName: 'A',
        model: 'm',
        attempt1: att(false, ['NO_JSON_FOUND'], 400),
        repair: att(false, ['NO_JSON_FOUND'], 500),
        outcome: 'fallback'
      }
    ]
    const readout = summarize(records)
    const p = readout.providers[0]
    expect(p.total).toBe(3)
    expect(p.validFirstTry.n).toBe(1)
    expect(p.repaired.n).toBe(1)
    expect(p.fallback.n).toBe(1)
    expect(p.failureHistogram.NO_JSON_FOUND).toBe(2)
    expect(p.failureHistogram.FENCED).toBe(1)
    expect(p.latency.medianMs).toBe(300) // median of [100,200,300,400,500]
    expect(formatReadout(readout)).toContain('A / m')
  })
})

describe('runP0Batch — provider error path', () => {
  it('classifies a thrown provider call as OTHER and still records a run', async () => {
    const callProvider: CallProvider<{ k: string }, Record<string, never>> = async () => {
      throw new Error('network down')
    }
    const { records } = await runP0Batch({
      ctx,
      runsPerProvider: 1,
      callProvider,
      providers: [{ name: 'boom', model: 'x', settings: { k: 'boom' }, params: {} }]
    })
    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('fallback')
    expect(records[0].attempt1.failures).toContain(FailureShape.OTHER)
  })
})
