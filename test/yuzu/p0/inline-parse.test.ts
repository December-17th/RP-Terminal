import { describe, it, expect } from 'vitest'
import { parseInlineScene } from '../../../src/shared/yuzu/p0/inlineParse'
import { buildSceneMessagesInline } from '../../../src/shared/yuzu/p0/inlinePrompt'
import { inlineStrategy } from '../../../src/shared/yuzu/p0/pipeline'
import { FailureShape } from '../../../src/shared/yuzu/p0/validate'
import { fixtureContext } from '../../../src/shared/yuzu/p0/fixtureContext'
import {
  runP0Batch,
  type CallProvider,
  type RunRecord
} from '../../../src/shared/yuzu/p0/runP0Batch'
import type { Beat, Scene } from '../../../src/shared/yuzu/p0/sceneDraftSchema'

const ctx = fixtureContext
const parse = (lines: string[]): ReturnType<typeof parseInlineScene> =>
  parseInlineScene(lines.join('\n'), ctx)

/** A complete, in-vocabulary YSS reply that should parse to a valid Scene with no observations. */
const EXAMPLE = [
  '<| bg classroom |>',
  '<| music bgm_main |>',
  '<| kaede worried center enter |>',
  'yuzu: Kaede, wait — can we talk?',
  'kaede: ...I have to get home.',
  'The corridor is silent except for the distant sound of the sea.',
  '<| effect affinity_change kaede +1 |>',
  '<| choice Apologize first :: reconcile |>',
  '<| choice Ask why she left :: confront |>',
  '<| end |>'
]

const okScene = (r: ReturnType<typeof parseInlineScene>): Scene => {
  if (!r.ok) throw new Error(`expected ok, got failures: ${r.failures.join(', ')} (${r.detail})`)
  return r.scene
}
const beatWith = (scene: Scene, pred: (b: Beat) => boolean): Beat | undefined =>
  scene.beats.find(pred)

describe('parseInlineScene — the YSS example', () => {
  it('folds the example into a valid Scene with no observations', () => {
    const r = parse(EXAMPLE)
    const scene = okScene(r)
    expect(r.ok && r.observations).toEqual([])
    expect(scene.header.location).toBe('classroom')
    expect([...scene.header.present].sort()).toEqual(['kaede', 'yuzu'])
    expect(scene.next.choices).toEqual([
      { text: 'Apologize first', intent: 'reconcile' },
      { text: 'Ask why she left', intent: 'confront' }
    ])
    // effect attached to the preceding (narration) beat
    const withEffect = beatWith(scene, (b) => !!b.effects)
    expect(withEffect?.effects?.[0]).toEqual({
      type: 'affinity_change',
      args: { raw: 'kaede +1' }
    })
  })
})

describe('parseInlineScene — each command type', () => {
  it('<| bg |> sets header.location (first wins) and a bg beat', () => {
    const scene = okScene(parse(['<| bg rooftop |>', '<| bg classroom |>', '<| end |>']))
    expect(scene.header.location).toBe('rooftop')
    expect(scene.beats.map((b) => b.bg)).toEqual(['rooftop', 'classroom'])
  })

  it('<| mood |> sets header.mood (last wins), free text', () => {
    const scene = okScene(
      parse(['<| bg classroom |>', '<| mood tense |>', '<| mood tense and quiet |>', '<| end |>'])
    )
    expect(scene.header.mood).toBe('tense and quiet')
  })

  it('<| music/ambience/sfx |> map to the right audio key; "music stop" is a marker', () => {
    const scene = okScene(
      parse([
        '<| bg classroom |>',
        '<| music bgm_main |>',
        '<| ambience amb_school |>',
        '<| sfx sfx_bell |>',
        '<| music stop |>',
        '<| end |>'
      ])
    )
    const audios = scene.beats.filter((b) => b.audio).map((b) => b.audio)
    expect(audios).toEqual([
      { music: 'bgm_main' },
      { ambience: 'amb_school' },
      { sfx: 'sfx_bell' },
      {} // "music stop"
    ])
  })

  it('<| cg |> and <| cg clear |>', () => {
    const scene = okScene(
      parse(['<| bg classroom |>', '<| cg cg_confession |>', '<| cg clear |>', '<| end |>'])
    )
    expect(scene.beats.filter((b) => 'cg' in b).map((b) => b.cg)).toEqual(['cg_confession', null])
  })

  it('<| effect |> attaches to the last beat, capturing args as a raw string', () => {
    const scene = okScene(
      parse(['<| bg classroom |>', '<| effect flag_set talked=true |>', '<| end |>'])
    )
    const bg = beatWith(scene, (b) => b.bg === 'classroom')
    expect(bg?.effects).toEqual([{ type: 'flag_set', args: { raw: 'talked=true' } }])
  })

  it('<| effect |> with no beat yet gets its own beat; no-arg effect omits args', () => {
    const scene = okScene(parse(['<| bg classroom |>', '<| effect item_grant |>', '<| end |>']))
    const eff = beatWith(scene, (b) => !!b.effects)
    expect(eff?.effects).toEqual([{ type: 'item_grant' }])
  })
})

