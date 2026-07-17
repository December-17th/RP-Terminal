import { describe, it, expect } from 'vitest'
import {
  parseScene,
  validateScene,
  toProseFallbackScene,
  buildRepairMessages,
  FailureShape,
  type ParseResult
} from '../../src/shared/yuzu/sceneValidate'
import {
  createSceneVocabulary,
  SCENE_SCHEMA_VERSION,
  type Beat,
  type Scene,
  type SceneVocabulary
} from '../../src/shared/yuzu/sceneSchema'

// --------------------------------------------------------------------------------------------------
// Fixture vocabulary (hand-built; the WP-A3 synthetic fixture is separate)
// --------------------------------------------------------------------------------------------------

const vocab: SceneVocabulary = createSceneVocabulary({
  actors: ['yuzu', 'kaede'],
  expressions: ['neutral', 'smile', 'worried'],
  locations: ['classroom', 'rooftop'],
  cgs: ['cg_confession'],
  audio: ['bgm_main', 'amb_school', 'sfx_bell'],
  effects: ['affinity_change', 'flag_set', 'item_grant']
})

const parse = (lines: string[]): ParseResult => parseScene(lines.join('\n'), vocab)

const okScene = (r: ParseResult): Scene => {
  if (!r.ok) throw new Error(`expected ok, got failures: ${r.failures.join(', ')} (${r.detail})`)
  return r.scene
}
const beatWith = (scene: Scene, pred: (b: Beat) => boolean): Beat | undefined =>
  scene.beats.find(pred)

/** A complete, in-vocabulary YSS reply that parses to a valid Scene with no observations. */
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

// --------------------------------------------------------------------------------------------------
// Valid parse → validate
// --------------------------------------------------------------------------------------------------

describe('parseScene — the YSS example', () => {
  it('folds the example into a valid Scene with no observations, versioned', () => {
    const r = parse(EXAMPLE)
    const scene = okScene(r)
    expect(r.ok && r.observations).toEqual([])
    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION)
    expect(scene.header.location).toBe('classroom')
    expect([...scene.header.present].sort()).toEqual(['kaede', 'yuzu'])
    expect(scene.next.choices).toEqual([
      { text: 'Apologize first', intent: 'reconcile' },
      { text: 'Ask why she left', intent: 'confront' }
    ])
    const withEffect = beatWith(scene, (b) => !!b.effects)
    expect(withEffect?.effects?.[0]).toEqual({ type: 'affinity_change', args: { raw: 'kaede +1' } })
  })
})

describe('parseScene — each command type', () => {
  it('<| bg |> sets header.location (first wins) and bg beats', () => {
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

  it('<| music/ambience/sfx |> map to the right key; "music stop" is a marker', () => {
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
    expect(scene.beats.filter((b) => b.audio).map((b) => b.audio)).toEqual([
      { music: 'bgm_main' },
      { ambience: 'amb_school' },
      { sfx: 'sfx_bell' },
      {}
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
    expect(beatWith(scene, (b) => b.bg === 'classroom')?.effects).toEqual([
      { type: 'flag_set', args: { raw: 'talked=true' } }
    ])
  })

  it('<| effect |> with no beat yet gets its own beat; no-arg effect omits args', () => {
    const scene = okScene(parse(['<| bg classroom |>', '<| effect item_grant |>', '<| end |>']))
    expect(beatWith(scene, (b) => !!b.effects)?.effects).toEqual([{ type: 'item_grant' }])
  })
})

describe('parseScene — dialogue vs narration disambiguation', () => {
  it('"actor: text" is dialogue and adds the speaker to present', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'yuzu: Hello there', '<| end |>']))
    expect(beatWith(scene, (b) => b.speaker === 'yuzu')?.line).toBe('Hello there')
    expect([...scene.header.present]).toContain('yuzu')
  })

  it('"narration: text" is dialogue by the narration speaker (not added to present)', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'narration: The bell rings.', '<| end |>']))
    expect(
      beatWith(scene, (b) => b.speaker === 'narration' && b.line === 'The bell rings.')
    ).toBeTruthy()
    expect([...scene.header.present]).not.toContain('narration')
  })

  it('"She thought: maybe" is NOT dialogue (unknown speaker) → whole line narration', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'She thought: maybe later', '<| end |>']))
    expect(beatWith(scene, (b) => b.speaker === 'narration')?.line).toBe('She thought: maybe later')
  })

  it('a plain prose line is narration (prose never errors)', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'Rain streaks the windows.', '<| end |>']))
    expect(beatWith(scene, (b) => b.line === 'Rain streaks the windows.')?.speaker).toBe(
      'narration'
    )
  })
})

