import { describe, it, expect } from 'vitest'
import {
  sceneToCommands,
  sceneToCommandStream,
  type StageCommand
} from '../../src/shared/yuzu/stageCommands'
import { parseScene } from '../../src/shared/yuzu/sceneValidate'
import {
  createSceneVocabulary,
  SCENE_SCHEMA_VERSION,
  type Scene,
  type SceneVocabulary
} from '../../src/shared/yuzu/sceneSchema'

// --------------------------------------------------------------------------------------------------
// WP-D1 — Scene → StageCommand derivation.
//
// The golden fixture is the REAL fixture card's opening YSS (test/yuzu/fixture-card/card.json,
// data.extensions.rp_terminal.yuzu.opening), parsed through the real `parseScene` ladder with a
// vocabulary built from the fixture's asset ids (see fixture-card.test.ts assertions for the ids). This
// pins the exact beat → command mapping the future skin protocol depends on.
// --------------------------------------------------------------------------------------------------

/** Vocabulary built from the fixture card's asset ids (actors/expressions/locations/cgs/audio). */
const fixtureVocab: SceneVocabulary = createSceneVocabulary({
  actors: ['yuzu', 'kaede'],
  expressions: ['neutral', 'smile', 'worried'],
  locations: ['classroom', 'rooftop'],
  cgs: ['cg_confession'],
  audio: ['bgm_school']
})

/** The fixture card's hand-authored opening YSS (verbatim from card.json). */
const FIXTURE_OPENING = [
  '<| bg classroom |>',
  '<| music bgm_school |>',
  'The classroom is empty, chalk dust drifting in the late afternoon light.',
  '<| yuzu neutral center enter |>',
  'yuzu: Kaede, wait — can we talk?',
  '<| kaede worried left enter |>',
  'kaede: ...I was about to head home.',
  "<| effect _.set('好感度.kaede', 0, 1) //她停下了脚步 |>",
  'yuzu: Just for a minute. Please.',
  '<| yuzu smile center |>',
  'narration: For a moment, neither of them moves.',
  "<| effect _.set('flags.confessed', false, false) //还没说出口 |>",
  '<| choice Reach out to her :: reach_out |>',
  '<| choice Give her the space she wants :: give_space |>',
  '<| end |>'
].join('\n')

const parseFixture = (): Scene => {
  const r = parseScene(FIXTURE_OPENING, fixtureVocab)
  if (!r.ok)
    throw new Error(`fixture opening failed to parse: ${r.failures.join(', ')} (${r.detail})`)
  return r.scene
}

describe('sceneToCommands — fixture opening golden', () => {
  it('parses the fixture opening into the expected Scene shape', () => {
    const scene = parseFixture()
    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION)
    expect(scene.header.location).toBe('classroom')
    expect(scene.header.present).toEqual(['yuzu', 'kaede'])
    expect(scene.beats).toHaveLength(10)
    expect(scene.next.choices).toHaveLength(2)
    // Effects landed on the scene (they must exist so we can prove they are SKIPPED downstream).
    expect(scene.beats.some((b) => (b.effects?.length ?? 0) > 0)).toBe(true)
  })

  it('derives per-beat groups aligned to the beat cursor (beats.length + 1 groups)', () => {
    const scene = parseFixture()
    const groups = sceneToCommands(scene)
    // 10 beats + 1 trailing interaction group.
    expect(groups).toHaveLength(scene.beats.length + 1)
    // Group 0 opens the scene.
    expect(groups[0][0]).toEqual({
      type: 'scene-begin',
      sceneId: scene.scene_id,
      location: 'classroom',
      present: ['yuzu', 'kaede']
    })
    // Final group presents the interaction, then ends the scene.
    const last = groups[groups.length - 1]
    expect(last[last.length - 1]).toEqual({ type: 'scene-end' })
    expect(last[0].type).toBe('present-interaction')
  })

  it('produces the exact flattened command stream', () => {
    const scene = parseFixture()
    const stream = sceneToCommandStream(scene)
    const expected: StageCommand[] = [
      { type: 'scene-begin', sceneId: 'scene', location: 'classroom', present: ['yuzu', 'kaede'] },
      { type: 'set-backdrop', backdrop: 'classroom', transition: 'fade' },
      { type: 'music-set', track: 'bgm_school' },
      {
        type: 'show-line',
        speaker: 'narration',
        text: 'The classroom is empty, chalk dust drifting in the late afternoon light.',
        kind: 'narration'
      },
      { type: 'sprite-enter', actor: 'yuzu', slot: 'center', expression: 'neutral' },
      { type: 'show-line', speaker: 'yuzu', text: 'Kaede, wait — can we talk?', kind: 'dialogue' },
      { type: 'sprite-enter', actor: 'kaede', slot: 'left', expression: 'worried' },
      {
        type: 'show-line',
        speaker: 'kaede',
        text: '...I was about to head home.',
        kind: 'dialogue'
      },
      { type: 'show-line', speaker: 'yuzu', text: 'Just for a minute. Please.', kind: 'dialogue' },
      { type: 'sprite-update', actor: 'yuzu', expression: 'smile', slot: 'center' },
      {
        type: 'show-line',
        speaker: 'narration',
        text: 'For a moment, neither of them moves.',
        kind: 'narration'
      },
      {
        type: 'present-interaction',
        mode: 'choices',
        choices: [
          { text: 'Reach out to her', intent: 'reach_out' },
          { text: 'Give her the space she wants', intent: 'give_space' }
        ]
      },
      { type: 'scene-end' }
    ]
    expect(stream).toEqual(expected)
  })

  it('SKIPS effects entirely — no MVU command string ever reaches the presentation stream', () => {
    const scene = parseFixture()
    const stream = sceneToCommandStream(scene)
    const serialized = JSON.stringify(stream)
    expect(serialized).not.toContain('_.set')
    expect(serialized).not.toContain('好感度')
    expect(serialized).not.toContain('confessed')
    // And there is no command type that would carry an effect.
    expect(stream.some((c) => (c as { type: string }).type === 'effect')).toBe(false)
  })

  it('is deterministic — the same scene derives an identical stream every call', () => {
    const scene = parseFixture()
    expect(sceneToCommandStream(scene)).toEqual(sceneToCommandStream(scene))
  })
})

