import { describe, it, expect } from 'vitest'
import {
  SceneSchema,
  SCENE_SCHEMA_VERSION,
  NARRATION_SPEAKER,
  createSceneVocabulary,
  type Scene,
  type SceneVocabulary
} from '../../src/shared/yuzu/sceneSchema'

/** A minimal, in-vocabulary scene object (without an explicit schemaVersion). */
const baseScene = (): Record<string, unknown> => ({
  scene_id: 's1',
  header: { location: 'classroom', present: ['yuzu'] },
  beats: [{ speaker: 'yuzu', line: 'Hi.' }],
  next: { choices: [] }
})

describe('sceneSchema — versioning', () => {
  it('exposes the version literal', () => {
    expect(SCENE_SCHEMA_VERSION).toBe('yuzu-scene-2')
    expect(NARRATION_SPEAKER).toBe('narration')
  })

  it('defaults schemaVersion when omitted', () => {
    const parsed = SceneSchema.parse(baseScene())
    expect(parsed.schemaVersion).toBe(SCENE_SCHEMA_VERSION)
  })

  it('accepts the correct explicit schemaVersion and rejects a wrong one', () => {
    expect(
      SceneSchema.safeParse({ ...baseScene(), schemaVersion: SCENE_SCHEMA_VERSION }).success
    ).toBe(true)
    const wrong = SceneSchema.safeParse({ ...baseScene(), schemaVersion: 'yuzu-scene-999' })
    expect(wrong.success).toBe(false)
  })

  it('requires at least one beat', () => {
    const parsed = SceneSchema.safeParse({ ...baseScene(), beats: [] })
    expect(parsed.success).toBe(false)
  })

  it('parses a full scene into the typed Scene shape', () => {
    const scene: Scene = SceneSchema.parse(baseScene())
    expect(scene.header.location).toBe('classroom')
    expect(scene.beats).toHaveLength(1)
    expect(scene.next.choices).toEqual([])
  })
})

describe('sceneSchema — createSceneVocabulary', () => {
  it('builds ReadonlySet-backed vocabulary from plain lists (no effect vocabulary)', () => {
    const vocab: SceneVocabulary = createSceneVocabulary({
      actors: ['yuzu', 'kaede'],
      expressions: ['smile'],
      locations: ['classroom'],
      cgs: ['cg_confession'],
      audio: ['bgm_main']
    })
    expect(vocab.actors.has('yuzu')).toBe(true)
    expect(vocab.actors.has('nobody')).toBe(false)
    expect([...vocab.locations]).toEqual(['classroom'])
    // Effects are raw MVU commands (ADR 0008) — there is no effect vocabulary to build.
    expect('effects' in vocab).toBe(false)
  })
})