describe('parseInlineScene — dialogue vs narration disambiguation', () => {
  it('"actor: text" is dialogue and adds the speaker to present', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'yuzu: Hello there', '<| end |>']))
    const d = beatWith(scene, (b) => b.speaker === 'yuzu')
    expect(d?.line).toBe('Hello there')
    expect([...scene.header.present]).toContain('yuzu')
  })

  it('"narration: text" is dialogue by the narration speaker', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'narration: The bell rings.', '<| end |>']))
    const d = beatWith(scene, (b) => b.speaker === 'narration' && b.line === 'The bell rings.')
    expect(d).toBeTruthy()
    expect([...scene.header.present]).not.toContain('narration')
  })

  it('"She thought: maybe" is NOT dialogue (unknown speaker) → narration of the whole line', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'She thought: maybe later', '<| end |>']))
    const n = beatWith(scene, (b) => b.speaker === 'narration')
    expect(n?.line).toBe('She thought: maybe later')
  })

  it('a plain prose line is narration', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'Rain streaks the windows.', '<| end |>']))
    expect(beatWith(scene, (b) => b.line === 'Rain streaks the windows.')?.speaker).toBe(
      'narration'
    )
  })
})

describe('parseInlineScene — sprite token auto-classification (order-independent)', () => {
  const spriteOf = (line: string): NonNullable<Beat['sprites']>[number] => {
    const scene = okScene(parse(['<| bg classroom |>', line, '<| end |>']))
    return scene.beats.find((b) => b.sprites)!.sprites![0]
  }

  it('classifies expression / position / action in any order', () => {
    const a = spriteOf('<| kaede enter worried left |>')
    const b = spriteOf('<| kaede left enter worried |>')
    const expected = { actor: 'kaede', expression: 'worried', position: 'left', action: 'enter' }
    expect(a).toEqual(expected)
    expect(b).toEqual(expected)
  })

  it('an actor with no tokens is a bare sprite (not added to present without enter/speak)', () => {
    const scene = okScene(parse(['<| bg classroom |>', '<| yuzu |>', '<| end |>']))
    expect(scene.beats.find((x) => x.sprites)?.sprites?.[0]).toEqual({ actor: 'yuzu' })
    expect([...scene.header.present]).not.toContain('yuzu')
  })

  it('an unclassifiable sprite token rejects the attempt for repair', () => {
    const r = parse(['<| bg classroom |>', '<| kaede grumpy center |>', '<| end |>'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.BAD_SPRITE_TOKEN)
  })
})

describe('parseInlineScene — choices and interaction model', () => {
  it('" :: " splits text/intent; intent defaults to text when absent', () => {
    const scene = okScene(
      parse([
        '<| bg classroom |>',
        '<| choice Say sorry :: apologize |>',
        '<| choice Stay silent |>',
        '<| end |>'
      ])
    )
    expect(scene.next.choices).toEqual([
      { text: 'Say sorry', intent: 'apologize' },
      { text: 'Stay silent', intent: 'Stay silent' }
    ])
  })

  it('no choice lines ⇒ empty choices (free player input, the default)', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'yuzu: What now?', '<| end |>']))
    expect(scene.next.choices).toEqual([])
  })
})