// --------------------------------------------------------------------------------------------------
// Direct-Scene derivation edge cases (hand-built scenes exercise the derivation branches parseScene
// does not naturally emit: mood, cg show/clear, ambience, sfx, music-stop, free-input interaction).
// --------------------------------------------------------------------------------------------------

const mkScene = (over: Partial<Scene>): Scene => ({
  schemaVersion: SCENE_SCHEMA_VERSION,
  scene_id: 's',
  header: { location: 'classroom', present: [] },
  beats: [{ speaker: 'narration', line: 'x' }],
  next: { choices: [] },
  ...over
})

describe('sceneToCommands — derivation branches', () => {
  it('emits set-mood after scene-begin when the header carries a mood', () => {
    const scene = mkScene({ header: { location: 'rooftop', present: [], mood: 'tense' } })
    const g0 = sceneToCommands(scene)[0]
    expect(g0[0].type).toBe('scene-begin')
    expect(g0[1]).toEqual({ type: 'set-mood', mood: 'tense' })
  })

  it('emits cg-show for a string cg and cg-clear for a null cg', () => {
    const scene = mkScene({ beats: [{ cg: 'cg_confession' }, { cg: null }] })
    const stream = sceneToCommandStream(scene)
    expect(stream).toContainEqual({ type: 'cg-show', cg: 'cg_confession' })
    expect(stream).toContainEqual({ type: 'cg-clear' })
  })

  it('maps audio channels: music/ambience/sfx set, and an empty audio object to music-stop', () => {
    const scene = mkScene({
      beats: [
        { audio: { music: 'bgm_school' } },
        { audio: { ambience: 'amb' } },
        { audio: { sfx: 'ding' } },
        { audio: {} }
      ]
    })
    const stream = sceneToCommandStream(scene)
    expect(stream).toContainEqual({ type: 'music-set', track: 'bgm_school' })
    expect(stream).toContainEqual({ type: 'ambience-set', loop: 'amb' })
    expect(stream).toContainEqual({ type: 'sfx-fire', sfx: 'ding' })
    expect(stream).toContainEqual({ type: 'music-stop' })
  })

  it('maps sprite actions: enter / exit / move / (no action ⇒ update)', () => {
    const scene = mkScene({
      beats: [
        { sprites: [{ actor: 'yuzu', position: 'center', action: 'enter' }] },
        { sprites: [{ actor: 'yuzu', position: 'left', action: 'move' }] },
        { sprites: [{ actor: 'yuzu', expression: 'smile' }] },
        { sprites: [{ actor: 'yuzu', action: 'exit' }] }
      ]
    })
    const stream = sceneToCommandStream(scene)
    expect(stream).toContainEqual({
      type: 'sprite-enter',
      actor: 'yuzu',
      slot: 'center',
      expression: undefined
    })
    expect(stream).toContainEqual({ type: 'sprite-move', actor: 'yuzu', slot: 'left' })
    expect(stream).toContainEqual({
      type: 'sprite-update',
      actor: 'yuzu',
      expression: 'smile',
      slot: undefined
    })
    expect(stream).toContainEqual({ type: 'sprite-exit', actor: 'yuzu' })
  })

  it('presents free-input when the scene ends with no choices', () => {
    const scene = mkScene({ next: { choices: [] } })
    const stream = sceneToCommandStream(scene)
    expect(stream).toContainEqual({ type: 'present-interaction', mode: 'free-input' })
  })

  it('emits the beat-internal command order backdrop → cg → audio → sprites → line', () => {
    const scene = mkScene({
      beats: [
        {
          bg: 'classroom',
          cg: 'cg_confession',
          audio: { music: 'bgm_school' },
          sprites: [{ actor: 'yuzu', action: 'enter' }],
          speaker: 'yuzu',
          line: 'hi'
        }
      ]
    })
    // Group 0 = scene-begin + the single beat's commands in the fixed order.
    const g0 = sceneToCommands(scene)[0]
    const types = g0.map((c) => c.type)
    expect(types).toEqual([
      'scene-begin',
      'set-backdrop',
      'cg-show',
      'music-set',
      'sprite-enter',
      'show-line'
    ])
  })
})