describe('parseScene — sprite token auto-classification (order-independent)', () => {
  const spriteOf = (line: string): NonNullable<Beat['sprites']>[number] => {
    const scene = okScene(parse(['<| bg classroom |>', line, '<| end |>']))
    return scene.beats.find((b) => b.sprites)!.sprites![0]
  }

  it('classifies expression / position / action in any order', () => {
    const expected = { actor: 'kaede', expression: 'worried', position: 'left', action: 'enter' }
    expect(spriteOf('<| kaede enter worried left |>')).toEqual(expected)
    expect(spriteOf('<| kaede left enter worried |>')).toEqual(expected)
  })

  it('a bare actor sprite is not added to present without enter/speak', () => {
    const scene = okScene(parse(['<| bg classroom |>', '<| yuzu |>', '<| end |>']))
    expect(scene.beats.find((x) => x.sprites)?.sprites?.[0]).toEqual({ actor: 'yuzu' })
    expect([...scene.header.present]).not.toContain('yuzu')
  })
})

describe('parseScene — choices and interaction model', () => {
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

  it('strips a matched surrounding quote pair on choice text (ADR 0007 polish)', () => {
    const scene = okScene(
      parse([
        '<| bg classroom |>',
        '<| choice "Say sorry" :: apologize |>',
        "<| choice 'Stay silent' |>",
        '<| choice “Ask why” :: confront |>',
        '<| end |>'
      ])
    )
    expect(scene.next.choices).toEqual([
      { text: 'Say sorry', intent: 'apologize' },
      { text: 'Stay silent', intent: 'Stay silent' },
      { text: 'Ask why', intent: 'confront' }
    ])
  })

  it('no choice lines ⇒ empty choices (free player input, the default)', () => {
    const scene = okScene(parse(['<| bg classroom |>', 'yuzu: What now?', '<| end |>']))
    expect(scene.next.choices).toEqual([])
  })
})

// --------------------------------------------------------------------------------------------------
// Observations (non-fatal) — one per shape
// --------------------------------------------------------------------------------------------------

describe('parseScene — observations are non-fatal', () => {
  it('THINK_WRAPPED: strips <think> and records it; scene still valid', () => {
    const r = parse([
      '<think>planning the beat</think>',
      '<| bg classroom |>',
      'yuzu: Hi',
      '<| end |>'
    ])
    okScene(r)
    expect(r.ok && r.observations).toContain(FailureShape.THINK_WRAPPED)
  })

  it('UNKNOWN_COMMAND: unknown verb → noted + skipped, rest of scene intact', () => {
    const r = parse(['<| bg classroom |>', '<| teleport now |>', 'yuzu: Hi', '<| end |>'])
    const scene = okScene(r)
    expect(r.ok && r.observations).toContain(FailureShape.UNKNOWN_COMMAND)
    expect(scene.header.location).toBe('classroom')
  })

  it('UNKNOWN_COMMAND: a known verb with an unknown asset id → noted + skipped, scene survives', () => {
    const r = parse(['<| bg classroom |>', '<| music nonexistent |>', '<| end |>'])
    okScene(r)
    expect(r.ok && r.observations).toContain(FailureShape.UNKNOWN_COMMAND)
  })

  it('UNKNOWN_COMMAND: a non-allow-listed effect → noted + skipped, scene survives', () => {
    const r = parse(['<| bg classroom |>', '<| effect teleport x |>', '<| end |>'])
    okScene(r)
    expect(r.ok && r.observations).toContain(FailureShape.UNKNOWN_COMMAND)
  })

  it('BAD_SPRITE_TOKEN: an unclassifiable sprite token → noted, sprite still kept', () => {
    const r = parse(['<| bg classroom |>', '<| kaede grumpy center |>', '<| end |>'])
    const scene = okScene(r)
    expect(r.ok && r.observations).toContain(FailureShape.BAD_SPRITE_TOKEN)
    expect(scene.beats.find((b) => b.sprites)?.sprites?.[0]).toEqual({
      actor: 'kaede',
      position: 'center'
    })
  })

  it('TRUNCATED: missing trailing <| end |> is observed (present ⇒ none)', () => {
    const truncated = parse(['<| bg classroom |>', 'yuzu: Hi'])
    expect(truncated.ok && truncated.observations).toContain(FailureShape.TRUNCATED)
    const ended = parse(['<| bg classroom |>', 'yuzu: Hi', '<| end |>'])
    expect(ended.ok && ended.observations).not.toContain(FailureShape.TRUNCATED)
  })

  it('an observation never appears in a failure list, and vice versa (disjoint groups)', () => {
    const r = parse(['<| bg classroom |>', '<| teleport now |>', 'yuzu: Hi']) // UNKNOWN_COMMAND + TRUNCATED
    const scene = okScene(r)
    expect(scene.header.location).toBe('classroom')
    if (r.ok) {
      expect(r.observations).not.toContain(FailureShape.UNKNOWN_ASSET_ID)
      expect(r.observations).not.toContain(FailureShape.SCHEMA_MISSING_FIELD)
    }
  })
})

