import { describe, it, expect } from 'vitest'
import {
  initialStageState,
  stageReducer,
  foldCommands,
  type StageState
} from '../../src/shared/yuzu/stageReducer'
import {
  sceneToCommands,
  sceneToCommandStream,
  type StageCommand
} from '../../src/shared/yuzu/stageCommands'
import { parseScene } from '../../src/shared/yuzu/sceneValidate'
import {
  createSceneVocabulary,
  type Scene,
  type SceneVocabulary
} from '../../src/shared/yuzu/sceneSchema'

// --------------------------------------------------------------------------------------------------
// WP-D1 — the pure stage reducer. Two obligations:
//   (1) every StageCommand variant folds correctly, incl. tolerant edge cases (never throws);
//   (2) reconstruction = fold to a cursor: state at beat N equals the step-by-step fold through beat N,
//       and replay yields an identical state sequence (deterministic playback, ADR 0008 §2.5).
// --------------------------------------------------------------------------------------------------

/** Apply a list of commands from the empty stage. */
const fold = (cmds: StageCommand[]): StageState => cmds.reduce(stageReducer, initialStageState())

describe('stageReducer — per-variant folds', () => {
  it('scene-begin sets the boundary and clears pending interaction', () => {
    const withPending = fold([
      { type: 'present-interaction', mode: 'free-input' },
      { type: 'scene-begin', sceneId: 's1', location: 'classroom', present: ['yuzu'] }
    ])
    expect(withPending.scene).toEqual({
      sceneId: 's1',
      location: 'classroom',
      present: ['yuzu'],
      complete: false
    })
    expect(withPending.interaction).toBeNull()
  })

  it('set-mood / set-backdrop set their fields', () => {
    const s = fold([
      { type: 'set-mood', mood: 'tense' },
      { type: 'set-backdrop', backdrop: 'rooftop', transition: 'fade' }
    ])
    expect(s.mood).toBe('tense')
    expect(s.backdrop).toBe('rooftop')
  })

  it('sprite-enter adds a slot (default center) and preserves insertion order', () => {
    const s = fold([
      { type: 'sprite-enter', actor: 'yuzu', slot: 'center', expression: 'neutral' },
      { type: 'sprite-enter', actor: 'kaede', expression: 'worried' } // no slot ⇒ center
    ])
    expect(s.sprites).toEqual([
      { actor: 'yuzu', position: 'center', expression: 'neutral' },
      { actor: 'kaede', position: 'center', expression: 'worried' }
    ])
  })

  it('sprite-enter on a present actor replaces in place (upsert), keeping order', () => {
    const s = fold([
      { type: 'sprite-enter', actor: 'yuzu', slot: 'left', expression: 'neutral' },
      { type: 'sprite-enter', actor: 'kaede', slot: 'right' },
      { type: 'sprite-enter', actor: 'yuzu', slot: 'center', expression: 'smile' }
    ])
    expect(s.sprites).toEqual([
      { actor: 'yuzu', position: 'center', expression: 'smile' },
      { actor: 'kaede', position: 'right', expression: undefined }
    ])
  })

  it('sprite-update merges onto a present actor, and adds one when absent (implicit show)', () => {
    const present = fold([
      { type: 'sprite-enter', actor: 'yuzu', slot: 'left', expression: 'neutral' },
      { type: 'sprite-update', actor: 'yuzu', expression: 'smile' } // slot kept
    ])
    expect(present.sprites).toEqual([{ actor: 'yuzu', position: 'left', expression: 'smile' }])

    const absent = fold([
      { type: 'sprite-update', actor: 'kaede', slot: 'right', expression: 'worried' }
    ])
    expect(absent.sprites).toEqual([{ actor: 'kaede', position: 'right', expression: 'worried' }])
  })

  it('sprite-move repositions a present actor; move of an absent sprite is a no-op', () => {
    const moved = fold([
      { type: 'sprite-enter', actor: 'yuzu', slot: 'left' },
      { type: 'sprite-move', actor: 'yuzu', slot: 'right' }
    ])
    expect(moved.sprites).toEqual([{ actor: 'yuzu', position: 'right', expression: undefined }])

    const noop = fold([{ type: 'sprite-move', actor: 'ghost', slot: 'center' }])
    expect(noop.sprites).toEqual([])
  })

  it('sprite-exit removes a present actor; exit of an unknown actor is a no-op', () => {
    const removed = fold([
      { type: 'sprite-enter', actor: 'yuzu' },
      { type: 'sprite-enter', actor: 'kaede' },
      { type: 'sprite-exit', actor: 'yuzu' }
    ])
    expect(removed.sprites).toEqual([{ actor: 'kaede', position: 'center', expression: undefined }])

    const noop = fold([
      { type: 'sprite-enter', actor: 'yuzu' },
      { type: 'sprite-exit', actor: 'ghost' }
    ])
    expect(noop.sprites).toEqual([{ actor: 'yuzu', position: 'center', expression: undefined }])
  })

  it('cg-show sets the CG; cg-show over a CG replaces (last wins); cg-clear clears, and clears with none is safe', () => {
    const replaced = fold([
      { type: 'cg-show', cg: 'a' },
      { type: 'cg-show', cg: 'b' }
    ])
    expect(replaced.cg).toBe('b')

    const cleared = fold([{ type: 'cg-show', cg: 'a' }, { type: 'cg-clear' }])
    expect(cleared.cg).toBeNull()

    const clearNone = fold([{ type: 'cg-clear' }])
    expect(clearNone.cg).toBeNull()
  })

  it('music-set replaces the track; music-stop clears; stop with no music is safe', () => {
    const replaced = fold([
      { type: 'music-set', track: 'a' },
      { type: 'music-set', track: 'b' }
    ])
    expect(replaced.music).toBe('b')

    const stopped = fold([{ type: 'music-set', track: 'a' }, { type: 'music-stop' }])
    expect(stopped.music).toBeNull()

    const stopNone = fold([{ type: 'music-stop' }])
    expect(stopNone.music).toBeNull()
  })

  it('ambience-set sets the loop; sfx-fire records the last transient id', () => {
    const s = fold([
      { type: 'ambience-set', loop: 'amb' },
      { type: 'sfx-fire', sfx: 'ding' },
      { type: 'sfx-fire', sfx: 'bell' }
    ])
    expect(s.ambience).toBe('amb')
    expect(s.lastSfx).toBe('bell')
  })

  it('show-line sets the displayed line (dialogue / narration kinds)', () => {
    const dlg = fold([{ type: 'show-line', speaker: 'yuzu', text: 'hi', kind: 'dialogue' }])
    expect(dlg.line).toEqual({ speaker: 'yuzu', text: 'hi', kind: 'dialogue' })

    const narr = fold([
      { type: 'show-line', speaker: 'narration', text: 'It rains.', kind: 'narration' }
    ])
    expect(narr.line).toEqual({ speaker: 'narration', text: 'It rains.', kind: 'narration' })
  })

  it('present-interaction sets the pending prompt; scene-end marks the scene complete', () => {
    const choices = fold([
      { type: 'scene-begin', sceneId: 's', location: 'classroom', present: [] },
      { type: 'present-interaction', mode: 'choices', choices: [{ text: 'go', intent: 'go' }] },
      { type: 'scene-end' }
    ])
    expect(choices.interaction).toEqual({
      type: 'present-interaction',
      mode: 'choices',
      choices: [{ text: 'go', intent: 'go' }]
    })
    expect(choices.scene?.complete).toBe(true)
  })

  it('scene-end before any scene-begin is a benign no-op (scene stays null)', () => {
    expect(fold([{ type: 'scene-end' }]).scene).toBeNull()
  })

  it('never mutates the input state (returns a new object)', () => {
    const before = initialStageState()
    const frozen = Object.freeze({ ...before, sprites: Object.freeze([...before.sprites]) })
    expect(() =>
      stageReducer(frozen as StageState, { type: 'sprite-enter', actor: 'yuzu' })
    ).not.toThrow()
    // Original untouched.
    expect(before.sprites).toEqual([])
  })
})

