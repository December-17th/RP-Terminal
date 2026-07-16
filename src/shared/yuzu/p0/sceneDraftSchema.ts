import { z } from 'zod'

/**
 * Project Yuzu WP-P0 — DRAFT scene schema (throwaway prototype quality).
 *
 * This is the "scene the model must emit" shape the P0 harness validates model replies against. It is
 * deliberately minimal and WILL be redone in WP-B; do not build on it. IDs are plain strings here — we
 * do NOT constrain them to the manifest/allow-list vocabulary in the schema, so a SCHEMA failure (wrong
 * shape) stays distinguishable from a VOCAB failure (unknown asset id / disallowed effect). The vocab
 * cross-check lives in validate.ts.
 */

export const SpriteOpSchema = z.object({
  actor: z.string(),
  expression: z.string().optional(),
  position: z.enum(['left', 'center', 'right']).optional(),
  action: z.enum(['enter', 'exit', 'move']).optional()
})
export type SpriteOp = z.infer<typeof SpriteOpSchema>

export const EffectSchema = z.object({
  type: z.string(),
  args: z.record(z.string(), z.unknown()).optional()
})
export type Effect = z.infer<typeof EffectSchema>

export const BeatAudioSchema = z.object({
  music: z.string().optional(),
  ambience: z.string().optional(),
  sfx: z.string().optional()
})

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
 * action (the default). Choices carry TEXT + INTENT only — never mechanics (no affinity deltas, flags,
 * etc. on a choice); those live in a beat effect.
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
  scene_id: z.string(),
  header: SceneHeaderSchema,
  beats: z.array(BeatSchema).min(1),
  next: InteractionSchema
})
export type Scene = z.infer<typeof SceneSchema>