// --------------------------------------------------------------------------------------------------
// Scene-level failures (fatal) — one per shape
// --------------------------------------------------------------------------------------------------

const validSceneObject = (): Record<string, unknown> => ({
  scene_id: 's1',
  header: { location: 'classroom', present: [] },
  beats: [{ speaker: 'narration', line: 'A quiet room.' }],
  next: { choices: [] }
})

describe('validateScene — scene-level failures', () => {
  it('accepts a valid object', () => {
    const r = validateScene(validSceneObject(), vocab)
    expect(r.ok).toBe(true)
  })

  it('SCHEMA_MISSING_FIELD: a required field is absent (via parse: no bg ⇒ no location)', () => {
    const r = parse(['I cannot help with that.', '<| end |>'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failures).toContain(FailureShape.SCHEMA_MISSING_FIELD)
      expect(r.detail.length).toBeGreaterThan(0)
    }
  })

  it('SCHEMA_MISSING_FIELD: header.location omitted (via validateScene)', () => {
    const v = validateScene({ ...validSceneObject(), header: { present: [] } }, vocab)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.failures).toContain(FailureShape.SCHEMA_MISSING_FIELD)
  })

  it('SCHEMA_WRONG_TYPE: header.location is the wrong type', () => {
    const v = validateScene(
      { ...validSceneObject(), header: { location: 123, present: [] } },
      vocab
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.failures).toContain(FailureShape.SCHEMA_WRONG_TYPE)
  })

  it('DISALLOWED_EFFECT: an effect type outside the allow-list', () => {
    const v = validateScene(
      {
        ...validSceneObject(),
        beats: [{ speaker: 'narration', line: 'x', effects: [{ type: 'teleport' }] }]
      },
      vocab
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.failures).toContain(FailureShape.DISALLOWED_EFFECT)
  })

  it('BAD_CHOICE_SHAPE: a choice carrying mechanics (extra keys inspected on the raw value)', () => {
    const v = validateScene(
      {
        ...validSceneObject(),
        next: { choices: [{ text: 'Deal', intent: 'accept', affinity: 2 }] }
      },
      vocab
    )
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.failures).toContain(FailureShape.BAD_CHOICE_SHAPE)
      expect(v.detail).toContain('affinity')
    }
  })

  it('BAD_CHOICE_SHAPE: a choice missing intent (zod path includes choices)', () => {
    const v = validateScene({ ...validSceneObject(), next: { choices: [{ text: 'Deal' }] } }, vocab)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.failures).toContain(FailureShape.BAD_CHOICE_SHAPE)
  })

  it('EMPTY_OUTPUT: nothing usable in the model output', () => {
    const empty = parseScene('', vocab)
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.failures).toEqual([FailureShape.EMPTY_OUTPUT])
      expect(empty.detail.length).toBeGreaterThan(0)
    }
    const thinkOnly = parseScene('<think>only reasoning, no scene</think>', vocab)
    expect(thinkOnly.ok).toBe(false)
    if (!thinkOnly.ok) {
      expect(thinkOnly.failures).toContain(FailureShape.EMPTY_OUTPUT)
      expect(thinkOnly.observations).toContain(FailureShape.THINK_WRAPPED)
    }
  })
})

// --------------------------------------------------------------------------------------------------
// UNKNOWN_ASSET_ID is a non-fatal observation (revised ADR 0004 — fuzzy play-time resolution)
// --------------------------------------------------------------------------------------------------

describe('validateScene — unknown asset ids are non-fatal observations', () => {
  it('an unknown location + otherwise-valid scene → VALIDATES, with an UNKNOWN_ASSET_ID observation carrying the id', () => {
    const v = validateScene(
      { ...validSceneObject(), header: { location: 'nowhere', present: [] } },
      vocab
    )
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.observations).toContain(FailureShape.UNKNOWN_ASSET_ID)
      expect(v.detail).toContain('nowhere')
    }
  })

  it('unknown speaker / sprite actor / expression ids also observe, never fail (sprites resolve fuzzily too)', () => {
    const v = validateScene(
      {
        ...validSceneObject(),
        header: { location: 'classroom', present: ['stranger'] },
        beats: [
          { speaker: 'ghost', line: 'boo' },
          { sprites: [{ actor: 'phantom', expression: 'smirk' }] }
        ]
      },
      vocab
    )
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.observations).toEqual([FailureShape.UNKNOWN_ASSET_ID])
      for (const id of ['stranger', 'ghost', 'phantom', 'smirk']) expect(v.detail).toContain(id)
    }
  })

  it('an unknown asset id does NOT trigger the repair ladder (validateScene returns ok, so nothing feeds buildRepairMessages)', () => {
    // A hand-authored / WP-C candidate that names an unknown speaker (the parser folds unknown speakers
    // into narration, so this channel is validateScene, not parseScene). It must be playable: ok === true
    // means there is no `failures` list for the repair loop to send.
    const v = validateScene(
      {
        ...validSceneObject(),
        beats: [{ speaker: 'ghost', line: 'I am not in the cast.' }]
      },
      vocab
    )
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.observations).toContain(FailureShape.UNKNOWN_ASSET_ID)
      expect(v.detail).toContain('ghost')
      expect('failures' in v).toBe(false)
    }
  })

  it('a clean, fully-in-vocabulary scene records NO UNKNOWN_ASSET_ID observation', () => {
    const v = validateScene(validSceneObject(), vocab)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.observations).not.toContain(FailureShape.UNKNOWN_ASSET_ID)
  })
})