// --------------------------------------------------------------------------------------------------
// Reconstruction / determinism property over the fixture opening.
// --------------------------------------------------------------------------------------------------

const fixtureVocab: SceneVocabulary = createSceneVocabulary({
  actors: ['yuzu', 'kaede'],
  expressions: ['neutral', 'smile', 'worried'],
  locations: ['classroom', 'rooftop'],
  cgs: ['cg_confession'],
  audio: ['bgm_school']
})

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
  if (!r.ok) throw new Error(`fixture opening failed to parse: ${r.detail}`)
  return r.scene
}

/** State snapshots at every cursor by ONE running fold: index i = state AFTER applying group i. */
const stepwiseByGroup = (groups: StageCommand[][]): StageState[] => {
  const states: StageState[] = []
  let state = initialStageState()
  for (const group of groups) {
    for (const cmd of group) state = stageReducer(state, cmd)
    states.push(state)
  }
  return states
}

/** State at cursor k by an INDEPENDENT fold of the flattened prefix through group k. */
const foldToCursor = (groups: StageCommand[][], k: number): StageState =>
  foldCommands(groups.slice(0, k + 1).flat())

describe('stageReducer — reconstruction = fold-to-cursor', () => {
  it('fold-to-cursor equals the running step-by-step state at every beat', () => {
    const groups = sceneToCommands(parseFixture())
    const running = stepwiseByGroup(groups)
    for (let k = 0; k < groups.length; k++) {
      expect(foldToCursor(groups, k)).toEqual(running[k])
    }
  })

  it('replay is identical — folding the same commands twice yields deep-equal state sequences', () => {
    const groups = sceneToCommands(parseFixture())
    expect(stepwiseByGroup(groups)).toEqual(stepwiseByGroup(groups))
  })

  it('the terminal state = folding the whole stream (pending choices + scene complete)', () => {
    const scene = parseFixture()
    const terminal = foldCommands(sceneToCommandStream(scene))
    expect(terminal.backdrop).toBe('classroom')
    expect(terminal.music).toBe('bgm_school')
    // Both actors are on stage; yuzu's final expression is smile (from the no-action update beat).
    expect(terminal.sprites).toEqual([
      { actor: 'yuzu', position: 'center', expression: 'smile' },
      { actor: 'kaede', position: 'left', expression: 'worried' }
    ])
    expect(terminal.line).toEqual({
      speaker: 'narration',
      text: 'For a moment, neither of them moves.',
      kind: 'narration'
    })
    expect(terminal.interaction).toEqual({
      type: 'present-interaction',
      mode: 'choices',
      choices: [
        { text: 'Reach out to her', intent: 'reach_out' },
        { text: 'Give her the space she wants', intent: 'give_space' }
      ]
    })
    expect(terminal.scene?.complete).toBe(true)
  })

  it('mid-scene cursor does not leak the end state (no spoilers): interaction still null before the last group', () => {
    const groups = sceneToCommands(parseFixture())
    const beforeLast = foldToCursor(groups, groups.length - 2)
    expect(beforeLast.interaction).toBeNull()
    expect(beforeLast.scene?.complete).toBe(false)
  })
})