describe('parseInlineScene — observations and malformed output', () => {
  it('strips <think> and records THINK_WRAPPED; scene still valid', () => {
    const r = parse([
      '<think>planning the beat</think>',
      '<| bg classroom |>',
      'yuzu: Hi',
      '<| end |>'
    ])
    okScene(r)
    expect(r.ok && r.observations).toContain(FailureShape.THINK_WRAPPED)
  })

  it('an unknown command rejects the attempt for repair', () => {
    const r = parse(['<| bg classroom |>', '<| teleport now |>', 'yuzu: Hi', '<| end |>'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.UNKNOWN_COMMAND)
  })

  it('unknown asset id rejects the attempt so the pipeline can repair it', () => {
    const r = parse(['<| bg classroom |>', '<| music nonexistent |>', '<| end |>'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.UNKNOWN_ASSET_ID)
  })

  it('disallowed effect rejects the attempt so the pipeline can repair it', () => {
    const r = parse(['<| bg classroom |>', '<| effect teleport x |>', '<| end |>'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.DISALLOWED_EFFECT)
  })

  it('a missing trailing <| end |> rejects the attempt as truncated', () => {
    const truncated = parse(['<| bg classroom |>', 'yuzu: Hi'])
    expect(truncated.ok).toBe(false)
    if (!truncated.ok) expect(truncated.failures).toContain(FailureShape.TRUNCATED)
    const ended = parse(['<| bg classroom |>', 'yuzu: Hi', '<| end |>'])
    expect(ended.ok && ended.observations).not.toContain(FailureShape.TRUNCATED)
  })

  it.each([
    ['<| bg classroom extra |>', FailureShape.UNKNOWN_COMMAND],
    ['<| end extra |>', FailureShape.UNKNOWN_COMMAND],
    ['<| music bgm_main', FailureShape.UNKNOWN_COMMAND],
    ['<| kaede worried smile |>', FailureShape.BAD_SPRITE_TOKEN]
  ])('rejects malformed command %s', (line, failure) => {
    const r = parse(['<| bg classroom |>', line, '<| end |>'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(failure)
  })

  it('a garbled prose reply (no bg) fails validation (missing location) → not ok', () => {
    const r = parse(['I cannot help with that.'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures).toContain(FailureShape.SCHEMA_MISSING_FIELD)
  })
})

describe('inlinePrompt.buildSceneMessagesInline', () => {
  it('teaches the YSS format, the vocabulary, and a lines-only instruction', () => {
    const [system, user] = buildSceneMessagesInline(ctx)
    expect(system.role).toBe('system')
    expect(system.content).toContain('<| bg <location> |>')
    expect(system.content).toContain('<| end |>')
    expect(system.content).toContain('yuzu') // vocabulary
    expect(system.content).toContain('affinity_change') // effect allow-list
    expect(system.content).toMatch(/no json/i)
    expect(user.role).toBe('user')
    expect(user.content).toContain(ctx.seedAction)
  })
})

describe('runP0Batch with inlineStrategy — outcome classification', () => {
  it('drives valid / repaired / fallback and tags records with format:"inline"', async () => {
    const valid = EXAMPLE.join('\n')
    const missingBg = ['yuzu: Kaede, wait.', '<| end |>'].join('\n') // no bg ⇒ invalid location
    const scripts: Record<string, string[]> = {
      clean: [valid],
      repairable: [missingBg, valid], // first invalid, repair valid
      garbage: ['I cannot help with that.', 'still nothing usable'] // both invalid ⇒ fallback
    }
    const counters: Record<string, number> = {}
    const callProvider: CallProvider<{ key: string }, Record<string, never>> = async (settings) => {
      const arr = scripts[settings.key]
      const i = counters[settings.key] ?? 0
      counters[settings.key] = i + 1
      return arr[Math.min(i, arr.length - 1)]
    }

    const { records } = await runP0Batch<{ key: string }, Record<string, never>>({
      ctx,
      runsPerProvider: 1,
      strategy: inlineStrategy,
      callProvider,
      providers: [
        { name: 'clean', model: 'fake', settings: { key: 'clean' }, params: {} },
        { name: 'repairable', model: 'fake', settings: { key: 'repairable' }, params: {} },
        { name: 'garbage', model: 'fake', settings: { key: 'garbage' }, params: {} }
      ]
    })

    const byName = Object.fromEntries(records.map((r: RunRecord) => [r.providerName, r]))
    expect(byName.clean.format).toBe('inline')
    expect(byName.clean.outcome).toBe('valid')
    expect(byName.repairable.outcome).toBe('repaired')
    expect(byName.repairable.attempt1.ok).toBe(false)
    expect(byName.repairable.repair?.ok).toBe(true)
    expect(byName.garbage.outcome).toBe('fallback')
    expect(byName.garbage.fallbackScene?.beats[0].speaker).toBe('narration')
  })
})