// --------------------------------------------------------------------------------------------------
// Prose fallback (the floor)
// --------------------------------------------------------------------------------------------------

describe('toProseFallbackScene', () => {
  it('wraps raw text as a schema-valid narration-only scene, preserving the raw', () => {
    const raw = 'The two of them just stood there, unsure what to say next.'
    const scene = toProseFallbackScene(raw, vocab)
    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION)
    expect(scene.beats[0].speaker).toBe('narration')
    expect(scene.beats[0].line).toBe(raw) // raw preserved verbatim
    expect(scene.header.location).toBe('classroom') // first vocab location
    // schema-valid by construction — re-validating it must pass
    expect(validateScene(scene, vocab).ok).toBe(true)
  })

  it('never throws — even on empty text or an empty-location vocabulary', () => {
    expect(() => toProseFallbackScene('', vocab)).not.toThrow()
    const emptyVocab = createSceneVocabulary({
      actors: [],
      expressions: [],
      locations: [],
      cgs: [],
      audio: [],
      effects: []
    })
    const scene = toProseFallbackScene('anything at all', emptyVocab)
    expect(scene.header.location).toBe('unknown')
  })
})

// --------------------------------------------------------------------------------------------------
// Bounded repair-prompt builder
// --------------------------------------------------------------------------------------------------

describe('buildRepairMessages', () => {
  it('builds a lean corrective: grammar + vocab system turn, prior reply, quoted failures', () => {
    const prior = '<| bg classroom |>\n<| effect teleport now |>\nyuzu: hi'
    const messages = buildRepairMessages({
      priorRaw: prior,
      failures: [FailureShape.DISALLOWED_EFFECT],
      detail: 'disallowed effect type "teleport"',
      vocab
    })
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user'])
    const [system, assistant, user] = messages
    expect(system.content).toContain('<| bg <location> |>') // grammar
    expect(system.content).toContain('<| end |>')
    expect(system.content).toContain('classroom') // vocabulary
    expect(system.content).toContain('affinity_change') // effect allow-list
    expect(assistant.content).toBe(prior) // rejected reply echoed
    expect(user.content).toContain('DISALLOWED_EFFECT')
    expect(user.content).toContain('teleport')
    expect(user.content).toMatch(/no json/i)
  })

  it('does NOT reproduce a generation prompt (no premise / seed-action packing)', () => {
    const messages = buildRepairMessages({ priorRaw: 'x', failures: [], detail: '', vocab })
    const joined = messages
      .map((m) => m.content)
      .join('\n')
      .toLowerCase()
    expect(joined).not.toContain('premise')
    expect(joined).not.toContain('player action to dramatize')
  })
})

// --------------------------------------------------------------------------------------------------
// Acceptance invariants
// --------------------------------------------------------------------------------------------------

describe('acceptance invariants', () => {
  const failingInputs: string[][] = [
    [''], // EMPTY_OUTPUT
    ['I cannot help with that.', '<| end |>'], // SCHEMA_MISSING_FIELD (no bg)
    ['garbled', 'still no bg here'] // SCHEMA_MISSING_FIELD + TRUNCATED
  ]

  it('every parse failure preserves a non-empty detail string and an observations array', () => {
    for (const input of failingInputs) {
      const r = parseScene(input.join('\n'), vocab)
      if (!r.ok) {
        expect(typeof r.detail).toBe('string')
        expect(r.detail.length).toBeGreaterThan(0)
        expect(Array.isArray(r.observations)).toBe(true)
        expect(r.failures.length).toBeGreaterThan(0)
      }
    }
  })

  it('the fallback is always reachable and valid for any raw failing input', () => {
    for (const input of failingInputs) {
      const raw = input.join('\n')
      const r = parseScene(raw, vocab)
      expect(r.ok).toBe(false)
      const fallback = toProseFallbackScene(raw, vocab)
      expect(validateScene(fallback, vocab).ok).toBe(true)
      expect(fallback.beats[0].line).toBe(raw) // raw output preserved on the failure path
    }
  })
})
