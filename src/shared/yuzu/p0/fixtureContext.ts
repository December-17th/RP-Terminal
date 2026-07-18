/**
 * Project Yuzu WP-P0 — a minimal, hand-written context pack used to drive the scene-generation
 * probe. This is P0 TEST DATA, not the real WP-A3 fixture — keep it tiny and legible. It carries just
 * enough of a "world" (2 actors, a couple of locations, one CG, some audio, an effect allow-list) to
 * exercise the prompt → generate → extract → validate loop against real providers.
 */

/** Category label used in prompt rendering + validation error messages. */
export type AssetCategory = 'actor' | 'expression' | 'location' | 'cg' | 'audio' | 'effect'

export interface P0Context {
  /** 1–2 paragraph setup handed to the model as the world premise. */
  premise: string
  /** Actor ids (also the legal `speaker` / sprite `actor` values, plus 'narration'). */
  actors: string[]
  /** Expression ids valid for any actor's sprite. */
  expressions: string[]
  /** Location ids — double as background (`bg`) ids. */
  locations: string[]
  /** CG (event illustration) ids. */
  cgs: string[]
  /** Audio ids (music / ambience / sfx share one namespace here). */
  audio: string[]
  /** Effect `type`s the model is allowed to emit on a beat. */
  effectAllowList: string[]
  /** The seed "player action" that kicks off the first scene. */
  seedAction: string
}

/** Derived flat vocabulary: the set of valid ids per category + a flat id→category map. */
export interface Vocabulary {
  actors: Set<string>
  expressions: Set<string>
  locations: Set<string>
  cgs: Set<string>
  audio: Set<string>
  effects: Set<string>
  /** Every asset id → its category, for prompt rendering and error messages. */
  categoryOf: Map<string, AssetCategory>
}

/** 'narration' is always a legal speaker even though it is not an actor id. */
export const NARRATION_SPEAKER = 'narration'

export const fixtureContext: P0Context = {
  premise: [
    'Yuzu and Kaede are second-year students at a seaside high school. Yuzu is warm and impulsive;',
    'Kaede is reserved and precise, and has been avoiding Yuzu since an argument last week. It is the',
    'end of the school day, and the corridors are emptying out.',
    '',
    'Today the player, playing as Yuzu, has decided to finally clear the air — cornering Kaede before',
    'she can slip away home.'
  ].join(' '),
  actors: ['yuzu', 'kaede'],
  expressions: ['neutral', 'smile', 'worried'],
  locations: ['classroom', 'rooftop'],
  cgs: ['cg_confession'],
  audio: ['bgm_main', 'amb_school', 'sfx_bell'],
  effectAllowList: ['affinity_change', 'flag_set', 'item_grant'],
  seedAction: 'Yuzu catches Kaede by the sleeve in the empty classroom and asks to talk.'
}

/** Build the flat vocabulary sets + id→category map from a context pack. Pure. */
export const buildVocabulary = (ctx: P0Context): Vocabulary => {
  const categoryOf = new Map<string, AssetCategory>()
  const put = (ids: string[], cat: AssetCategory): Set<string> => {
    const s = new Set(ids)
    for (const id of ids) categoryOf.set(id, cat)
    return s
  }
  // Order matters only for the map's "winning" category on a collision; the fixture keeps ids unique.
  const actors = put(ctx.actors, 'actor')
  const expressions = put(ctx.expressions, 'expression')
  const locations = put(ctx.locations, 'location')
  const cgs = put(ctx.cgs, 'cg')
  const audio = put(ctx.audio, 'audio')
  const effects = put(ctx.effectAllowList, 'effect')
  return { actors, expressions, locations, cgs, audio, effects, categoryOf }
}
