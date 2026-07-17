import { z } from 'zod'

/**
 * Project Yuzu WP-B — the versioned internal scene model (keeper).
 *
 * This is the format-agnostic `Scene` the whole pipeline stores and plays (ADR 0002): a header, an
 * ordered beat sequence, and a next-interaction. The wire format is line-oriented YSS (ADR 0007), but
 * that is a parse concern — this model is what YSS folds INTO and what everything downstream consumes.
 *
 * Asset ids are deliberately plain strings here. Vocabulary membership (is this a real actor / location?)
 * is checked in `sceneValidate.ts`, NOT in the schema, so a SCHEMA failure (wrong shape) stays
 * distinguishable from a VOCAB failure (unknown asset id) in the failure taxonomy.
 *
 * The model carries an explicit `schemaVersion` literal so stored scenes are migratable; the parser and
 * the prose fallback both stamp the current version, and it defaults on parse so callers never trip on it.
 */

/** Bump when the internal `Scene` shape changes in a non-backward-compatible way. */
export const SCENE_SCHEMA_VERSION = 'yuzu-scene-2'

export const SpriteOpSchema = z.object({
  actor: z.string(),
  expression: z.string().optional(),
  position: z.enum(['left', 'center', 'right']).optional(),
  action: z.enum(['enter', 'exit', 'move']).optional()
})
export type SpriteOp = z.infer<typeof SpriteOpSchema>

/**
 * A beat effect is a RAW MVU command string in the classic call dialect (ADR 0008 §4), e.g.
 * `_.set('好感度.kaede', 4, 5) //她笑了`. The string is OPAQUE to shared validation — it is neither
 * parsed nor allow-listed here (there is no effect gate; ADR 0008 §5). The main-side acceptance gate
 * (WP-S) parses it later with `mvuParser`; `src/shared/**` must not import main, so shared keeps it as
 * a plain string.
 */
export const EffectSchema = z.string()
export type Effect = z.infer<typeof EffectSchema>

export const BeatAudioSchema = z.object({
  music: z.string().optional(),
  ambience: z.string().optional(),
  sfx: z.string().optional()
})
export type BeatAudio = z.infer<typeof BeatAudioSchema>

export const BeatSchema = z.object({
  bg: z.string().optional(),
  sprites: z.array(SpriteOpSchema).optional(),
  cg: z.string().nullable().optional(),
  audio: BeatAudioSchema.optional(),
  speaker: z.string().optional(),
  line: z.string().optional(),
  effects: z.array(EffectSchema).optional()
})
export type Beat = z.infer<typeof BeatSchema>

export const ChoiceSchema = z.object({
  text: z.string(),
  intent: z.string()
})
export type Choice = z.infer<typeof ChoiceSchema>

/**
 * Scene end. The player is EITHER presented with a list of choices OR types a free action: a non-empty
 * `choices` list presents those choices; an EMPTY or ABSENT list means the player types their own next
 * action (the default). Choices carry TEXT + INTENT only — never mechanics (affinity deltas, flags,
 * etc.); those live in a beat effect (design §3.4).
 */
export const InteractionSchema = z.object({
  choices: z.array(ChoiceSchema).optional()
})
export type Interaction = z.infer<typeof InteractionSchema>

export const SceneHeaderSchema = z.object({
  location: z.string(),
  present: z.array(z.string()),
  mood: z.string().optional()
})
export type SceneHeader = z.infer<typeof SceneHeaderSchema>

export const SceneSchema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION).default(SCENE_SCHEMA_VERSION),
  scene_id: z.string(),
  header: SceneHeaderSchema,
  beats: z.array(BeatSchema).min(1),
  next: InteractionSchema
})
export type Scene = z.infer<typeof SceneSchema>

/** 'narration' is always a legal speaker even though it is not an actor id. */
export const NARRATION_SPEAKER = 'narration'

/**
 * The manifest-agnostic vocabulary the validator cross-checks a scene against: the set of legal ids per
 * category. WP-A2 will produce one of these from the real project manifest; WP-B depends only on this
 * interface, never on the manifest itself. There is NO effect vocabulary: effects are raw MVU commands
 * (ADR 0008 §4–5), never allow-listed.
 */
export interface SceneVocabulary {
  actors: ReadonlySet<string>
  expressions: ReadonlySet<string>
  locations: ReadonlySet<string>
  cgs: ReadonlySet<string>
  audio: ReadonlySet<string>
}

/** Plain-array shape accepted by {@link createSceneVocabulary}. */
export interface SceneVocabularyInput {
  actors: Iterable<string>
  expressions: Iterable<string>
  locations: Iterable<string>
  cgs: Iterable<string>
  audio: Iterable<string>
}

/** Build a {@link SceneVocabulary} from plain id lists. Pure; does NOT read any manifest (that is WP-A2). */
export const createSceneVocabulary = (input: SceneVocabularyInput): SceneVocabulary => ({
  actors: new Set(input.actors),
  expressions: new Set(input.expressions),
  locations: new Set(input.locations),
  cgs: new Set(input.cgs),
  audio: new Set(input.audio)
})
